import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { HostedAgentClient, loadHostedConnection } from '../src/local/hosted-agent-client.mjs';
import { connectMcp } from './helpers/mcp-client.mjs';

const project = '10000000-0000-4000-8000-000000000001';
const task = '10000000-0000-4000-8000-000000000002';
const run = '10000000-0000-4000-8000-000000000003';
const head = 'd'.repeat(40);
const configuration = { format: 'projects-git-hosted-connection/v1', origin: 'https://workspace.example.test',
  workspaceId: 'mcp-fixture', clientId: 'a'.repeat(32) + '.access', clientSecret: 'fixture-service-"secret\\only' };
const execute = promisify(execFile);
const errorText = result => result.content.map(item => item.text ?? '').join('\n');
function data(result) {
  assert.notEqual(result.isError, true, errorText(result));
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  return result.structuredContent;
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'projects-mcp-'));
  t.after(async () => {
    assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep));
    await rm(root, { recursive: true, force: true });
  });
  const file = path.join(root, 'connection.json');
  await writeFile(file, JSON.stringify(configuration), { mode: 0o600 });
  const connection = await loadHostedConnection(file);
  const principal = { kind: 'agent', id: configuration.clientId, workspaceId: configuration.workspaceId };
  const assignment = { id: run, taskId: task, label: 'MCP fixture', origin: 'external-agent', agent: 'external', status: 'assigned',
    branch: 'agents/' + 'c'.repeat(32), baseCommit: 'b'.repeat(40), repository: 'https://git.example.test/fork.git',
    agentIdentity: principal, assignedRevision: 1, changedFiles: [], evidence: null };
  const state = { id: configuration.workspaceId, version: 1, provider: 'cloudflare-artifacts', events: [],
    authentication: { mode: 'cloudflare-access', principal }, coordination: { [run]: { acceptance: [], overlaps: [] } },
    capacity: { execution: { limit: 4 }, verification: { limit: 2 } },
    projects: { [project]: { id: project, name: 'MCP fixture', acceptingWork: true } },
    tasks: [{ id: task, projectId: project, revision: 1, ownerVersion: 1, criteria: ['Retain failures'], purpose: 'MCP fixture task',
      title: 'Fixture', status: 'running', baseCommit: assignment.baseCommit }], runs: [assignment] };
  const credentials = { token: 'fixture-git-"credential\\only', expiresAt: new Date(Date.now() + 900000).toISOString(),
    remote: assignment.repository, branch: assignment.branch, baseCommit: assignment.baseCommit };
  const requests = [];
  const controls = { issued: false, dropClaim: false, dropSubmit: false, refuseReadback: false, readbackFailed: false, barrier: null };
  const fetchImpl = async (url, options) => {
    assert.equal(url.origin, configuration.origin);
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers['CF-Access-Client-Secret'], configuration.clientSecret);
    assert.equal(options.headers['CF-Access-Client-Id'], configuration.clientId);
    assert.equal(options.headers['X-Workspace-Id'], configuration.workspaceId);
    requests.push({ path: url.pathname, method: options.method, body: options.body, key: options.headers['Idempotency-Key'] });
    if (options.method === 'GET') {
      if (controls.readbackFailed) return Response.json({ code: 'FORBIDDEN' }, { status: 403 });
      return Response.json(structuredClone(state));
    }
    if (url.pathname.endsWith('/claim')) {
      const replayed = controls.issued; controls.issued = true;
      if (controls.barrier) { controls.barrier.entered.resolve(); await controls.barrier.release.promise; }
      if (controls.dropClaim) { controls.dropClaim = false; throw Error('Lost claim response ' + configuration.clientSecret); }
      if (controls.refuseReadback) controls.readbackFailed = true;
      return Response.json({ runId: run, taskId: task, projectId: project, workspace: structuredClone(state), credentials: replayed ? null : credentials, replayed });
    }
    if (url.pathname.endsWith('/start')) assignment.status = 'running';
    else if (url.pathname.endsWith('/fail')) assignment.status = 'failed';
    else if (url.pathname.endsWith('/submit')) {
      assignment.status = 'awaiting_review';
      Object.assign(assignment, JSON.parse(options.body));
      if (controls.dropSubmit) { controls.dropSubmit = false; throw Error('Lost submit response'); }
    } else assert.fail('Unexpected mutation route: ' + url.pathname);
    return Response.json(structuredClone(state));
  };
  const client = new HostedAgentClient(connection, { fetchImpl });
  const mcp = await connectMcp(t, client);
  return { ...mcp, root, file, connection, client, state, assignment, credentials, requests, controls, fetchImpl };
}

