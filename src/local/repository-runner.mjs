import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile, realpath, rename, lstat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { readOnlyGit, committedChange } from './git-reader.mjs';
import { readSnapshotEntries } from './git-snapshot.mjs';
import { verifyRepositoryCandidate } from './repository-checks.mjs';
import { readCheckDefinition, digest, requirementsDigest } from '../core/check-definition.mjs';
import { validateCommit, WorkflowError } from '../core/workflow.mjs';
import { buildTaskHandoff } from '../core/handoff.mjs';
import { mergeEvidenceChanged } from '../core/merge-lifecycle.mjs';

const idPattern = /^[a-f0-9-]{36}$/;
const refuse = message => { throw new WorkflowError('repository_refused', message); };

/** Only the coordinator's newly created repositories may receive Git writes. */
export class RepositoryRunner {
  constructor(root) { this.root = path.resolve(root); }

  async initialize() {
    await mkdir(this.root, { recursive: true });
    if (await realpath(this.root) !== this.root) refuse('Connected repository storage must not be redirected.');
    this.hooks = path.join(this.root, '.empty-hooks');
    await mkdir(this.hooks, { recursive: true });
    if (await realpath(this.hooks) !== this.hooks) refuse('Hooks directory must not be redirected.');
  }

  async directory(taskId, runId = null) {
    if (!idPattern.test(taskId) || runId !== null && !idPattern.test(runId)) refuse('Invalid task or candidate ID.');
    const target = path.join(this.root, taskId, runId ?? 'repository.git');
    // Check every existing ancestor; new paths are created only below this root.
    let existing = target;
    while (existing !== this.root) {
      try { if (await realpath(existing) !== existing) refuse('Repository storage was redirected.'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      existing = path.dirname(existing);
    }
    if (await realpath(this.root) !== this.root) refuse('Repository root changed.');
    return target;
  }

  async git(directory, args, input, allowedExitCodes = [], {binary = false, maxBuffer = 2 * 1024 * 1024} = {}) {
    if (directory !== this.root && !directory.startsWith(this.root + path.sep)) refuse('Git writes must stay in connected repository storage.');
    if (typeof binary !== 'boolean' || !Number.isSafeInteger(maxBuffer) || maxBuffer < 1 || maxBuffer > 64 * 1024 * 1024) refuse('Git output needs a bounded byte allowance.');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|COMSPEC)$/i.test(key)));
    Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1' });
    return new Promise((resolve, reject) => {
      const child = execFile('git', ['--no-pager', '-c', `core.hooksPath=${this.hooks}`, '-c', 'core.autocrlf=false', ...args],
        { cwd: directory, env, windowsHide: true, timeout: 30000, maxBuffer, encoding: binary ? 'buffer' : 'utf8' }, (error, stdout) => {
          if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') reject(new WorkflowError('repository_git_failed', `Git ${args[0]} exceeded its output byte allowance.`, 409));
          else if (error && !allowedExitCodes.includes(error.code)) reject(new WorkflowError('repository_git_failed', `Git ${args[0]} failed in the owned repository; inspect its retained state.`, 409));
          else if (allowedExitCodes.length) resolve({ exitCode: error?.code ?? 0, stdout });
          else resolve(binary ? stdout : stdout.trim());
        });
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    });
  }

  async copyCommit(source, destination, commit, { boundary = null, progress = () => {}, objectBudget } = {}) {
    if (objectBudget && (!Number.isSafeInteger(objectBudget.remainingBytes) || objectBudget.remainingBytes < 0
      || !Number.isSafeInteger(objectBudget.remainingObjects) || objectBudget.remainingObjects < 0 || !(objectBudget.seen instanceof Set))) refuse('Invalid aggregate Git object budget.');
    const git = readOnlyGit(source);
    const pending = [commit], seen = new Set(), objects = new Map();
    const deadline = Date.now() + 60000;
    progress({ phase: 'Inspecting the selected commit', completed: 0, total: null });
      while (pending.length) {
        if (Date.now() > deadline) refuse('Repository object capture exceeded its one-minute allowance.');
        const head = pending.pop();
        if (head === boundary || seen.has(head)) continue;
        if (seen.size >= 32) refuse('A submission may add at most 32 commits above its assigned base.');
        seen.add(head);
        // Share the verifier's portable path and 8 MiB/256-file validation.
        await readSnapshotEntries(source, head);
        const bytes = await git(['cat-file', 'commit', head], { binary: true });
        const header = bytes.toString('utf8').split('\n\n')[0];
        const tree = validateCommit(/^tree ([a-f0-9]+)$/m.exec(header)?.[1]);
        const listing = await git(['ls-tree', '-r', '-t', '-z', head]);
        objects.set(head, { type: 'commit', bytes });
        objects.set(tree, { type: 'tree' });
        for (const line of listing.split('\0').filter(Boolean)) {
          const match = /^[0-7]{6} (tree|blob) ([a-f0-9]+)\t/.exec(line);
          if (!match) refuse('Only regular blobs and trees are supported.');
          if (!objects.has(match[2])) objects.set(match[2], { type: match[1] });
        }
        if (boundary) for (const match of header.matchAll(/^parent ([a-f0-9]+)$/gm)) pending.push(validateCommit(match[1]));
      }
      if (objects.size > 4096) refuse('Submission exceeds the 4096-object allowance.');
      progress({ phase: 'Reading Git objects', completed: 0, total: objects.size });
      const batch = await git(['cat-file', '--batch'], { binary: true, input: [...objects.keys()].join('\n') + '\n', maxBuffer: 33 * 1024 * 1024 });
      let offset = 0, total = 0, completed = 0;
      for (const [oid, object] of objects) {
        if (Date.now() > deadline) refuse('Repository object capture exceeded its one-minute allowance.');
        const end = batch.indexOf(10, offset);
        const header = batch.subarray(offset, end).toString('ascii');
        const match = /^([a-f0-9]+) (commit|tree|blob) ([0-9]+)$/.exec(header);
        if (end < 0 || !match || match[1] !== oid || match[2] !== object.type) refuse('Git returned an unexpected object batch.');
        const size = Number(match[3]); offset = end + 1;
        if (!Number.isSafeInteger(size) || size < 0 || offset + size >= batch.length || batch[offset + size] !== 10) refuse('Git returned an incomplete object batch.');
        const bytes = batch.subarray(offset, offset + size); offset += size + 1;
        total += bytes.length;
        if (total > 32 * 1024 * 1024) refuse('Submission objects exceed the 32 MiB allowance.');
        const loose = Buffer.concat([Buffer.from(`${object.type} ${bytes.length}\0`), bytes]);
        if (createHash(oid.length === 40 ? 'sha1' : 'sha256').update(loose).digest('hex') !== oid) refuse('Object identity changed during capture.');
        const compressed = deflateSync(loose);
        if (objectBudget && !objectBudget.seen.has(oid)) {
          const charge = Math.max(loose.length, compressed.length);
          if (charge > objectBudget.remainingBytes || objectBudget.remainingObjects === 0) refuse('Project objects exceed the aggregate byte or object-count allowance.');
          objectBudget.remainingBytes -= charge; objectBudget.remainingObjects--; objectBudget.seen.add(oid);
        }
        const directory = path.join(destination, 'objects', oid.slice(0, 2));
        await mkdir(directory, { recursive: true });
        if (await realpath(directory) !== directory) refuse('Git object storage was redirected.');
        const file = path.join(directory, oid.slice(2));
        try { await writeFile(file, compressed, { flag: 'wx', mode: 0o600 }); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          const stat = await lstat(file);
          if (!stat.isFile() || stat.isSymbolicLink() || !inflateSync(await readFile(file)).equals(loose)) refuse('An existing Git object does not match its identity.');
        }
        progress({ phase: 'Copying Git objects', completed: ++completed, total: objects.size });
      }
      if (offset !== batch.length) refuse('Git object batch contained unexpected trailing data.');
  }

  async connect(task, source, progress = () => {}) {
    let canonical, format;
    try {
      if (typeof source !== 'string' || !path.isAbsolute(source)) throw new Error();
      canonical = await realpath(source);
      const git = readOnlyGit(canonical);
      if ((await git(['rev-parse', '--verify', `${task.baseCommit}^{commit}`])).trim() !== task.baseCommit) throw new Error();
      format = (await git(['rev-parse', '--show-object-format'])).trim();
      if (!['sha1', 'sha256'].includes(format)) throw new Error();
    } catch { throw new WorkflowError('invalid_repository_source', 'Use an existing absolute Git repository path and a full commit ID present in that repository.', 422); }
    const repository = await this.directory(task.projectId ?? task.id);
    await mkdir(path.dirname(repository));
    await mkdir(repository);
    await this.git(repository, ['init', '--bare', '--initial-branch=main', `--object-format=${format}`]);
    await this.copyCommit(canonical, repository, task.baseCommit, { progress });
    // Import only the selected baseline, without copying the source's refs/config/history.
    await writeFile(path.join(repository, 'shallow'), task.baseCommit + '\n', { flag: 'wx' });
    await this.git(repository, ['update-ref', 'refs/heads/main', task.baseCommit, '0'.repeat(task.baseCommit.length)]);
    progress({ phase: 'Repository ready', completed: 1, total: 1 });
    return { repository, repositoryKey: `connected:${digest(canonical.toLowerCase())}` };
  }

  async assign(task, run) {
    const repository = await this.directory(task.projectId ?? task.id), checkout = await this.directory(task.projectId ?? task.id, run.id);
    if (await this.git(repository, ['rev-parse', 'refs/heads/main']) !== task.baseCommit) refuse('The task base moved before assignment.');
    await this.git(path.dirname(repository), ['clone', '--no-local', '--no-checkout', repository, checkout]);
    await this.git(checkout, ['checkout', '-b', run.branch, task.baseCommit]);
    return { checkout, branch: run.branch, baseCommit: task.baseCommit };
  }

  async publicationSource(task, run) {
    const repository = await this.directory(task.projectId ?? task.id);
    if (await this.git(repository, ['rev-parse', `refs/candidates/${run.id}`]) !== run.headCommit) refuse('The retained candidate ref changed before publication.');
    const change = await committedChange(readOnlyGit(repository), run.baseCommit, run.headCommit);
    if (change.diff !== run.diff || JSON.stringify(change.changedFiles) !== JSON.stringify(run.changedFiles)) refuse('The retained source does not match the approved candidate.');
    return repository;
  }

  async recoverAssignment(task, run) {
    const checkout = await this.directory(task.projectId, run.id);
    try {
      if (await this.git(checkout, ['rev-parse', '--show-toplevel']) !== checkout.replaceAll('\\', '/')
        || await this.git(checkout, ['symbolic-ref', '--short', 'HEAD']) !== run.branch
        || await this.git(checkout, ['rev-parse', 'HEAD']) !== run.baseCommit) return null;
      return checkout;
    } catch { return null; }
  }

  async main(task) { return this.git(await this.directory(task.projectId ?? task.id), ['rev-parse', 'refs/heads/main']); }

  async capture(task, run, source, headCommit) {
    const repository = await this.directory(task.projectId);
    await this.copyCommit(source, repository, headCommit, { boundary: run.baseCommit });
    await this.git(repository, ['update-ref', `refs/candidates/${run.id}`, headCommit]);
  }

  async reapply(task, run, baseCommit) {
    const repository = await this.directory(task.projectId);
    if (await this.main(task) !== baseCommit) refuse('Project main changed. Refresh before updating this candidate.');
    const merge = await this.git(repository, ['merge-tree', '--write-tree', '--name-only', '-z', '--merge-base=' + task.baseCommit, baseCommit, run.headCommit], undefined, [1]);
    if (merge.exitCode === 1) throw new WorkflowError('base_update_conflict', 'These changes conflict with project main. Prepare a resolution checkout to carry the original change forward.', 409);
    const tree = validateCommit(merge.stdout.split('\0')[0]);
    const headCommit = await this.git(repository, ['-c', 'user.name=Projects base update', '-c', 'user.email=base-update@localhost.invalid', 'commit-tree', tree, '-p', baseCommit], `Reapply ${run.headCommit} to project main\n`);
    return { ...await committedChange(readOnlyGit(repository), baseCommit, headCommit), headCommit,
      summary: `Reapplied candidate ${run.headCommit} onto project main ${baseCommit}. New verification and review required.` };
  }

  async retainCandidate(task, run, previous) {
    await this.git(await this.directory(task.projectId), ['update-ref', `refs/candidates/${run.id}`, run.headCommit]);
    // Carry the declared checks forward, never their result or human decision.
    try {
      const policy = JSON.parse(await readFile(await this.policyPath(task, previous), 'utf8'));
      const plan = JSON.parse(policy.definition);
      Object.assign(plan, { commit: run.headCommit, taskRevision: task.revision, requirementsSha256: requirementsDigest(task) });
      policy.definition = JSON.stringify(plan); policy.definitionSha256 = digest(policy.definition);
      readCheckDefinition(Buffer.from(policy.definition), policy.definitionSha256, task, run);
      await writeFile(await this.policyPath(task, run), JSON.stringify(policy), { flag: 'wx', mode: 0o600 });
      return true;
    } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }

  async syncStarter(task, source, headCommit) {
    const repository = await this.directory(task.projectId);
    const main = await this.main(task);
    if (main === headCommit) return;
    if (main !== task.baseCommit) refuse('Project main moved before the starter result could be merged.');
    await this.copyCommit(source, repository, headCommit, { boundary: task.baseCommit });
    await this.git(repository, ['update-ref', 'refs/heads/main', headCommit, task.baseCommit]);
  }

  async submit(task, run, headCommit) {
    validateCommit(headCommit);
    const checkout = await this.directory(task.projectId ?? task.id, run.id), repository = await this.directory(task.projectId ?? task.id);
    const git = readOnlyGit(checkout);
    if ((await git(['rev-parse', '--verify', `refs/heads/${run.branch}`])).trim() !== headCommit) refuse('Submit the current commit on the assigned branch.');
    const change = await committedChange(git, task.baseCommit, headCommit);
    await this.copyCommit(checkout, repository, headCommit, { boundary: task.baseCommit });
    await this.git(repository, ['update-ref', `refs/candidates/${run.id}`, headCommit]);
    if ((await git(['rev-parse', '--verify', `refs/heads/${run.branch}`])).trim() !== headCommit) refuse('The candidate moved during submission. Submit its stable current head.');
    return { ...change, headCommit };
  }

  async policyPath(task, run) { return path.join(path.dirname(await this.directory(task.projectId ?? task.id)), `${run.id}.checks.json`); }

  async verify(state, task, run, input = null) {
    const policyFile = await this.policyPath(task, run);
    let policy;
    if (input) {
      policy = { definition: input.definition, definitionSha256: input.definitionSha256, image: input.image };
      if (typeof policy.definition !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(policy.image)) refuse('Provide a check definition and an installed immutable Docker image ID.');
    } else {
      try { policy = JSON.parse(await readFile(policyFile, 'utf8')); }
      catch { refuse('Pin a trusted check definition for this candidate with the repository CLI before verifying or merging.'); }
    }
    const definitionBytes = Buffer.from(policy.definition, 'utf8');
    try { readCheckDefinition(definitionBytes, policy.definitionSha256, task, run); }
    catch (error) { throw new WorkflowError('check_definition_invalid', error.message, 422); }
    const handoff = await buildTaskHandoff(state, task.id);
    const evidence = await verifyRepositoryCandidate({ repo: await this.directory(task.projectId ?? task.id), task, run, definitionBytes,
      definitionSha256: policy.definitionSha256, image: policy.image, inputHandoffSha256: handoff.sha256 });
    if (input) {
      const temporary = `${policyFile}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(policy), { flag: 'wx', mode: 0o600 });
      await rename(temporary, policyFile);
    }
    return evidence;
  }

  async verifyMerge(state, task, run) {
    const repository = await this.directory(task.projectId ?? task.id);
    const head = await this.git(repository, ['rev-parse', 'refs/heads/main']);
    if (head !== task.baseCommit) refuse('The owned main branch moved after review. Reconcile its exact head before another merge attempt.');
    const evidence = await this.verify(state, task, run);
    if (await this.git(repository, ['rev-parse', `refs/candidates/${run.id}`]) !== run.headCommit) refuse('The retained candidate ref changed after review.');
    return { evidence,
      failed: !evidence.verified || evidence.passed !== evidence.total || evidence.exitCode !== 0,
      changed: mergeEvidenceChanged(run.evidence, evidence, task.verificationProfile ?? (task.origin === 'connected-git' ? 'commands' : 'checkout')) };
  }

  async merge(task, run) {
    const repository = await this.directory(task.projectId ?? task.id);
    const head = await this.git(repository, ['rev-parse', 'refs/heads/main']);
    if (![task.baseCommit, run.headCommit].includes(head)) refuse('The owned main branch moved after review.');
    if (await this.git(repository, ['rev-parse', `refs/candidates/${run.id}`]) !== run.headCommit) refuse('The retained candidate ref changed after review.');
    if (head === task.baseCommit) await this.git(repository, ['update-ref', 'refs/heads/main', run.headCommit, task.baseCommit]);
    return { mergedCommit: run.headCommit };
  }
}
