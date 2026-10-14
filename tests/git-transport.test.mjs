import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm, readFile, rename, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { ArtifactGit, gitHttp } from '../src/cloudflare/git-transport.mjs';
import { HostedAgentClient } from '../src/local/hosted-agent-client.mjs';
import { connectMcp } from './helpers/mcp-client.mjs';
const exec = promisify(execFile);

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'projects-git-http-'));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' };
  const git = async (cwd, ...args) => (await exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd, env, windowsHide: true })).stdout.trim();
  const work = path.join(root, 'seed'); await mkdir(work);
  await git(root, 'init', '--bare', '--initial-branch=main', 'source.git');
  await git(work, 'init', '--initial-branch=main');
  await writeFile(path.join(work, 'checkout.mjs'), await readFile('fixtures/checkout.mjs'));
  await git(work, 'add', 'checkout.mjs'); await git(work, 'commit', '-m', 'Seed');
  await git(work, 'push', path.join(root, 'source.git'), 'main');
  await git(root, 'clone', '--bare', 'source.git', 'fork.git');
  await git(path.join(root, 'source.git'), 'config', 'http.receivepack', 'true');
  await git(path.join(root, 'fork.git'), 'config', 'http.receivepack', 'true');
  const baseCommit = await git(work, 'rev-parse', 'HEAD');
  const received = [];
  let beforeReceive = async () => {};
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      received.push({ path: url.pathname, token: request.headers.authorization });
      if (url.pathname === '/source.git/git-receive-pack') await beforeReceive();
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const child = spawn('git', ['http-backend'], { env: { ...env, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1', REQUEST_METHOD: request.method,
        PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), CONTENT_TYPE: request.headers['content-type'] ?? '', CONTENT_LENGTH: String(body.length), REMOTE_USER: 'qa' }, windowsHide: true });
      const outputs = []; let diagnostic = '';
      child.stdout.on('data', data => outputs.push(data)); child.stderr.on('data', data => { diagnostic += data; });
      child.stdin.end(body);
      const [code] = await once(child, 'close');
      if (code !== 0) throw new Error(diagnostic);
      const result = Buffer.concat(outputs), separator = result.indexOf('\r\n\r\n');
      if (separator < 0) throw new Error('Git CGI headers missing');
      const headers = Object.fromEntries(result.subarray(0, separator).toString().split('\r\n').map(line => { const colon = line.indexOf(':'); return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()]; }));
      const status = Number(headers.status?.split(' ')[0] ?? 200); delete headers.status;
      response.writeHead(status, headers); response.end(result.subarray(separator + 4));
    } catch (error) { response.writeHead(500); response.end(error.message); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep)); await rm(root, { recursive: true, force: true }); });
  const transport = new ArtifactGit({ fetchImpl: (url, options) => fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, options) });
  const candidate = { remote: 'https://git.example.test/fork.git', token: 'fork-write-token', defaultBranch: 'main', branch: 'agents/one', baseCommit,
    files: [{ path: 'checkout.mjs', content: 'export const checkoutTotal = items => 42;\n' }],
    context: { taskId: 'task', runId: 'run', revision: 2, purpose: 'Current intent', criteria: ['Exact contract'], baseCommit }, beforePush: async () => {} };
  const merge = headCommit => ({ remote: 'https://git.example.test/source.git', token: 'target-write-token', defaultBranch: 'main',
    candidateRemote: candidate.remote, candidateToken: 'candidate-read-token', candidateBranch: candidate.branch, baseCommit, headCommit, beforePush: async () => {} });
  return { root, work, git, transport, candidate, merge, baseCommit, received, interceptReceive: hook => { beforeReceive = hook; } };
}