test('MCP discovers exactly the hosted builder tools with strict schemas and explicit mutation IDs', async t => {
  const f = await fixture(t);
  const { tools } = await f.protocol.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['list_projects', 'project_status', 'get_task', 'claim', 'checkout', 'start', 'push', 'submit', 'fail', 'receipt', 'locks', 'release_lock'].map(name => 'projects_git_' + name).sort());
  for (const tool of tools) {
    assert.equal(tool.inputSchema.additionalProperties, false);
    for (const key of ['connection', 'origin', 'workspaceId', 'clientSecret', 'principal', 'reviewer']) assert.ok(!Object.hasOwn(tool.inputSchema.properties, key));
    if (!tool.annotations.readOnlyHint) {
      assert.ok(tool.inputSchema.required.includes('requestId'));
      assert.equal(tool.annotations.idempotentHint, false);
    }
  }
  assert.equal(f.requests.length, 0);
  await assert.rejects(stat(f.connection.stateDirectory), { code: 'ENOENT' });
});

test('MCP read tools share CLI projections, redact escaped secrets and keep counter denominators', async t => {
  const f = await fixture(t);
  f.state.projects[project].name += ' ' + configuration.clientSecret + ' eyJabc.def.ghi';
  const projects = data(await f.call('list_projects'));
  assert.match(projects.projects[0].name, /\[redacted\]/);
  assert.match(projects.projects[0].name, /\[redacted-session\]/);
  const status = data(await f.call('project_status', { project }));
  assert.equal(status.counters.activeCandidates.numerator, 1);
  assert.equal(status.counters.activeCandidates.denominator, 1);
  const shown = data(await f.call('get_task', { task }));
  assert.equal(shown.taskId, task);
  assert.match(shown.browserUrl, /^https:\/\/workspace\.example\.test/);
  assert.deepEqual(shown, JSON.parse(f.client.serialize(await f.client.execute('show', { task }))));
});

test('MCP refuses owner tools, forged fields and malformed inputs before network or durable work', async t => {
  const f = await fixture(t);
  for (const [name, args] of [
    ['claim', { project, label: 'Builder' }],
    ['claim', { project, label: 'Builder', requestId: randomUUID(), principal: 'owner' }],
    ['claim', { project, label: 'Builder', requestId: randomUUID(), origin: 'https://foreign.test' }],
    ['claim', { project, label: '   ', requestId: randomUUID() }],
    ['claim', { project, label: 'line\nbreak', requestId: randomUUID() }],
    ['claim', { project, label: 'trailing\n', requestId: randomUUID() }],
    ['start', { run: '../../escape', requestId: randomUUID() }],
    ['submit', { run, head: 'short', summary: 'Work', requestId: randomUUID() }],
    ['submit', { run, head, summary: 'x'.repeat(2001), requestId: randomUUID() }],
  ]) assert.equal((await f.call(name, args)).isError, true, name);
  for (const name of ['accept', 'merge', 'verify', 'review', 'admission']) {
    await assert.rejects(f.call(name, { run }), /not found|Unknown tool/i);
  }
  assert.equal(f.requests.length, 0);
  await assert.rejects(stat(f.connection.stateDirectory), { code: 'ENOENT' });
});

