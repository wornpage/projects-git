import git from 'isomorphic-git';
import { Volume, createFsFromVolume } from 'memfs';

const zero = '0'.repeat(40);
const oid = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const branchName = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_/-]{0,140}$/.test(value) && !value.includes('//') && !value.endsWith('/');

function remoteUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('.git')) throw new Error('Git requires a credential-free HTTPS repository URL.');
  return url;
}

/** Bounded smart-HTTP transport. Credentials are attached only to these exact repos. */
export function gitHttp(credentials, { fetchImpl = fetch, timeoutMs = 30000, maxBytes = 8388608 } = {}) {
  const allowed = credentials.map(({ remote, token }) => ({ url: remoteUrl(remote), token }));
  const deadline = Date.now() + timeoutMs;
  let received = 0, sent = 0, requests = 0;
  return {
    async request({ url: target, method = 'GET', headers = {}, body }) {
      const url = new URL(target);
      const credential = allowed.find(item => item.url.origin === url.origin &&
        ['info/refs', 'git-upload-pack', 'git-receive-pack'].some(suffix => url.pathname === `${item.url.pathname}/${suffix}`));
      if (!credential || url.username || url.password || url.hash) throw new Error('Git request escaped its assigned repository.');
      if (++requests > 64 || Date.now() >= deadline) throw new Error('Git transport request/time budget exhausted.');
      const chunks = [];
      if (body) for await (const chunk of body) {
        const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
        sent += bytes.byteLength;
        if (sent > maxBytes) throw new Error('Git upload exceeds its byte allowance.');
        chunks.push(bytes);
      }
      const payload = chunks.length ? new Uint8Array(chunks.reduce((sum, part) => sum + part.byteLength, 0)) : undefined;
      if (payload) { let offset = 0; for (const chunk of chunks) { payload.set(chunk, offset); offset += chunk.byteLength; } }
      const auth = new Headers(headers);
      auth.set('Authorization', `Bearer ${credential.token}`);
      const response = await fetchImpl(url, { method, headers: auth, body: payload, redirect: 'manual', signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
      // Workers supports manual redirects; never forward a repo token to Location.
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new Error('Git repository redirects are refused.');
      }
      const data = [];
      if (response.body) {
        const reader = response.body.getReader();
        try {
          while (true) {
            const item = await reader.read();
            if (item.done) break;
            received += item.value.byteLength;
            if (received > maxBytes) throw new Error('Git download exceeds its byte allowance.');
            data.push(item.value);
          }
        } finally { await reader.cancel(); }
      }
      return { url: url.href, method, statusCode: response.status, statusMessage: response.statusText,
        headers: Object.fromEntries(response.headers), body: (async function* () { yield* data; })() };
    },
  };
}

function memoryRepo() {
  const fs = createFsFromVolume(new Volume());
  fs.mkdirSync('/repo');
  return { fs, dir: '/repo' };
}

function assertPush(result, branch) {
  if (!result.ok || !result.refs?.[`refs/heads/${branch}`]?.ok) throw new Error('Git server did not confirm the exact branch update.');
}

export class ArtifactGit {
  constructor({ fetchImpl = fetch } = {}) { this.fetchImpl = fetchImpl; }

  /** A deterministic root commit; the remote branch must still be absent. */
  async seedRepository({ remote, token, name, description, timestamp, beforePush }) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(name) || typeof description !== 'string' || description.length > 500
      || !Number.isSafeInteger(timestamp) || timestamp < 1) throw new Error('Invalid repository seed.');
    const repo = memoryRepo(), branch = 'main';
    const http = gitHttp([{remote, token}], {fetchImpl: this.fetchImpl});
    await git.init({...repo, defaultBranch: branch});
    repo.fs.writeFileSync('/repo/README.md', `# ${name}\n${description ? `\n${description}\n` : ''}`, 'utf8');
    await git.add({...repo, filepath: 'README.md'});
    const author = {name: 'Projects Git', email: 'coordinator@projects.invalid', timestamp, timezoneOffset: 0};
    const headCommit = await git.commit({...repo, message: 'Initialize repository', author, committer: author});
    const result = await git.push({...repo, http, url: remote, ref: branch, remoteRef: branch, force: false,
      onPrePush: async ({localRef, remoteRef}) => {
        if (localRef.oid !== headCommit || remoteRef.oid !== zero) return false;
        // Recheck the retained attempt and caller after remote ref discovery,
        // immediately before the Git write can begin.
        await beforePush(headCommit);
        return true;
      }});
    assertPush(result, branch);
    return headCommit;
  }

  /** Reapply the entire candidate delta, including multi-commit work, on a new base. */
  async reapply({ remote, token, defaultBranch, branch, candidateRemote, candidateToken, candidateBranch, baseCommit, headCommit, currentBase, timestamp = Math.floor(Date.now() / 1000), beforePush }) {
    if (![baseCommit, headCommit, currentBase].every(oid) || ![defaultBranch, branch, candidateBranch].every(branchName)) throw new Error('Invalid base update target.');
    const repo = memoryRepo();
    const http = gitHttp([{ remote, token }, { remote: candidateRemote, token: candidateToken }], { fetchImpl: this.fetchImpl });
    await git.clone({ ...repo, http, url: remote, ref: defaultBranch, singleBranch: true, depth: 1 });
    if (await git.resolveRef({ ...repo, ref: 'HEAD' }) !== currentBase) throw new Error('Project base moved before reapplication.');
    await git.addRemote({ ...repo, remote: 'candidate', url: candidateRemote });
    await git.fetch({ ...repo, http, url: candidateRemote, remote: 'candidate', ref: candidateBranch, singleBranch: true, depth: 256 });
    const fetched = await git.resolveRef({ ...repo, ref: `refs/remotes/candidate/${candidateBranch}` });
    if (fetched !== headCommit || !await git.isDescendent({ ...repo, oid: headCommit, ancestor: baseCommit })) throw new Error('Candidate changed or its original base is unavailable.');
    const candidate = await git.readCommit({ ...repo, oid: headCommit });
    if (!Number.isSafeInteger(timestamp) || timestamp < 1) throw new Error('Invalid reserved commit timestamp.');
    const committer = { name: 'Projects Git base update', email: 'coordinator@projects.invalid', timestamp, timezoneOffset: 0 };
    // A synthetic single-parent commit represents the full old-base -> candidate
    // delta. cherryPick performs a real three-way merge against exactly that base.
    const change = await git.commit({ ...repo, tree: candidate.commit.tree, parent: [baseCommit], noUpdateBranch: true,
      message: `Reapply candidate ${headCommit}\n\nOriginal base: ${baseCommit}`, author: committer, committer });
    let result;
    try { result = await git.cherryPick({ ...repo, oid: change, noUpdateBranch: true, abortOnConflict: true, committer }); }
    catch (error) {
      if (error?.code === 'MergeConflictError') throw Object.assign(new Error('Changes conflict with the current project code. Prepare resolution work.'), { code: 'REBASE_CONFLICT' });
      throw error;
    }
    const newHead = result;
    if (!oid(newHead)) throw new Error('Git did not produce a reapplied commit.');
    const updated = await git.readCommit({ ...repo, oid: newHead });
    if (updated.commit.parent.length !== 1 || updated.commit.parent[0] !== currentBase) throw new Error('Reapplied candidate is not based on current project code.');
    const base = await git.readCommit({ ...repo, oid: currentBase });
    if (updated.commit.tree === base.commit.tree) throw Object.assign(new Error('The candidate changes are already present on this base.'), { code: 'EMPTY_REAPPLICATION' });
    await git.writeRef({ ...repo, ref: `refs/heads/${branch}`, value: newHead });
    await beforePush(newHead);
    const pushed = await git.push({ ...repo, http, url: remote, ref: branch, remoteRef: branch, force: false,
      onPrePush: ({ localRef, remoteRef }) => localRef.oid === newHead && remoteRef.oid === zero });
    assertPush(pushed, branch);
    return newHead;
  }

  async commitCandidate({ remote, token, defaultBranch, branch, baseCommit, files, context, beforePush }) {
    if (!oid(baseCommit) || !branchName(branch) || !branchName(defaultBranch)) throw new Error('Invalid pinned Git base or branch.');
    if (!Array.isArray(files) || files.length !== 1 || files[0].path !== 'checkout.mjs' || typeof files[0].content !== 'string' || new TextEncoder().encode(files[0].content).byteLength > 65536) throw new Error('Hosted edits must stay inside the bounded checkout implementation.');
    const repo = memoryRepo();
    const http = gitHttp([{ remote, token }], { fetchImpl: this.fetchImpl });
    await git.clone({ ...repo, http, url: remote, ref: defaultBranch, singleBranch: true, depth: 1 });
    if (await git.resolveRef({ ...repo, ref: 'HEAD' }) !== baseCommit) throw new Error('The fork base changed before the candidate commit.');
    await git.branch({ ...repo, ref: branch, checkout: true });
    repo.fs.writeFileSync('/repo/checkout.mjs', files[0].content, 'utf8');
    await git.add({ ...repo, filepath: 'checkout.mjs' });
    const headCommit = await git.commit({ ...repo, message: `Implement task ${context.taskId} revision ${context.revision}\n\nRun: ${context.runId}`, author: { name: 'Projects Git agent', email: 'agent@projects.invalid' } });
    await beforePush(headCommit);
    const result = await git.push({ ...repo, http, url: remote, ref: branch, remoteRef: branch, force: false,
      onPrePush: ({ localRef, remoteRef }) => localRef.oid === headCommit && remoteRef.oid === zero });
    assertPush(result, branch);
    return headCommit;
  }

  async merge({ remote, token, defaultBranch, candidateRemote, candidateToken, candidateBranch, baseCommit, headCommit, beforePush }) {
    if (!oid(baseCommit) || !oid(headCommit) || !branchName(defaultBranch) || !branchName(candidateBranch)) throw new Error('Invalid exact merge target.');
    const repo = memoryRepo();
    const http = gitHttp([{ remote, token }, { remote: candidateRemote, token: candidateToken }], { fetchImpl: this.fetchImpl });
    await git.clone({ ...repo, http, url: remote, ref: defaultBranch, singleBranch: true, depth: 1 });
    if (await git.resolveRef({ ...repo, ref: 'HEAD' }) !== baseCommit) throw new Error('Target branch no longer matches the reviewed base.');
    await git.addRemote({ ...repo, remote: 'candidate', url: candidateRemote });
    await git.fetch({ ...repo, http, url: candidateRemote, remote: 'candidate', ref: candidateBranch, singleBranch: true });
    const fetched = await git.resolveRef({ ...repo, ref: `refs/remotes/candidate/${candidateBranch}` });
    if (fetched !== headCommit || !await git.isDescendent({ ...repo, oid: headCommit, ancestor: baseCommit })) throw new Error('Candidate is stale or does not descend from the pinned base.');
    await git.writeRef({ ...repo, ref: 'refs/heads/accepted', value: headCommit });
    await beforePush();
    const result = await git.push({ ...repo, http, url: remote, ref: 'accepted', remoteRef: defaultBranch, force: false,
      onPrePush: ({ localRef, remoteRef }) => localRef.oid === headCommit && remoteRef.oid === baseCommit });
    assertPush(result, defaultBranch);
    return headCommit;
  }
}