async function hostedClientFixture(t) {
  const f = await fixture(t), projectId = crypto.randomUUID(), taskId = crypto.randomUUID(), runId = crypto.randomUUID();
  const scope = { origin: 'https://workspace.example.test', workspaceId: 'hosted-client-fixture', clientId: 'a'.repeat(32) + '.access' };
  const principal = { kind: 'agent', id: scope.clientId, workspaceId: scope.workspaceId };
  const run = { id: runId, taskId, status: 'assigned', branch: 'agents/' + 'c'.repeat(32), baseCommit: f.baseCommit,
    repository: 'https://git.example.test/fork.git', agentIdentity: principal };
  const state = { id: scope.workspaceId, version: 1, authentication: { mode: 'cloudflare-access', principal },
    projects: { [projectId]: { id: projectId } }, tasks: [{ id: taskId, projectId }], runs: [run] };
  let dropWrite = false;
  const client = new HostedAgentClient({ ...scope, clientSecret: 'service-fixture-secret', stateDirectory: path.join(f.root, 'private-client-state') }, {
    fetchImpl: async (url, options) => {
      if (url.origin !== scope.origin) {
        const response = await f.transport.fetchImpl(url, options);
        if (dropWrite && url.pathname === '/fork.git/git-receive-pack') { dropWrite = false; await response.arrayBuffer(); throw new Error('Lost Git response after server commit'); }
        return response;
      }
      if (url.pathname.endsWith('/claim')) return Response.json({ runId, taskId, projectId, workspace: state, credentials: {
        remote: run.repository, token: 'fork-write-token', branch: run.branch, baseCommit: f.baseCommit, expiresAt: new Date(Date.now() + 900000).toISOString() } });
      if (url.pathname.endsWith('/start')) run.status = 'running';
      if (url.pathname.endsWith('/submit')) { run.status = 'awaiting_review'; run.headCommit = JSON.parse(options.body).headCommit; }
      return Response.json(state);
    },
  });
  await client.claim(projectId, 'Native Git client fixture', crypto.randomUUID());
  const directory = path.join(f.root, 'agent-checkout');
  return { ...f, client, directory, runId, run, dropNextWrite: () => { dropWrite = true; } };
}

test('hosted agent client checks out and pushes only its assigned branch using real Git objects', async t => {
  const f = await hostedClientFixture(t);
  const checkout = await f.client.checkout(f.runId, f.directory, crypto.randomUUID());
  assert.equal(checkout.headCommit, f.baseCommit);
  await f.client.mutate('start', f.runId, {}, crypto.randomUUID());
  await writeFile(path.join(f.directory, 'agent.txt'), 'Scoped client change\n');
  await f.git(f.directory, 'add', 'agent.txt'); await f.git(f.directory, 'commit', '-m', 'Agent client fixture');
  const head = await f.git(f.directory, 'rev-parse', 'HEAD'), key = crypto.randomUUID();
  assert.equal((await f.client.push(f.runId, f.directory, head, key)).gitWrite, true);
  assert.equal((await f.client.push(f.runId, f.directory, head, key)).gitWrite, false);
  assert.equal(await f.git(path.join(f.root, 'fork.git'), 'rev-parse', f.run.branch), head);
  assert.equal(await f.git(path.join(f.root, 'fork.git'), 'rev-parse', 'main'), f.baseCommit);
  assert.equal(f.received.filter(item => item.path.endsWith('/git-receive-pack')).length, 1);
  assert.ok(f.received.every(item => item.token === 'Bearer fork-write-token'));
  assert.ok(!(await readFile(path.join(f.directory, '.git', 'config'), 'utf8')).includes('fork-write-token'));
  assert.equal((await f.client.mutate('submit', f.runId, { headCommit: head, summary: 'Native Git fixture' }, crypto.randomUUID())).status, 'awaiting_review');
});