test('MCP owner, wrong-workspace and foreign-client sessions refuse claims before POST or receipts', async t => {
  const f = await fixture(t);
  for (const patch of [{ kind: 'owner' }, { workspaceId: 'foreign' }, { id: 'foreign.access' }]) {
    Object.assign(f.state.authentication.principal, patch);
    assert.equal((await f.call('claim', { project, label: 'Builder', requestId: randomUUID() })).isError, true);
    Object.assign(f.state.authentication.principal, { kind: 'agent', workspaceId: configuration.workspaceId, id: configuration.clientId });
  }
  f.state.id = 'foreign';
  assert.equal((await f.call('claim', { project, label: 'Builder', requestId: randomUUID() })).isError, true);
  assert.equal(f.requests.filter(request => request.method === 'POST').length, 0);
  await assert.rejects(stat(path.join(f.connection.stateDirectory, 'requests')), { code: 'ENOENT' });
  assert.equal((await f.client.execute('locks')).total, 0);
});

test('MCP lock inspection and explicit local release expose no provider authority', async t => {
  const f = await fixture(t), {tools} = await f.protocol.listTools();
  for (const name of ['locks', 'receipt', 'release_lock']) {
    assert.equal(tools.find(tool => tool.name === 'projects_git_' + name).annotations.openWorldHint, false);
  }
  assert.equal(data(await f.call('locks')).total, 0);
  assert.equal(data(await f.call('release_lock', {requestId: randomUUID(), lockId: randomUUID()})).releasedLocalLocks, 0);
  assert.equal((await f.call('release_lock', {requestId: randomUUID()})).isError, true);
  assert.equal(f.requests.length, 0);
  await assert.rejects(stat(f.connection.stateDirectory), {code: 'ENOENT'});
});

test('MCP claims share durable CLI receipts; identical replay is safe and changed payload conflicts', async t => {
  const f = await fixture(t), requestId = randomUUID();
  const first = data(await f.call('claim', { project, label: 'Builder', requestId }));
  assert.equal(first.credentialStatus, 'saved-privately');
  assert.equal(first.runId, run);
  const replay = data(await f.call('claim', { project, label: 'Builder', requestId }));
  assert.equal(replay.replayed, true);
  const conflict = await f.call('claim', { project, label: 'Other input', requestId });
  assert.equal(conflict.isError, true); assert.match(errorText(conflict), /conflicts/);
  assert.equal(f.requests.filter(request => request.method === 'POST').length, 2);
  const receipt = data(await f.call('receipt', { requestId }));
  assert.deepEqual(receipt, JSON.parse(f.client.serialize(await f.client.execute('receipt', { requestId }))));
  assert.equal(receipt.attempts.length, 2);
  assert.equal(receipt.scope.clientId, configuration.clientId);
  for (const secret of [configuration.clientSecret, f.credentials.token]) assert.ok(!JSON.stringify([first, replay, receipt]).includes(JSON.stringify(secret).slice(1, -1)));
  const saved = JSON.parse(await readFile(path.join(f.connection.stateDirectory, 'runs', run + '.json'), 'utf8'));
  assert.equal(saved.credentials.token, f.credentials.token);
});

test('MCP foreign assignments and receipts cannot recover another builder\'s credentials or mutate work', async t => {
  const f = await fixture(t);
  data(await f.call('claim', { project, label: 'Builder', requestId: randomUUID() }));
  f.assignment.agentIdentity = { ...f.assignment.agentIdentity, id: 'foreign.access' };
  const before = f.requests.filter(request => request.method === 'POST').length;
  const directory = path.join(f.root, 'new-checkout');
  for (const [name, args] of [['start', {}], ['checkout', { directory }], ['push', { directory, head }], ['submit', { head, summary: 'Work' }], ['fail', { message: 'Stop' }]]) {
    const result = await f.call(name, { run, requestId: randomUUID(), ...args });
    assert.equal(result.isError, true); assert.match(errorText(result), /does not belong/);
  }
  assert.equal(f.requests.filter(request => request.method === 'POST').length, before);
  await assert.rejects(stat(directory), { code: 'ENOENT' });
  const key = randomUUID();
  await writeFile(path.join(f.connection.stateDirectory, 'requests', key + '.json'), JSON.stringify({ scope: { ...f.client.scope, clientId: 'foreign.access' } }), { mode: 0o600 });
  const receipt = await f.call('receipt', { requestId: key });
  assert.equal(receipt.isError, true); assert.match(errorText(receipt), /another connection/);
});

