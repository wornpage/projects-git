import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { spawnSync } from 'node:child_process';
import { createApplication } from '../src/local/server.mjs';
import { createWorkspace, createTask, assignRun } from '../src/core/workflow.mjs';
import { GitRunner } from '../src/local/git-runner.mjs';
import { readTaskHandoff } from '../src/core/handoff.mjs';

async function fixture(t, options = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'projects-agent-git-http-'));
  const app = createApplication({ dataDir, ...options });
  await app.ready;
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const url = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    await app.close();
    assert.ok(resolve(dataDir).startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/')));
    rmSync(dataDir, { recursive: true, force: true });
  });
  const post = (path, value) => fetch(`${url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url }, body: JSON.stringify(value) });
  return { ...app, url, dataDir, post };
}

test('catalog HTTP errors preserve the explicit bounded-query and unavailable-page contracts',async t=>{
 const f=await fixture(t),get=path=>fetch(f.url+path);
 const first=await get('/api/projects/catalog');assert.equal(first.status,200);const catalog=await first.json();
 assert.ok(Array.isArray(catalog.items));assert.ok(Number.isSafeInteger(catalog.total));
 const invalid=await get('/api/projects/catalog?limit=0');assert.equal(invalid.status,400);assert.equal((await invalid.json()).error.code,'INVALID_PROJECT_CATALOG');
 const missing=await get('/api/projects/catalog?offset=100000');assert.equal(missing.status,409);assert.equal((await missing.json()).error.code,'PROJECT_CATALOG_PAGE_UNAVAILABLE');
});

test('HTTP demo performs two real candidates, requires review, and retains the actual merge', { timeout: 60000 }, async t => {
  const app = await fixture(t);
  const initial = await (await fetch(`${app.url}/api/workspace`)).json();
  assert.equal(initial.tasks.length, 0);
  assert.equal(initial.execution.inference, false);
  assert.equal(initial.capabilities.providerVerified, false);
  const kickoff = await app.post('/api/tasks', { source: 'sample' });
  assert.equal(kickoff.status, 202);
  await app.waitForJobs();
  const state = await (await fetch(`${app.url}/api/workspace`)).json();
  assert.equal(state.runs.length, 2);
  assert.equal(state.tasks[0].status, 'review');
  assert.equal(new Set(state.runs.map(run => run.headCommit)).size, 2);
  const good = state.runs.find(run => run.agent === 'careful');
  const bad = state.runs.find(run => run.agent === 'fast');
  assert.equal(good.evidence.passed, good.evidence.total);
  assert.ok(bad.evidence.passed < bad.evidence.total);
  const handoffResponse = await fetch(`${app.url}/api/tasks/${good.taskId}/handoff`);
  assert.equal(handoffResponse.status, 200);
  assert.equal(handoffResponse.headers.get('cache-control'), 'no-store');
  const handoff = await readTaskHandoff(await handoffResponse.text());
  assert.equal(handoff.payload.runs.length, 2);
  assert.equal(handoff.payload.recordedMetrics.checks.passed, good.evidence.passed + bad.evidence.passed);
  assert.equal(app.snapshot().version, state.version, 'Export does not mutate the workspace.');
  assert.ok(Date.parse(good.startedAt) <= Date.parse(bad.finishedAt));
  assert.ok(Date.parse(bad.startedAt) <= Date.parse(good.finishedAt));
  assert.equal((await app.post(`/api/runs/${good.id}/merge`, { headCommit: good.headCommit })).status, 409);
  assert.equal((await app.post(`/api/runs/${bad.id}/review`, { decision: 'accept', ownerVersion: 1, headCommit: bad.headCommit, reviewer: 'Reviewer', note: 'Looks fine.' })).status, 409);
  assert.equal((await app.post(`/api/runs/${bad.id}/review`, { decision: 'reject', headCommit: bad.headCommit, reviewer: 'Reviewer', note: 'Invalid quantities remain accepted by this implementation.' })).status, 200);
  const accepted = await app.post(`/api/runs/${good.id}/review`, { decision: 'accept', ownerVersion: 1, headCommit: good.headCommit, reviewer: 'Reviewer', note: 'The diff meets the criteria and all independent checks pass.' });
  assert.equal(accepted.status, 200);
  const acceptedState = await accepted.json();
  assert.equal(acceptedState.tasks[0].status, 'accepted');
  const acceptedEvidence = structuredClone(acceptedState.runs.find(run => run.id === good.id).evidence);
  const merged = await app.post(`/api/runs/${good.id}/merge`, { headCommit: good.headCommit });
  assert.equal(merged.status, 200);
  const final = await merged.json();
  assert.equal(final.tasks[0].mergedCommit, good.headCommit);
  assert.deepEqual(final.runs.find(run => run.id === good.id).evidence, acceptedEvidence);
  assert.equal(final.runs.find(run => run.id === good.id).evidenceHistory.at(-1).operation, 'merge');
  assert.ok(final.runs.find(run => run.id === good.id).evidenceHistory.at(-1).attemptId);
  assert.deepEqual(final.mergeStateByRun, {});
  assert.equal(final.runs.find(run => run.id === bad.id).status, 'rejected');
  assert.deepEqual(final.metrics.acceptedCandidates, { numerator: 1, denominator: 2 });
  const retained = JSON.parse(readFileSync(join(app.dataDir, 'workspace.json'), 'utf8'));
  assert.equal(retained.tasks[0].status, 'merged');
  assert.equal(retained.events.at(-1).type, 'run.merged');
  const projectId = final.tasks[0].projectId;
  const queued = await app.post('/api/tasks', { source: 'project', projectId, requestId: crypto.randomUUID(), tasks: [
    { title: 'Add currency labels', purpose: 'Continue the starter as ordinary project work', criteria: ['Keep the accepted checkout behavior'], owner: 'Reviewer' }] });
  assert.equal(queued.status, 201);
  const claimed = await app.post(`/api/projects/${projectId}/claim`, { label: 'Follow-up agent', requestId: crypto.randomUUID() });
  assert.equal(claimed.status, 201);
  const checkout = await claimed.json();
  assert.equal(checkout.baseCommit, good.headCommit);
  assert.equal(app.snapshot().tasks[1].projectId, projectId);
  assert.equal(Object.keys(app.snapshot().projects).length, 1, 'Starter and follow-up share the same project.');
});

test('requirements revision retains commits, blocks stale acceptance and rechecks without new agents', { timeout: 60000 }, async t => {
  const app = await fixture(t);
  await app.post('/api/tasks', { source: 'sample' });
  await app.waitForJobs();
  const initial = app.snapshot();
  const task = initial.tasks[0];
  const run = initial.runs.find(run => run.agent === 'careful');
  const review = revision => app.post(`/api/runs/${run.id}/review`, { decision: 'accept', ownerVersion: 1, comparisons: initial.coordination[run.id].overlaps.map(({runId,headCommit}) => ({runId,headCommit})), reviewer: 'Automated API QA', note: 'Checked current criteria and exact commit.', headCommit: run.headCommit, taskRevision: revision });
  assert.equal((await review(1)).status, 200);
  const revised = await app.post(`/api/tasks/${task.id}/revise`, { expectedRevision: 1, purpose: task.purpose, criteria: [...task.criteria, 'Keep the public checkoutTotal export.'], reason: 'Clarify the public API requirement.' });
  assert.equal(revised.status, 200);
  assert.equal(app.snapshot().runs.find(item => item.id === run.id).headCommit, run.headCommit);
  assert.equal((await review(2)).status, 409);
  assert.equal((await app.post(`/api/runs/${run.id}/merge`, { headCommit: run.headCommit })).status, 409);
  assert.equal((await app.post(`/api/runs/${run.id}/verify`, { headCommit: run.headCommit, taskRevision: 2 })).status, 200);
  assert.equal((await review(2)).status, 200);
  const retained = app.snapshot().runs.find(item => item.id === run.id);
  assert.equal(retained.evidence.taskRevision, 2);
  assert.equal(retained.evidenceHistory.length, 1);
  assert.equal(retained.reviewHistory.length, 1);
  assert.equal(app.snapshot().runs.length, initial.runs.length);
});

test('HTTP ownership and overlap review bind acceptance without discarding alternative candidates', { timeout: 60000 }, async t => {
  const app = await fixture(t);
  await app.post('/api/tasks', { source: 'sample' }); await app.waitForJobs();
  const initial = app.snapshot(), task = initial.tasks[0], run = initial.runs.find(run => run.agent === 'careful');
  const input = { decision: 'accept', ownerVersion: 1, headCommit: run.headCommit, taskRevision: 1, reviewer: 'API coordination QA', note: 'Compared both implementations and required checks.' };
  const missing = await app.post(`/api/runs/${run.id}/review`, input);
  assert.equal(missing.status, 409); assert.equal((await missing.json()).error.code, 'comparison_required');
  const comparisons = initial.coordination[run.id].overlaps.map(({runId,headCommit}) => ({runId,headCommit}));
  assert.equal((await app.post(`/api/runs/${run.id}/review`, { ...input, comparisons })).status, 200);
  const changed = await app.post(`/api/tasks/${task.id}/owner`, { owner: 'Next owner', expectedOwnerVersion: 1 });
  assert.equal(changed.status, 200);
  const current = await changed.json();
  assert.equal(current.tasks[0].acceptedRunId, null);
  assert.equal(current.runs.find(item => item.id === run.id).reviewHistory[0].ownerVersion, 1);
  assert.equal((await app.post(`/api/tasks/${task.id}/owner`, { owner: 'Stale claimant', expectedOwnerVersion: 1 })).status, 409);
  assert.equal((await app.post(`/api/runs/${run.id}/review`, { ...input, comparisons })).status, 409);
  assert.equal((await app.post(`/api/runs/${run.id}/merge`, { headCommit: run.headCommit })).status, 409);
  assert.equal((await app.post(`/api/runs/${run.id}/review`, { ...input, ownerVersion: 2, comparisons })).status, 200);
  assert.deepEqual(app.snapshot().metrics.acceptedCandidates, { numerator: 1, denominator: 2 });
  assert.equal(app.snapshot().runs.length, 2);
});

test('local model start request key returns the original task after completion', { timeout: 60000 }, async t => {
  let calls = 0;
  const app = await fixture(t, { modelName: 'failure-fixture', modelProvider: async () => { calls++; throw new Error('Retained test failure'); }, sandbox: { ready: async () => {} } });
  const body = { candidates: 1, limits: { maxRequests: 1, maxInputBytes: 4096, maxOutputTokens: 512, timeoutMs: 5000 } };
  const start = input => fetch(`${app.url}/api/model-runs`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: app.url, 'Idempotency-Key': 'retained-model-start-one' }, body: JSON.stringify(input) });
  const first = await start(body);
  assert.equal(first.status, 202);
  const task = await first.json();
  await app.waitForJobs();
  assert.deepEqual(await (await start(body)).json(), task);
  assert.equal(calls, 1);
  assert.equal((await start({ ...body, candidates: 2 })).status, 409);
});

test('model API refuses absent configuration and missing budgets before dispatch', async t => {
  const unconfigured = await fixture(t);
  assert.equal((await unconfigured.post('/api/model-runs', { candidates: 1 })).status, 503);
  let calls = 0;
  const configured = await fixture(t, { modelName: 'test-model', modelProvider: async () => { calls++; }, sandbox: { ready: async () => {} } });
  assert.equal((await configured.post('/api/model-runs', { candidates: 1 })).status, 422);
  assert.equal((await configured.post('/api/model-runs', { candidates: 9 })).status, 422);
  assert.equal(calls, 0);
  assert.equal(configured.snapshot().tasks.length, 0);
});

test('concurrent model-provider failures retain both candidates, unknown usage and original allowance', { timeout: 60000 }, async t => {
  let active = 0, peak = 0, calls = 0;
  let release;
  const bothStarted = new Promise(resolve => { release = resolve; });
  const app = await fixture(t, { modelName: 'test-model', sandbox: { ready: async () => {} }, modelProvider: async () => {
    calls++; active++; peak = Math.max(peak, active);
    if (active === 2) release();
    await bothStarted;
    active--;
    throw new Error('Deterministic transport failure');
  } });
  const limits = { maxRequests: 2, maxInputBytes: 4096, maxOutputTokens: 512, timeoutMs: 10000 };
  const kickoff = await app.post('/api/model-runs', { candidates: 2, limits });
  assert.equal(kickoff.status, 202);
  await app.waitForJobs();
  const state = app.snapshot();
  assert.equal(peak, 2);
  assert.equal(calls, 2);
  assert.equal(state.runs.length, 2);
  assert.deepEqual(state.metrics.acceptedCandidates, { numerator: 0, denominator: 2 });
  for (const run of state.runs) {
    assert.equal(run.status, 'failed');
    assert.equal(run.execution.usageComplete, false);
    assert.deepEqual(run.execution.limits, limits);
    const receipt = JSON.parse(readFileSync(join(app.dataDir, 'attempts', `${run.id}.json`), 'utf8'));
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.requests.length, 1);
    assert.equal(receipt.requests[0].status, 'usage_unknown');
  }
});

test('local API rejects cross-origin writes, invalid UTF-8, oversized requests and non-loopback hosts', async t => {
  const app = await fixture(t);
  assert.equal((await fetch(`${app.url}/api/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://other.example' }, body: '{}' })).status, 403);
  assert.equal((await fetch(`${app.url}/api/tasks`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await fetch(`${app.url}/api/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: new Uint8Array([123, 34, 120, 34, 58, 34, 255, 34, 125]) })).status, 400);
  assert.equal((await app.post('/api/tasks', { long: 'x'.repeat(128 * 1024) })).status, 413);
  const wrongHost = await new Promise((done, reject) => {
    const request = httpRequest(`${app.url}/api/health`, { headers: { Host: 'attacker.example' } }, response => {
      response.resume();
      response.on('end', () => done(response.statusCode));
    });
    request.on('error', reject);
    request.end();
  });
  assert.equal(wrongHost, 403);
  assert.equal((await fetch(`${app.url}/.git/config`)).status, 404);
  assert.equal(app.snapshot().tasks.length, 0);
});

test('restart marks interrupted work failed and retains context instead of inventing completion', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'projects-agent-git-http-'));
  try {
    const state = createWorkspace();
    const task = createTask(state, { owner: 'Test coordinator', title: 'Interrupted work', purpose: 'Preserve evidence.', criteria: ['Run real checks.'], baseCommit: 'a'.repeat(40) });
    const run = assignRun(state, task.id, { agent: 'careful', label: 'Delta', branch: 'newwork/delta' });
    writeFileSync(join(dataDir, 'workspace.json'), JSON.stringify(state));
    const app = createApplication({ dataDir });
    await app.ready;
    assert.equal(app.snapshot().runs[0].id, run.id);
    assert.equal(app.snapshot().runs[0].status, 'failed');
    assert.equal(app.snapshot().runs[0].headCommit, null);
    assert.equal(app.snapshot().runs[0].evidence, null);
    await app.close();
  } finally {
    assert.ok(resolve(dataDir).startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/')));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('exclusive workspace ownership refuses a second controller before changing state', async t => {
  const app = await fixture(t);
  const before = readFileSync(join(app.dataDir, 'workspace.json'), 'utf8');
  assert.throws(() => createApplication({ dataDir: app.dataDir }), /already owned by process/);
  assert.equal(readFileSync(join(app.dataDir, 'workspace.json'), 'utf8'), before);
});

test('stale ownership locks remain intact and require deliberate removal', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'projects-agent-git-http-'));
  try {
    const stopped = spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
    assert.equal(stopped.status, 0);
    const owner = JSON.stringify({ pid: stopped.pid, nonce: 'retained-crash-lock' });
    writeFileSync(join(dataDir, 'server.lock'), owner);
    assert.throws(() => createApplication({ dataDir }), /workspace owner has stopped|already owned by process/);
    assert.equal(readFileSync(join(dataDir, 'server.lock'), 'utf8'), owner);
  } finally {
    assert.ok(resolve(dataDir).startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/')));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('restart reconciles an explicitly requested exact-head merge after Git moved but before the receipt persisted', { timeout: 60000 }, async t => {
  const app = await fixture(t);
  assert.equal((await app.post('/api/tasks', { source: 'sample' })).status, 202);
  await app.waitForJobs();
  const run = app.snapshot().runs.find(candidate => candidate.agent === 'careful');
  const accepted = await app.post(`/api/runs/${run.id}/review`, { decision: 'accept', ownerVersion: 1, comparisons: app.snapshot().coordination[run.id].overlaps.map(({runId,headCommit}) => ({runId,headCommit})), headCommit: run.headCommit, reviewer: 'Recovery QA', note: 'Reviewed exact commit and passing independent checks.' });
  assert.equal(accepted.status, 200);
  await app.close();
  const intent = { headCommit: run.headCommit, baseCommit: run.baseCommit, requestedAt: new Date().toISOString() };
  writeFileSync(join(app.dataDir, 'merge-intents.json'), JSON.stringify({ [run.id]: intent }));
  const runner = new GitRunner({ rootDir: join(app.dataDir, 'repositories') });
  await runner.initialize();
  await runner.mergeCandidate({ repository: run.repository, runId: run.id, headCommit: run.headCommit, baseCommit: run.baseCommit });
  assert.equal(JSON.parse(readFileSync(join(app.dataDir, 'workspace.json'), 'utf8')).tasks[0].status, 'accepted');
  const restarted = createApplication({ dataDir: app.dataDir });
  try {
    await restarted.ready;
    assert.equal(restarted.snapshot().tasks[0].status, 'merged');
    assert.equal(restarted.snapshot().tasks[0].mergedCommit, run.headCommit);
    assert.equal(restarted.snapshot().recovery.pendingMergeIntents, 0);
    assert.equal(restarted.snapshot().recovery.errors.length, 0);
  } finally { await restarted.close(); }
});

test('repository inspection reads committed HEAD without changing source or workspace and rejects cross-origin requests',async t=>{
  const app=await fixture(t),repo=join(app.dataDir,'inspection-source');
  const git=(...args)=>{const result=spawnSync('git',args,{cwd:app.dataDir,encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stderr);return result.stdout.trim();};
  git('init',repo);
  writeFileSync(join(repo,'note.txt'),'committed\n');
  git('-C',repo,'add','note.txt');
  git('-C',repo,'-c','user.name=Test','-c','user.email=test@localhost.invalid','commit','-m','Fixture');
  const head=git('-C',repo,'rev-parse','HEAD');
  writeFileSync(join(repo,'note.txt'),'unsaved work\n');
  const before=app.snapshot();
  const response=await app.post('/api/repositories/inspect',{repo});
  assert.equal(response.status,200);assert.equal((await response.json()).headCommit,head);
  assert.equal(readFileSync(join(repo,'note.txt'),'utf8'),'unsaved work\n');
  assert.equal(git('-C',repo,'rev-parse','HEAD'),head);assert.deepEqual(app.snapshot(),before);
  assert.equal((await app.post('/api/repositories/inspect',{repo:'relative/path'})).status,422);
  assert.equal((await app.post('/api/repositories/inspect',{repo:join(app.dataDir,'missing')})).status,422);
  const refused=await fetch(app.url+'/api/repositories/inspect',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://example.invalid'},body:JSON.stringify({repo})});
  assert.equal(refused.status,403);
});