test('hosted checkout retains the resolved child directory and rejects a different checkout after restart', async t => {
  const f = await hostedClientFixture(t), actual = path.join(f.root, 'redirected-checkout');
  const fetchImpl = f.client.fetchImpl;
  let redirected = false;
  f.client.fetchImpl = async (url, options) => {
    if (!redirected && url.origin === 'https://git.example.test') {
      // Deterministic MSIX analogue: parent resolves normally, but the created
      // child is redirected before checkout finishes. No timing-dependent race.
      redirected = true;
      await rename(f.directory, actual);
      await symlink(actual, f.directory, process.platform === 'win32' ? 'junction' : 'dir');
    }
    return fetchImpl(url, options);
  };
  const requested = path.join(await realpath(path.dirname(f.directory)), path.basename(f.directory));
  const checkout = await f.client.checkout(f.runId, f.directory, crypto.randomUUID());
  assert.equal(redirected, true);
  const canonical = await realpath(f.directory);
  assert.notEqual(canonical, requested);
  assert.equal(checkout.directory, canonical);
  const saved = JSON.parse(await readFile(path.join(f.client.connection.stateDirectory, 'runs', f.runId + '.json')));
  assert.equal(saved.directory, canonical);
  const restarted = new HostedAgentClient(f.client.connection, {fetchImpl});
  await writeFile(path.join(f.directory, 'repair.txt'), 'Retained redirected checkout\n');
  await f.git(f.directory, 'add', 'repair.txt'); await f.git(f.directory, 'commit', '-m', 'Redirected fixture');
  const head = await f.git(f.directory, 'rev-parse', 'HEAD');
  assert.equal((await restarted.push(f.runId, f.directory, head, crypto.randomUUID())).gitWrite, true);
  assert.equal(await f.git(path.join(f.root, 'fork.git'), 'rev-parse', f.run.branch), head);
  const other = path.join(f.root, 'different-checkout');
  await f.git(f.root, 'clone', '--no-hardlinks', actual, other);
  assert.equal(await f.git(other, 'rev-parse', 'HEAD'), head);
  const requestsBefore = f.received.length;
  await assert.rejects(restarted.push(f.runId, other, head, crypto.randomUUID()), /Push directory differs/);
  await rename(f.directory, path.join(f.root, 'original-alias'));
  await symlink(other, f.directory, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(restarted.push(f.runId, f.directory, head, crypto.randomUUID()), /Push directory differs/);
  assert.equal(f.received.length, requestsBefore, 'Rejected directories must not reach Git transport');
  assert.equal(f.received.filter(item => item.path.endsWith('/git-receive-pack')).length, 1);
});

test('hosted client retains an uncertain Git response and explicit retry confirms the head without another push', async t => {
  const f = await hostedClientFixture(t);
  await f.client.checkout(f.runId, f.directory, crypto.randomUUID());
  await writeFile(path.join(f.directory, 'retained.txt'), 'Retain uncertain result\n');
  await f.git(f.directory, 'add', 'retained.txt'); await f.git(f.directory, 'commit', '-m', 'Uncertain write fixture');
  const head = await f.git(f.directory, 'rev-parse', 'HEAD'), key = crypto.randomUUID();
  f.dropNextWrite();
  await assert.rejects(f.client.push(f.runId, f.directory, head, key), /Retained receipt/);
  assert.equal(await f.git(path.join(f.root, 'fork.git'), 'rev-parse', f.run.branch), head);
  assert.equal((await f.client.push(f.runId, f.directory, head, key)).outcome, 'already-present');
  assert.equal(f.received.filter(item => item.path.endsWith('/git-receive-pack')).length, 1);
  const receipt = await f.client.receipt(key);
  assert.equal(receipt.attempts.length, 2); assert.ok(receipt.attempts.some(item => item.state === 'outcome-unknown'));
});

test('MCP checks out real Git objects and reconciles a lost push response without repeating the Git write', async t => {
  const f = await hostedClientFixture(t), mcp = await connectMcp(t, f.client);
  const data = result => { assert.notEqual(result.isError, true, JSON.stringify(result)); return result.structuredContent; };
  const run = f.runId, directory = f.directory;
  assert.equal(data(await mcp.call('checkout', { run, directory, requestId: crypto.randomUUID() })).baseCommit, f.baseCommit);
  assert.equal(data(await mcp.call('start', { run, requestId: crypto.randomUUID() })).status, 'running');
  await writeFile(path.join(directory, 'mcp-change.txt'), 'Real Git change through MCP\n');
  await f.git(directory, 'add', 'mcp-change.txt'); await f.git(directory, 'commit', '-m', 'MCP transport fixture');
  const head = await f.git(directory, 'rev-parse', 'HEAD'), requestId = crypto.randomUUID();
  f.dropNextWrite();
  const lost = await mcp.call('push', { run, directory, head, requestId });
  assert.equal(lost.isError, true); assert.match(lost.content[0].text, /Retained receipt/);
  assert.equal(await f.git(path.join(f.root, 'fork.git'), 'rev-parse', f.run.branch), head);
  assert.equal(data(await mcp.call('receipt', { requestId })).attempts[0].state, 'outcome-unknown');
  const recovered = data(await mcp.call('push', { run, directory, head, requestId }));
  assert.equal(recovered.gitWrite, false); assert.equal(recovered.outcome, 'already-present');
  assert.equal(f.received.filter(item => item.path.endsWith('/git-receive-pack')).length, 1);
  assert.equal(await f.git(path.join(f.root, 'fork.git'), 'rev-parse', 'main'), f.baseCommit);
  assert.equal(await f.git(path.join(f.root, 'source.git'), 'rev-parse', 'main'), f.baseCommit);
  assert.equal(data(await mcp.call('submit', { run, head, summary: 'MCP native Git fixture', requestId: crypto.randomUUID() })).status, 'awaiting_review');
  const receipt = data(await mcp.call('receipt', { requestId }));
  assert.equal(receipt.attempts.length, 2); assert.ok(receipt.attempts.some(attempt => attempt.state === 'outcome-unknown'));
  assert.ok(!JSON.stringify(receipt).includes('fork-write-token'));
});

test('repository seed pushes one deterministic README root commit and refuses a nonempty main',async t=>{
  const f=await fixture(t);
  for(const name of ['empty','retry','blocked']) {
    await f.git(f.root,'init','--bare','--initial-branch=main',name+'.git');
    await f.git(path.join(f.root,name+'.git'),'config','http.receivepack','true');
  }
  const seed={remote:'https://git.example.test/empty.git',token:'seed-write-token',name:'customer-portal',description:'A customer portal.',timestamp:1780000000,beforePush:async()=>{}};
  let reserved;const head=await f.transport.seedRepository({...seed,beforePush:async value=>{
    assert.ok(f.received.some(item=>item.path==='/empty.git/info/refs'),'Authority is checked after remote ref discovery');reserved=value;
  }});
  assert.equal(head,reserved);assert.equal(await f.git(path.join(f.root,'empty.git'),'rev-parse','main'),head);
  assert.equal(await f.git(path.join(f.root,'empty.git'),'show','main:README.md'),'# customer-portal\n\nA customer portal.');
  assert.equal(await f.git(path.join(f.root,'empty.git'),'rev-list','--count','main'),'1');
  assert.equal(await f.transport.seedRepository({...seed,remote:'https://git.example.test/retry.git'}),head);
  await assert.rejects(f.transport.seedRepository({...seed,remote:'https://git.example.test/source.git'}));
  assert.equal(await f.git(path.join(f.root,'source.git'),'rev-parse','main'),f.baseCommit);
  await assert.rejects(f.transport.seedRepository({...seed,remote:'https://git.example.test/blocked.git',beforePush:async()=>{throw Error('Owner session revoked');}}),/Owner session revoked/);
  assert.equal(f.received.filter(item=>item.path==='/blocked.git/git-receive-pack').length,0);
  const requests=f.received.filter(item=>item.path.startsWith('/empty.git/'));
  assert.ok(requests.every(item=>item.token==='Bearer seed-write-token'));
});

test('Git transport creates a real artifact context commit and advances only the exact target head', async t => {
  const f = await fixture(t);
  let reserved;
  const head = await f.transport.commitCandidate({ ...f.candidate, beforePush: async value => { reserved = value; } });
  assert.equal(reserved, head);
  assert.equal(await f.git(path.join(f.root, 'fork.git'), 'rev-parse', 'agents/one'), head);
  const context = JSON.parse(await f.git(path.join(f.root, 'fork.git'), 'show', `${head}:.projects/task.json`));
  assert.equal(context.revision, 2);
  assert.equal(context.baseCommit, f.baseCommit);
  assert.equal(await f.git(path.join(f.root, 'source.git'), 'rev-parse', 'main'), f.baseCommit);
  assert.equal(await f.transport.merge(f.merge(head)), head);
  assert.equal(await f.git(path.join(f.root, 'source.git'), 'rev-parse', 'main'), head);
  assert.ok(f.received.filter(item => item.path.startsWith('/source.git/')).every(item => item.token === 'Bearer target-write-token'));
  assert.ok(f.received.some(item => item.token === 'Bearer candidate-read-token'));
});

test('native Git CAS rejects a remote change after advertisement without overwriting it', async t => {
  const f = await fixture(t);
  const head = await f.transport.commitCandidate(f.candidate);
  const tree = await f.git(f.work, 'rev-parse', 'HEAD^{tree}');
  const raced = await f.git(path.join(f.root, 'source.git'), 'commit-tree', tree, '-p', f.baseCommit, '-m', 'Independent remote update');
  f.interceptReceive(() => f.git(path.join(f.root, 'source.git'), 'update-ref', 'refs/heads/main', raced, f.baseCommit));
  await assert.rejects(f.transport.merge(f.merge(head)));
  assert.equal(await f.git(path.join(f.root, 'source.git'), 'rev-parse', 'main'), raced);
});

test('Git credentials cannot follow a different repository or exceed transfer bounds', async () => {
  let calls = 0;
  const client = gitHttp([{ remote: 'https://git.example.test/one.git', token: 'private-token' }], { maxBytes: 4, fetchImpl: async (_, options) => {
    calls++; assert.equal(options.redirect, 'manual'); return new Response('12345');
  } });
  await assert.rejects(client.request({ url: 'https://evil.example/one.git/info/refs' }), /escaped/);
  await assert.rejects(client.request({ url: 'https://git.example.test/two.git/info/refs' }), /escaped/);
  assert.equal(calls, 0);
  await assert.rejects(client.request({ url: 'https://git.example.test/one.git/info/refs' }), /byte allowance/);
});

test('Git refuses every redirect without reading its body or following its credential-bearing Location', async () => {
  for (const status of [300, 301, 302, 303, 304, 305, 307, 308]) {
    let requests = 0, cancelled = false;
    const body = status === 304 ? null : new ReadableStream({ cancel() { cancelled = true; } });
    const client = gitHttp([{ remote: 'https://git.example.test/one.git', token: 'private-token' }], { fetchImpl: async (url, options) => {
      requests++;
      assert.equal(options.redirect, 'manual', 'Supported by the Workers runtime.');
      assert.equal(options.headers.get('Authorization'), 'Bearer private-token');
      assert.equal(url.hostname, 'git.example.test');
      return new Response(body, { status, headers: { Location: 'https://evil.example/two.git/info/refs?token=private-token' } });
    } });
    await assert.rejects(client.request({ url: 'https://git.example.test/one.git/info/refs' }), error => {
      assert.equal(error.message, 'Git repository redirects are refused.');
      assert.ok(!error.message.includes('private-token'));
      return true;
    });
    assert.equal(requests, 1);
    assert.equal(cancelled, status !== 304);
  }
});

test('a real HTTP redirect never receives the repository Authorization header at its destination', async t => {
  const received = [];
  const server = http.createServer((request, response) => {
    received.push({ path: request.url, authorization: request.headers.authorization });
    if (request.url === '/one.git/info/refs') {
      response.writeHead(307, { Location: '/two.git/info/refs' }); response.end();
    } else { response.writeHead(200); response.end('should not be reached'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const port = server.address().port;
  const client = gitHttp([{ remote: 'https://git.example.test/one.git', token: 'private-token' }], {
    fetchImpl: (url, options) => fetch(`http://127.0.0.1:${port}${url.pathname}`, options),
  });
  await assert.rejects(client.request({ url: 'https://git.example.test/one.git/info/refs' }), /redirects are refused/);
  assert.deepEqual(received, [{ path: '/one.git/info/refs', authorization: 'Bearer private-token' }]);
});

async function baseUpdateFixture(t, conflicting = false) {
  const f = await fixture(t);
  const agentWork = path.join(f.root, 'agent-work');
  await f.git(f.root, 'clone', 'fork.git', 'agent-work');
  await f.git(agentWork, 'checkout', '-b', 'agents/changes');
  await writeFile(path.join(agentWork, 'module.py'), 'def total():\n    return 1\n');
  await f.git(agentWork, 'add', '.'); await f.git(agentWork, 'commit', '-m', 'First candidate commit');
  await writeFile(path.join(agentWork, 'module.py'), 'def total():\n    return 2\n');
  if (conflicting) await writeFile(path.join(agentWork, 'checkout.mjs'), 'export const checkoutTotal = () => 123;\n');
  await f.git(agentWork, 'add', '.'); await f.git(agentWork, 'commit', '-m', 'Second candidate commit');
  await f.git(agentWork, 'push', 'origin', 'agents/changes');
  const headCommit = await f.git(agentWork, 'rev-parse', 'HEAD');
  await writeFile(path.join(f.work, conflicting ? 'checkout.mjs' : 'README.md'), conflicting ? 'export const checkoutTotal = () => 456;\n' : 'Independent project update\n');
  await f.git(f.work, 'add', '.'); await f.git(f.work, 'commit', '-m', 'Advance project main');
  await f.git(f.work, 'push', path.join(f.root, 'source.git'), 'main');
  const currentBase = await f.git(f.work, 'rev-parse', 'HEAD');
  await f.git(f.root, 'clone', '--bare', 'source.git', 'updated.git');
  await f.git(path.join(f.root, 'updated.git'), 'config', 'http.receivepack', 'true');
  return { ...f, input: { remote: 'https://git.example.test/updated.git', token: 'update-write-token', defaultBranch: 'main', branch: 'agents/reapplied',
    candidateRemote: 'https://git.example.test/fork.git', candidateToken: 'old-read-token', candidateBranch: 'agents/changes',
    baseCommit: f.baseCommit, headCommit, currentBase, beforePush: async () => {} } };
}

test('base update reapplies a multi-commit Python change and keeps independent project edits', async t => {
  const f = await baseUpdateFixture(t);
  let reserved;
  const head = await f.transport.reapply({ ...f.input, timestamp: 1791000000, beforePush: async oid => { reserved = oid; } });
  assert.equal(reserved, head);
  const updated = path.join(f.root, 'updated.git');
  assert.equal(await f.git(updated, 'rev-parse', 'agents/reapplied'), head);
  assert.equal(await f.git(updated, 'show', `${head}:module.py`), 'def total():\n    return 2');
  assert.equal(await f.git(updated, 'show', `${head}:README.md`), 'Independent project update');
  assert.equal(await f.git(updated, 'rev-parse', `${head}^`), f.input.currentBase);
  assert.equal(await f.git(path.join(f.root, 'source.git'), 'rev-parse', 'main'), f.input.currentBase, 'Reapplication never merges project main.');
  assert.equal(await f.git(path.join(f.root, 'fork.git'), 'rev-parse', 'agents/changes'), f.input.headCommit, 'The original candidate stays intact.');
  assert.equal(await f.transport.reapply({ ...f.input, branch: 'agents/retry-proof', timestamp: 1791000000 }), head, 'A recovered attempt reconstructs the exact reserved commit.');
});

test('conflicting base updates refuse before push and preserve both inputs', async t => {
  const f = await baseUpdateFixture(t, true);
  let reserved = false;
  await assert.rejects(f.transport.reapply({ ...f.input, beforePush: async () => { reserved = true; } }), { code: 'REBASE_CONFLICT' });
  assert.equal(reserved, false);
  assert.equal(await f.git(path.join(f.root, 'updated.git'), 'rev-parse', 'main'), f.input.currentBase);
  await assert.rejects(f.git(path.join(f.root, 'updated.git'), 'rev-parse', '--verify', 'agents/reapplied'));
  assert.equal(await f.git(path.join(f.root, 'fork.git'), 'rev-parse', 'agents/changes'), f.input.headCommit);
});
