import fs from 'node:fs';
import { mkdir, readFile, writeFile, open, rename, unlink, link, lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import git from 'isomorphic-git';
import { gitHttp } from '../cloudflare/git-transport.mjs';
import { readBounded, parseJson } from './cli-input.mjs';
import { projectSummary, projectStatus, taskDetail, candidateSummary } from './repository-cli-view.mjs';
import {parseWorkspacePage} from '../../public/workspace-page.js';

const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const oid = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const fields = ['format', 'origin', 'workspaceId', 'clientId', 'clientSecret'];
const branch = value => typeof value === 'string' && /^(agents|updates)\/[a-f0-9]{32}$/.test(value);
const id = (value, label) => { if (!uuid(value)) throw new Error(label + ' must be a UUID.'); return value; };
const safeText = (value, maximum, label) => {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\0\r\n]/.test(value)) throw new Error(label + ' is missing or invalid.');
  return value;
};

async function privateJson(file, value, exclusive = false) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  try { if (exclusive) await link(temporary, file); else await rename(temporary, file); }
  finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

async function readPrivate(file, limit = 1048576) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Private client state must be a regular file.');
  if (process.platform !== 'win32' && (info.mode & 0o077)) throw new Error('Private connection and receipt files require owner-only permissions (chmod 600).');
  return parseJson(await readBounded(file, limit, 'Private client state'), 'Private client state');
}

async function readPrivateInput(filename, limit, label) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw new Error(label + ' must name an absolute private JSON file.');
  const parent = await realpath(path.dirname(filename));
  for (let directory = parent; ; directory = path.dirname(directory)) {
    try { await lstat(path.join(directory, '.git')); throw new Error('Keep credentials outside Git checkouts.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (path.dirname(directory) === directory) break;
  }
  return readPrivate(filename, limit);
}

/** Explicit connection files never enroll an identity or change an Access policy. */
export async function loadHostedConnection(filename) {
  const configuration = await readPrivateInput(filename, 16384, '--connection');
  if (!configuration || Array.isArray(configuration) || Object.keys(configuration).some(key => !fields.includes(key))
    || fields.some(key => typeof configuration[key] !== 'string') || configuration.format !== 'projects-git-hosted-connection/v1') throw new Error('Invalid hosted connection format; see docs/hosted-agent-client.md.');
  let url;
  try { url = new URL(configuration.origin); } catch { throw new Error('Hosted connection requires a valid HTTPS origin.'); }
  if (url.protocol !== 'https:' || url.origin !== configuration.origin || url.username || url.password || /[\r\n\0]/.test(configuration.origin)) throw new Error('Hosted connection requires a credential-free HTTPS origin without a path.');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(configuration.workspaceId)) throw new Error('Invalid configured workspace ID.');
  if (!/^[a-zA-Z0-9_.-]{1,256}\.access$/.test(configuration.clientId)) throw new Error('Invalid Access service client ID.');
  safeText(configuration.clientSecret, 4096, 'Access service secret');
  const parent = await realpath(path.dirname(filename));
  return { ...configuration, stateDirectory: path.join(parent, path.basename(filename) + '.state', hash(JSON.stringify([configuration.origin, configuration.workspaceId, configuration.clientId]))) };
}

/** API and Git calls are explicit, bounded and never automatically repeated. */
export class HostedAgentClient {
  constructor(connection, { fetchImpl = fetch, now = () => Date.now() } = {}) {
    this.connection = connection; this.fetchImpl = fetchImpl; this.now = now;
    this.secrets = new Set([connection.clientSecret]);
    this.scope = { origin: connection.origin, workspaceId: connection.workspaceId, clientId: connection.clientId };
  }