test('MCP lost claim responses remain unknown; no automatic replay or invented credential', async t => {
  const f = await fixture(t), requestId = randomUUID(); f.controls.dropClaim = true;
  const lost = await f.call('claim', { project, label: 'Builder', requestId });
  assert.equal(lost.isError, true); assert.match(errorText(lost), /Retained receipt/);
  assert.equal(f.requests.filter(request => request.method === 'POST').length, 1);
  assert.equal(data(await f.call('receipt', { requestId })).attempts[0].state, 'outcome-unknown');
  const retry = data(await f.call('claim', { project, label: 'Builder', requestId }));
  assert.equal(retry.credentialStatus, 'unavailable');
  const attempts = data(await f.call('receipt', { requestId })).attempts;
  assert.equal(attempts.length, 2); assert.ok(attempts.some(attempt => attempt.state === 'outcome-unknown'));
});

test('MCP lost submit responses reconcile after restart without another POST', async t => {
  const f = await fixture(t);
  data(await f.call('claim', { project, label: 'Builder', requestId: randomUUID() }));
  data(await f.call('start', { run, requestId: randomUUID() }));
  const requestId = randomUUID(), args = { run, head, summary: 'Submitted change', requestId };
  f.controls.dropSubmit = true;
  assert.equal((await f.call('submit', args)).isError, true);
  const restarted = await connectMcp(t, new HostedAgentClient(f.connection, { fetchImpl: f.fetchImpl }));
  const recovered = data(await restarted.call('submit', args));
  assert.equal(recovered.reconciled, true); assert.equal(recovered.remoteMutation, false);
  assert.equal(f.requests.filter(request => request.path.endsWith('/submit')).length, 1);
  await assert.rejects(stat(path.join(f.connection.stateDirectory, 'runs', run + '.json')), { code: 'ENOENT' });
  assert.equal(data(await restarted.call('receipt', { requestId })).attempts.length, 2);
});

test('MCP rejects competing mutations while a barrier holds an admitted operation; reads remain available', async t => {
  const f = await fixture(t), requestId = randomUUID();
  const barrier = { entered: Promise.withResolvers(), release: Promise.withResolvers() };
  f.controls.barrier = barrier;
  const first = f.call('claim', { project, label: 'Builder', requestId });
  try {
    await barrier.entered.promise;
    const competing = await f.call('claim', { project, label: 'Builder', requestId });
    assert.equal(competing.isError, true); assert.match(errorText(competing), /still running/);
    assert.equal(data(await f.call('list_projects')).projects.length, 1);
    assert.equal(f.requests.filter(request => request.method === 'POST').length, 1);
  } finally { barrier.release.resolve(); }
  assert.equal(data(await first).runId, run);
  assert.equal(data(await f.call('claim', { project, label: 'Builder', requestId })).replayed, true);
});

test('MCP successful mutation with failed readback reports retained success without repeating the write', async t => {
  const f = await fixture(t); f.controls.refuseReadback = true;
  const result = data(await f.call('claim', { project, label: 'Builder', requestId: randomUUID() }));
  assert.equal(result.credentialStatus, 'saved-privately'); assert.match(result.readback, /readback is unavailable/);
  assert.equal(f.requests.filter(request => request.method === 'POST').length, 1);
});