  sanitize(value) {
    let text = typeof value === 'string' ? value : JSON.stringify(value);
    for (const secret of this.secrets) if (secret) text = text.replaceAll(secret, '[redacted]');
    return text.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted-session]');
  }

  /** Redact before JSON encoding so escaped secrets cannot bypass redaction. */
  serialize(value) {
    return JSON.stringify(value, (_key, item) => {
      if (typeof item === 'string') return this.sanitize(item);
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        return Object.fromEntries(Object.entries(item).map(([key, entry]) => [this.sanitize(key), entry]));
      }
      return item;
    }, 2);
  }

  /** The CLI and MCP share one hosted command path, including post-write readback. */
  async execute(command, options = {}) {
    const url = new URL(this.connection.origin);
    if (['projects', 'status', 'show'].includes(command)) {
      if(command==='projects'&&Number(options.offset??0)>0&&options.revision===undefined)throw new Error('Continue a project listing with both its next offset and revision.');
      const workspace = await this.workspace(command==='projects'?{offset:options.offset??0,at:options.revision}:command==='status'?{project:id(options.project,'Project ID')}:{task:id(options.task,'Task ID')});
      return command === 'projects' ? { projects: Object.keys(workspace.projects).map(projectId => projectSummary(workspace, projectId, url)), workspaceVersion: workspace.version, page:workspace.page }
        : command === 'status' ? projectStatus(workspace, options.project, url) : taskDetail(workspace, options.task, url);
    }
    if (command === 'receipt') return this.receipt(options.requestId);
    if (!['claim', 'checkout', 'push', 'start', 'submit', 'fail'].includes(command)) throw new Error('Unsupported hosted builder command.');
    const output = command === 'claim' ? await this.claim(options.project, options.label, options.requestId)
      : command === 'checkout' ? await this.checkout(options.run, options.directory, options.requestId, options.assignment)
      : command === 'push' ? await this.push(options.run, options.directory, options.head, options.requestId)
      : await this.mutate(command, options.run, { headCommit: options.head, summary: options.summary, message: options.message, directory: options.directory }, options.requestId);
    if (output.runId) {
      try {
        const workspace = await this.workspace({run:output.runId});
        output.candidate = candidateSummary(workspace, output.runId, url);
        output.browserUrl = output.candidate.browserUrl;
      } catch {
        output.readback = 'Operation result is retained, but workspace readback is unavailable. Read status separately; do not automatically repeat the mutation.';
      }
    }
    return output;
  }

  async request(endpoint, body, requestId) {
    const [pathname,search,...extra]=endpoint.split('?');
    if (!/^\/api\/[a-zA-Z0-9/_-]+$/.test(pathname)||extra.length||search!==undefined&&(pathname!=='/api/workspace'||body!==undefined)) throw new Error('Invalid hosted API path.');
    if(search!==undefined)parseWorkspacePage(search);
    let response;
    try {
      response = await this.fetchImpl(new URL(endpoint, this.connection.origin), { method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Workspace-Id': this.connection.workspaceId,
          'CF-Access-Client-Id': this.connection.clientId, 'CF-Access-Client-Secret': this.connection.clientSecret,
          ...(requestId ? { 'Idempotency-Key': requestId } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(120000) });
    } catch { throw new Error('Hosted request lost its response. No automatic retry was attempted; inspect the retained receipt before repeating a mutation.'); }
    if (response.status >= 300 && response.status < 400 || response.redirected) {
      await response.body?.cancel(); throw new Error('Hosted redirects are refused. Check the configured origin and Access service policy.');
    }
    const chunks = []; let size = 0;
    if (response.body) {
      const reader = response.body.getReader();
      try { while (true) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength;
        if (size > 4 * 1024 * 1024) throw new Error('Hosted response exceeds 4 MiB.'); chunks.push(item.value); } }
      finally { await reader.cancel(); }
    }
    let result;
    try { result = parseJson(Buffer.concat(chunks), 'Hosted response'); }
    catch { throw new Error('Hosted response is not valid JSON (HTTP ' + response.status + '). Inspect the receipt before repeating a mutation.'); }
    if (!response.ok) {
      const code = result?.code ?? result?.error?.code;
      throw new Error('Hosted request refused (HTTP ' + response.status + (typeof code === 'string' && /^[A-Z0-9_]{1,80}$/.test(code) ? ', ' + code : '') + '). Inspect current workspace state; no automatic retry was attempted.');
    }
    return result;
  }

  assertWorkspace(workspace) {
    const identity = workspace?.authentication?.principal;
    if (workspace?.id !== this.scope.workspaceId || workspace.authentication?.mode !== 'cloudflare-access'
      || identity?.kind !== 'agent' || identity.id !== this.scope.clientId || identity.workspaceId !== this.scope.workspaceId
      || !Array.isArray(workspace.tasks) || !Array.isArray(workspace.runs) || !workspace.projects) throw new Error('Hosted workspace or authenticated agent identity does not match the connection.');
    return workspace;
  }
  async workspace(selection={}) {
    const params=new URLSearchParams({limit:selection.project||selection.task||selection.run?'1':'10'});
    for(const [key,value] of Object.entries(selection))if(value!==undefined&&value!==null)params.set(key,String(value));
    return this.assertWorkspace(await this.request('/api/workspace?'+params));
  }
  ownRun(workspace, runId) {
    id(runId, 'Run ID');
    const run = workspace.runs.find(item => item.id === runId);
    if (!run || run.agentIdentity?.kind !== 'agent' || run.agentIdentity.id !== this.scope.clientId || run.agentIdentity.workspaceId !== this.scope.workspaceId) throw new Error('This assignment does not belong to the authenticated agent.');
    return run;
  }

  async initializeState() {
    await mkdir(this.connection.stateDirectory, { recursive: true, mode: 0o700 });
    for (const name of ['requests', 'runs', 'attempts']) await mkdir(path.join(this.connection.stateDirectory, name), { recursive: true, mode: 0o700 });
  }
  async attempt(command, requestId, payload, action) {
    id(requestId, 'Request ID'); await this.initializeState();
    const manifest = { scope: this.scope, command, requestId, payload };
    const file = path.join(this.connection.stateDirectory, 'requests', requestId + '.json');
    try { await privateJson(file, manifest, true); }
    catch (error) { if (error.code !== 'EEXIST') throw error;
      const prior = await readPrivate(file);
      if (JSON.stringify(prior) !== JSON.stringify(manifest)) throw new Error('Request ID conflicts with its retained command, inputs or principal.'); }
    const attemptFile = path.join(this.connection.stateDirectory, 'attempts', requestId + '.' + randomUUID() + '.json');
    const record = { ...manifest, startedAt: new Date(this.now()).toISOString(), state: 'outcome-unknown' };
    await privateJson(attemptFile, record);
    try {
      const result = await action();
      await privateJson(attemptFile, { ...record, state: 'complete', finishedAt: new Date(this.now()).toISOString(), result });
      return { ...result, receipt: attemptFile };
    } catch (error) {
      await privateJson(attemptFile, { ...record, finishedAt: new Date(this.now()).toISOString(), error: this.sanitize(error.message ?? 'Operation failed') });
      throw new Error(this.sanitize(error.message ?? 'Operation failed') + '\nRetained receipt: ' + attemptFile);
    }
  }
  async receipt(requestId) {
    id(requestId, 'Request ID');
    const manifest = await readPrivate(path.join(this.connection.stateDirectory, 'requests', requestId + '.json'));
    if (JSON.stringify(manifest.scope) !== JSON.stringify(this.scope)) throw new Error('Receipt belongs to another connection.');
    const files = (await readdir(path.join(this.connection.stateDirectory, 'attempts'))).filter(name => name.startsWith(requestId + '.') && name.endsWith('.json'));
    const attempts = await Promise.all(files.map(name => readPrivate(path.join(this.connection.stateDirectory, 'attempts', name))));
    return { ...manifest, attempts, next: 'Read current status. For an explicit claim retry, repeat the original claim with the same request ID and inputs. Issued-once Git credentials cannot be recovered from the server. No mutation was sent by receipt.' };
  }

  async claim(projectId, label, requestId) {
    id(projectId, 'Project ID'); safeText(label, 160, 'Agent label');
    const workspace = await this.workspace({project:projectId});
    if (!Object.hasOwn(workspace.projects, projectId)) throw new Error('Project does not belong to this workspace.');
    return this.attempt('claim', requestId, { projectId, label }, async () => {
      const result = await this.request('/api/projects/' + projectId + '/claim', { label }, requestId);
      if (result.idle === true) return { idle: true, reason: typeof result.reason === 'string' ? this.sanitize(result.reason) : 'No eligible work.', replayed: result.replayed === true };
      id(result.runId, 'Returned run ID');
      const state = this.assertWorkspace(result.workspace ?? await this.workspace({project:projectId}));
      const run = this.ownRun(state, result.runId);
      if (result.projectId !== projectId || state.tasks.find(task => task.id === run.taskId)?.projectId !== projectId) throw new Error('Claim returned work outside the requested project.');
      const file = path.join(this.connection.stateDirectory, 'runs', run.id + '.json');
      if (result.credentials) {
        const credential = this.validateCredential(run, result.credentials);
        await privateJson(file, { scope: this.scope, runId: run.id, taskId: run.taskId, projectId, credentials: credential });
      }
      let retained = false;
      try { const saved = await readPrivate(file); retained = JSON.stringify(saved.scope) === JSON.stringify(this.scope) && saved.runId === run.id && Date.parse(saved.credentials?.expiresAt) > this.now(); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      return { runId: run.id, taskId: run.taskId, projectId, replayed: result.replayed === true,
        credentialStatus: retained ? 'saved-privately' : 'unavailable',
        next: retained ? 'Use checkout with this run ID and a new directory. Git credentials are temporary and never printed.' : 'The server returns Git credentials once. Inspect the retained assignment; explicitly close it and agree new work if its credential response was lost.' };
    });
  }

  validateCredential(run, credential) {
    if (typeof credential?.token === 'string') this.secrets.add(credential.token);
    let remote;
    try { remote = new URL(credential?.remote); } catch { throw new Error('Assignment credentials do not match the retained run.'); }
    if (remote.protocol !== 'https:' || remote.username || remote.password || remote.search || remote.hash || !remote.pathname.endsWith('.git')
      || credential.remote !== run.repository || credential.branch !== run.branch || credential.baseCommit !== run.baseCommit
      || !branch(credential.branch) || credential.branch.startsWith('updates/') && !uuid(run.reconcilesRunId)
      || !oid(credential.baseCommit) || typeof credential.token !== 'string' || !credential.token || credential.token.length > 4096 || /[\0\r\n]/.test(credential.token)
      || typeof credential.expiresAt !== 'string' || !Number.isFinite(Date.parse(credential.expiresAt))) throw new Error('Assignment credentials do not match the retained run.');
    if (Date.parse(credential.expiresAt) <= this.now()) throw new Error('Assignment Git credential expired. No credential renewal or replacement work was requested.');
    return Object.fromEntries(['token','expiresAt','remote','branch','baseCommit'].map(key => [key, credential[key]]));
  }

  /** Import only an existing owner-issued resolution; the builder cannot create one. */
  async resolutionInput(runId, filename) {
    id(runId, 'Run ID');
    const input = await readPrivateInput(filename, 4 * 1024 * 1024, '--assignment');
    if (typeof input?.credentials?.token === 'string') this.secrets.add(input.credentials.token);
    const state = await this.workspace({run:runId}), run = this.ownRun(state, runId), task = state.tasks.find(item => item.id === run.taskId);
    if (input?.mode !== 'resolve' || input.runId !== runId || input.taskId !== run.taskId || input.projectId !== task?.projectId
      || !Object.hasOwn(state.projects, input.projectId) || run.origin !== 'external-agent' || !uuid(run.reconcilesRunId)
      || typeof run.branch !== 'string' || !run.branch.startsWith('updates/') || !['assigned','running'].includes(run.status)
      || run.baseCommit !== task.baseCommit || !Number.isSafeInteger(task.revision) || task.revision < 1
      || run.assignedRevision !== task.revision) throw new Error('Resolution file does not match the current unfinished assignment.');
    const credentials = this.validateCredential(run, input.credentials);
    const saved = {scope:this.scope,runId,taskId:run.taskId,projectId:task.projectId,credentials};
    return {saved,assignmentFile:await realpath(filename),assignmentSha256:hash(JSON.stringify(saved))};
  }

  async mutate(command, runId, input, requestId) {
    if (!['start', 'submit', 'fail'].includes(command)) throw new Error('Hosted agents may only start, submit or fail their own work.');
    const state = await this.workspace({run:id(runId,'Run ID')}), before = this.ownRun(state, runId);
    const body = command === 'submit' ? { headCommit: input.headCommit, summary: safeText(input.summary, 2000, 'Summary') }
      : command === 'fail' ? { message: safeText(input.message, 2000, 'Failure reason') } : {};
    if (command === 'submit' && !oid(body.headCommit)) throw new Error('Submission requires the full SHA-1 commit ID.');
    if (input.directory !== undefined && (command !== 'submit' || typeof input.directory !== 'string' || !path.isAbsolute(input.directory))) throw new Error('Submission directory must be an absolute assigned checkout.');
    const directory = input.directory === undefined ? undefined : path.normalize(input.directory);
    const digest = directory === undefined ? null : hash(JSON.stringify([this.scope, id(requestId,'Request ID'), 'submit-push']));
    // A stable child UUID retains the exact Git effect across explicit retries.
    const pushRequestId = digest && `${digest.slice(0,8)}-${digest.slice(8,12)}-8${digest.slice(13,16)}-a${digest.slice(17,20)}-${digest.slice(20,32)}`;
    return this.attempt(command, requestId, { runId, ...body, ...(directory === undefined ? {} : {directory,pushRequestId}) }, async () => {
      // Submit has no server idempotency receipt. An explicit retry of a closed
      // run must reconcile its retained outcome instead of sending another POST.
      const terminal = ['awaiting_review', 'accepted', 'rejected', 'merged', 'superseded', 'failed'].includes(before.status);
      if (terminal && ['submit', 'fail'].includes(command)) {
        await this.retireCredential(runId);
        const matches = command === 'submit' ? before.headCommit === body.headCommit && before.summary === body.summary.trim()
          && before.status !== 'failed' : before.status === 'failed';
        if (!matches) throw new Error('The assignment is closed with a different retained outcome. Its private credential was retired; no mutation was repeated.');
        return {runId,taskId:before.taskId,status:before.status,headCommit:before.headCommit??null,reconciled:true,remoteMutation:false,
          observation:'Confirmed from the current authenticated workspace. Earlier unknown attempts remain in receipt history.'};
      }
      const pushed = directory === undefined ? undefined : await this.push(runId, directory, body.headCommit, pushRequestId);
      const after = this.assertWorkspace(await this.request('/api/runs/' + runId + '/' + command, body, requestId));
      const run = this.ownRun(after, runId);
      if (['submit', 'fail'].includes(command)) await this.retireCredential(runId);
      return { runId, taskId: run.taskId, status: run.status, headCommit: run.headCommit ?? null,
        ...(pushed ? {push:{requestId:pushRequestId,...pushed}} : {}) };
    });
  }

  async retireCredential(runId) {
    const file=path.join(this.connection.stateDirectory,'runs',id(runId,'Run ID')+'.json');
    let saved;
    try { saved=await readPrivate(file); } catch(error) { if(error.code==='ENOENT')return; throw error; }
    if(JSON.stringify(saved.scope)!==JSON.stringify(this.scope)||saved.runId!==runId)throw new Error('Credential cleanup refused a different principal or assignment.');
    await unlink(file);
  }

  async assignment(runId) {
    const state = await this.workspace({run:id(runId,'Run ID')}), run = this.ownRun(state, runId);
    if (!['assigned', 'running'].includes(run.status)) throw new Error('Git access is available only for unfinished assignments.');
    const saved = await readPrivate(path.join(this.connection.stateDirectory, 'runs', runId + '.json'));
    if (JSON.stringify(saved.scope) !== JSON.stringify(this.scope) || saved.runId !== runId || saved.credentials?.remote !== run.repository
      || saved.credentials.branch !== run.branch || saved.credentials.baseCommit !== run.baseCommit) throw new Error('Saved Git credential does not match this assignment.');
    this.validateCredential(run, saved.credentials); return { run, saved };
  }

  async checkout(runId, directory, requestId, assignmentFile) {
    id(requestId,'Request ID');
    if (!path.isAbsolute(directory)) throw new Error('Checkout directory must be absolute and new.');
    const imported = assignmentFile === undefined ? null : await this.resolutionInput(runId, assignmentFile);
    const { saved } = imported ?? await this.assignment(runId);
    const dir = path.join(await realpath(path.dirname(directory)), path.basename(directory));
    return this.attempt('checkout', requestId, { runId, directory: dir,
      ...(imported ? {assignmentFile:imported.assignmentFile,assignmentSha256:imported.assignmentSha256} : {}) }, async () => {
      if (imported) {
        const file = path.join(this.connection.stateDirectory,'runs',runId+'.json');
        try { await privateJson(file,saved,true); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          const retained = await readPrivate(file);
          if (JSON.stringify({...retained,directory:undefined}) !== JSON.stringify(saved)) throw new Error('This assignment already has a different retained credential. It was not replaced.');
        }
      }
      await mkdir(dir); // Existing or partial work is never reset or removed.
      const { remote, token, baseCommit, branch: ref } = saved.credentials;
      const http = gitHttp([{ remote, token }], { fetchImpl: this.fetchImpl, timeoutMs: 120000, maxBytes: 64 * 1024 * 1024 });
      try {
        await git.clone({ fs, http, dir, url: remote, noCheckout: true });
        const refs = await git.listBranches({ fs, dir, remote: 'origin' });
        const head = refs.includes(ref) ? await git.resolveRef({ fs, dir, ref: 'refs/remotes/origin/' + ref }) : baseCommit;
        if (head !== baseCommit && !await git.isDescendent({ fs, dir, oid: head, ancestor: baseCommit })) throw new Error('Assigned branch does not descend from its pinned base.');
        await git.writeRef({ fs, dir, ref: 'refs/heads/' + ref, value: head });
        await git.checkout({ fs, dir, ref });
        // A created child can resolve differently from its parent under Windows
        // filesystem redirection. Pin the completed checkout, as push does.
        const completedDirectory = await realpath(dir);
        await privateJson(path.join(this.connection.stateDirectory, 'runs', runId + '.json'), { ...saved, directory: completedDirectory });
        return { runId, directory: completedDirectory, branch: ref, headCommit: head, baseCommit,
          ...(imported ? {assignmentImported:true,credentialStatus:'saved-privately'} : {}) };
      } catch (error) { throw new Error('Checkout did not finish; its directory is retained. ' + this.sanitize(error.message)); }
    });
  }

  async push(runId, directory, head, requestId) {
    if (!oid(head)) throw new Error('Push requires the exact full commit ID.');
    const { saved } = await this.assignment(runId);
    const dir = await realpath(directory);
    if (dir !== saved.directory) throw new Error('Push directory differs from the retained assignment checkout.');
    const { remote, token, baseCommit, branch: ref } = saved.credentials;
    if (await git.currentBranch({ fs, dir }) !== ref || await git.resolveRef({ fs, dir, ref: 'HEAD' }) !== head
      || head !== baseCommit && !await git.isDescendent({ fs, dir, oid: head, ancestor: baseCommit })) throw new Error('Checkout branch or head differs from this assignment.');
    return this.attempt('push', requestId, { runId, directory: dir, head }, async () => {
      const http = gitHttp([{ remote, token }], { fetchImpl: this.fetchImpl, timeoutMs: 120000, maxBytes: 64 * 1024 * 1024 });
      const readHead = async () => (await git.listServerRefs({ http, url: remote })).find(item => item.ref === 'refs/heads/' + ref)?.oid;
      const observed = await readHead();
      if (observed === head) return { runId, headCommit: head, outcome: 'already-present', gitWrite: false };
      if (observed && observed !== baseCommit && !await git.isDescendent({ fs, dir, oid: head, ancestor: observed })) throw new Error('Remote branch advanced outside this checkout; inspect it before pushing.');
      const result = await git.push({ fs, http, dir, url: remote, ref, remoteRef: ref, force: false,
        onPrePush: ({ localRef, remoteRef }) => localRef.oid === head && remoteRef.oid === (observed ?? '0'.repeat(40)) });
      if (!result.ok || !result.refs?.['refs/heads/' + ref]?.ok || await readHead() !== head) throw new Error('Git did not confirm the exact assignment branch. Its outcome is uncertain; inspect before an explicit retry.');
      return { runId, headCommit: head, outcome: 'pushed', gitWrite: true, next: 'Submit this exact head separately; a push is not verification or acceptance.' };
    });
  }
}