test('MCP cancellation does not release an operation that is still awaiting its API response', async t => {
  const f = await fixture(t), requestId = randomUUID();
  const barrier = { entered: Promise.withResolvers(), release: Promise.withResolvers() };
  f.controls.barrier = barrier;
  const finished = Promise.withResolvers(), executeCommand = f.client.execute.bind(f.client);
  f.client.execute = async (...args) => {
    try { return await executeCommand(...args); }
    finally { if (args[0] === 'claim') finished.resolve(); }
  };
  const controller = new AbortController();
  const pending = f.call('claim', { project, label: 'Builder', requestId }, { signal: controller.signal });
  const rejected = assert.rejects(pending);
  try {
    await barrier.entered.promise;
    controller.abort(); await rejected;
    const competing = await f.call('claim', { project, label: 'Builder', requestId });
    assert.equal(competing.isError, true); assert.match(errorText(competing), /still running/);
    assert.equal(f.requests.filter(request => request.method === 'POST').length, 1);
  } finally { barrier.release.resolve(); await finished.promise; }
  const receipt = data(await f.call('receipt', { requestId }));
  assert.equal(receipt.attempts.length, 1);
  assert.equal(receipt.attempts[0].state, 'complete');
});

test('MCP oversized reads return an explicit display error rather than truncated project data', async t => {
  const f = await fixture(t); f.state.projects[project].name = 'x'.repeat(2 * 1024 * 1024);
  const result = await f.call('list_projects');
  assert.equal(result.isError, true); assert.match(errorText(result), /2 MiB/);
  assert.equal(result.structuredContent, undefined);
});

test('real stdio entry point serves modern and legacy hosts from another directory without protocol noise', async t => {
  const f = await fixture(t);
  for (const mode of [{ pin: '2026-07-28' }, 'legacy']) {
    const protocol = new Client({ name: 'stdio-qualification', version: '1.0.0' }, { versionNegotiation: { mode } });
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('scripts/agent-mcp.mjs'), '--connection', f.file], cwd: f.root, stderr: 'pipe' });
    let stderr = ''; transport.stderr.on('data', chunk => { stderr += chunk; });
    try {
      await protocol.connect(transport);
      assert.equal((await protocol.listTools()).tools.length, 12);
      const refused = await protocol.callTool({ name: 'projects_git_start', arguments: { run, principal: 'owner' } });
      assert.equal(refused.isError, true);
    } finally { await protocol.close(); await transport.close(); }
    assert.equal(stderr, '');
  }
  await assert.rejects(stat(f.connection.stateDirectory), { code: 'ENOENT' });
});

test('MCP entry point requires a private fixed connection; help and diagnostics stay off stdout', async () => {
  const script = path.resolve('scripts/agent-mcp.mjs');
  const help = await execute(process.execPath, [script, '--help'], { windowsHide: true });
  assert.equal(help.stdout, ''); assert.match(help.stderr, /SDK v2/);
  for (const args of [[], ['--url', 'http://localhost'], ['--connection', 'relative.json'], ['--connection', 'missing', '--principal', 'owner']]) {
    await assert.rejects(execute(process.execPath, [script, ...args], { windowsHide: true }), error => error.code === 1 && error.stdout === '' && /startup refused/.test(error.stderr));
  }
});

test('stdio oversized input closes without reflecting secrets or starting a workspace operation', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const child = spawn(process.execPath, [path.resolve('scripts/agent-mcp.mjs'), '--connection', f.file], { cwd: f.root, windowsHide: true });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.on('error', error => { if (error.code !== 'EPIPE') throw error; });
  const closed = once(child, 'close');
  child.stdin.end(configuration.clientSecret + 'x'.repeat(128 * 1024));
  await closed;
  assert.equal(stdout, '');
  assert.match(stderr, /transport error/);
  assert.ok(!stderr.includes(configuration.clientSecret));
  await assert.rejects(stat(f.connection.stateDirectory), { code: 'ENOENT' });
});
