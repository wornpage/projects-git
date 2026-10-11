import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createApplication } from '../src/local/server.mjs';
import { digest, requirementsDigest, CHECK_FORMAT } from '../src/core/check-definition.mjs';
import { candidateOutcome, taskOutcome, taskQueued, independentlyVerified, locationSearch, readLocation } from '../public/workbench-state.js';

const image = process.env.PROJECTS_SANDBOX_TEST_IMAGE;
const script = fileURLToPath(new URL('../scripts/repository-work.mjs', import.meta.url));
const execute = promisify(execFile);
const git = (repo, ...args) => execFileSync('git', ['-c', 'user.name=CLI test', '-c', 'user.email=qa@localhost.invalid', '-c', 'core.autocrlf=false', ...args],
  { cwd: repo, windowsHide: true, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const brief = title => ({ title, purpose: 'Return the declared text', criteria: ['Print the declared text'], owner: 'CLI test owner' });

async function invoke(args, expected = 0) {
  let result;
  try { result = { ...await execute(process.execPath, [script, ...args], { windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024 }), code: 0 }; }
  catch (error) { result = error; }
  assert.equal(result.code, expected, result.stderr || result.message);
  return { ...result, json: result.stdout?.startsWith('{') ? JSON.parse(result.stdout) : null };
}

async function setup(t, titles = ['First task']) {
  const root = await mkdtemp(path.join(tmpdir(), 'projects-cli-tests-')), source = path.join(root, 'source'), dataDir = path.join(root, 'workspace');
  await mkdir(source); git(source, 'init', '-b', 'main');
  await writeFile(path.join(source, 'main.mjs'), 'console.log("base");\n');
  git(source, 'add', '.'); git(source, 'commit', '-m', 'Initial CLI fixture');
  const base = git(source, 'rev-parse', 'HEAD'), sourceRefs = git(source, 'show-ref');
  const app = createApplication({ dataDir }); await app.ready;
  const requests = [];
  app.server.prependListener('request', request => requests.push({ method: request.method, path: request.url }));
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const url = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    await app.close(); assert.equal(git(source, 'show-ref'), sourceRefs);
    assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep)); await rm(root, { recursive: true, force: true });
  });
  const file = async (name, value) => { const filename = path.join(root, name); await writeFile(filename, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)); return filename; };
  const cli = async (args, expected = 0) => invoke([...args, '--url', url], expected);
  const request = async (endpoint, body, expected = 200) => {
    const response = await fetch(url + endpoint, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const result = await response.json(); assert.equal(response.status, expected, JSON.stringify(result)); return result;
  };
  const stack = await file('tasks.json', { tasks: titles.map(brief) });
  const connectArgs = ['connect', '--repo', source, '--base', base, '--project-name', 'CLI fixture', '--brief', stack, '--request-id', crypto.randomUUID()];
  const connected = (await cli(connectArgs)).json;
  return { root, source, base, dataDir, url, requests, file, cli, request, connected, connectArgs };
}

async function compareSelectors(f, projectId = f.connected.projectId) {
  const state = await f.request('/api/workspace'), status = (await f.cli(['status', '--project', projectId])).json;
  const tasks = state.tasks.filter(task => task.projectId === projectId), runs = state.runs.filter(run => tasks.some(task => task.id === run.taskId));
  assert.deepEqual(status.queue, tasks.filter(task => taskQueued(state, task)).map(task => task.id));
  for (const task of tasks) {
    const summary = status.tasks.find(item => item.taskId === task.id), outcome = taskOutcome(state, task);
    assert.deepEqual(summary.outcome, outcome); assert.equal(summary.queued, taskQueued(state, task));
    assert.equal(summary.browserUrl, new URL(locationSearch(outcome.view, task.id, outcome.runId), f.url).href);
  }
  for (const run of runs) {
    const summary = status.candidates.find(item => item.runId === run.id);
    assert.deepEqual(summary.outcome, candidateOutcome(state, run));
    assert.equal(summary.verification.independentlyVerified, independentlyVerified(state, run));
    assert.deepEqual(readLocation(new URL(summary.browserUrl).search), { view: run.status === 'merged' ? 'evidence' : ['assigned', 'running'].includes(run.status) ? 'work' : 'review', taskId: run.taskId, runId: run.id });
    for (const rule of state.coordination[run.id].acceptance.filter(rule => !rule.met)) assert.ok(summary.blockers.some(blocker => blocker.code === rule.code));
    const task = tasks.find(task => task.id === run.taskId);
    if (['accepted', 'merged', 'superseded'].includes(run.status) || task.acceptedRunId && task.acceptedRunId !== run.id) {
      assert.deepEqual(summary.nextActions, [summary.outcome.next], 'Completed and retained states do not prompt acceptance again');
    }
  }
  assert.equal(status.counters.acceptedCandidates.denominator, runs.length);
  assert.equal(status.counters.currentIndependentReports.numerator, runs.filter(run => independentlyVerified(state, run)).length);
  assert.equal(status.counters.reportedChecks.denominator, runs.reduce((sum, run) => sum + (run.evidence?.total ?? 0), 0));
  assert.equal(status.counters.mergedTasks.denominator, tasks.length);
  return status;
}

async function claim(f, label) {
  return (await f.cli(['claim', '--project', f.connected.projectId, '--label', label, '--request-id', crypto.randomUUID()])).json;
}

async function submit(f, run, filename, content) {
  await f.cli(['start', '--run', run.runId]);
  await writeFile(path.join(run.checkout, filename), content);
  git(run.checkout, 'add', filename); git(run.checkout, 'commit', '-m', 'CLI candidate ' + filename);
  run.headCommit = git(run.checkout, 'rev-parse', 'HEAD');
  const result = (await f.cli(['submit', '--run', run.runId, '--head', run.headCommit, '--summary', 'Candidate submitted by a real CLI subprocess'])).json;
  assert.equal(result.headCommit, run.headCommit); assert.equal(result.checks, null);
  return result;
}

async function check(f, run, filename, content, expectedExit = 0) {
  const task = (await f.cli(['show', '--task', run.taskId])).json.task;
  const definition = JSON.stringify({ format: CHECK_FORMAT, commit: run.headCommit, taskRevision: task.revision, requirementsSha256: requirementsDigest(task), timeoutMs: 15000,
    checks: [{ name: 'Declared file content', argv: ['node', '-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(filename)},'utf8'))`], stdin: '', expected: { exitCode: 0, stdout: content } }] });
  const checks = await f.file(run.runId + '.checks.json', definition);
  return (await f.cli(['check', '--run', run.runId, '--checks', checks, '--checks-sha256', digest(definition), '--image', image], expectedExit)).json;
}

// These API requests simulate the existing browser decisions in an isolated test
// workspace. The CLI deliberately exposes neither acceptance nor merge commands.
async function accept(f, run) {
  const state = await f.request('/api/workspace'), task = state.tasks.find(task => task.id === run.taskId);
  return f.request(`/api/runs/${run.runId}/review`, { decision: 'accept', reviewer: 'Isolated browser fixture', note: 'Inspected candidate and evidence',
    headCommit: run.headCommit, taskRevision: task.revision, ownerVersion: task.ownerVersion,
    comparisons: state.coordination[run.runId].overlaps.map(({ runId, headCommit }) => ({ runId, headCommit })) });
}

test('idle claims refuse missing labels without retaining an invalid request', { timeout: 90000 }, async t => {
  const f = await setup(t);
  await f.cli(['claim','--project',f.connected.projectId,'--label','Existing agent','--request-id',crypto.randomUUID()]);
  const before = await f.request('/api/workspace');
  await f.request('/api/projects/'+f.connected.projectId+'/claim',{requestId:crypto.randomUUID()},422);
  const after = await f.request('/api/workspace');
  assert.equal(after.version,before.version);assert.deepEqual(after.agentClaims,before.agentClaims);
});

test('real CLI skips dependent tasks and unblocks only after verified deliberate integration', { timeout: 180000, skip: !image }, async t => {
  const f = await setup(t, ['Foundation']);
  const project = f.connected.projectId, prerequisite = f.connected.taskId;
  const stack = await f.file('dependent-stack.json', { tasks: [{ ...brief('Dependent'), dependsOn: [prerequisite] }, brief('Independent')] });
  const queued = (await f.cli(['queue', '--project', project, '--brief', stack, '--request-id', crypto.randomUUID()])).json;
  const claim = async label => (await f.cli(['claim', '--project', project, '--label', label, '--request-id', crypto.randomUUID()])).json;
  const foundation = await claim('Foundation agent');
  const independent = await claim('Independent agent');
  assert.equal(independent.taskId, queued.taskIds[1]);
  await f.cli(['assign', '--task', queued.taskIds[0], '--label', 'Too early', '--request-id', crypto.randomUUID()], 1);
  await f.cli(['fail', '--run', independent.runId, '--message', 'Bounded scripted workflow fixture stopped this assignment.']);
  const idleArgs = ['claim', '--project', project, '--label', 'Waiting agent', '--request-id', crypto.randomUUID()];
  const idle = (await f.cli(idleArgs)).json;
  assert.equal(idle.idle, true); assert.deepEqual(idle.waitingTaskIds, [queued.taskIds[0]]);
  const status = (await f.cli(['status', '--project', project])).json;
  assert.deepEqual(status.waitingQueue, [queued.taskIds[0]]); assert.equal(status.counters.waitingQueuedTasks.denominator, 3);
  await submit(f, foundation, 'foundation.txt', 'foundation\n');
  await check(f, foundation, 'foundation.txt', 'foundation\n');
  await accept(f, foundation);
  await f.cli(['assign', '--task', queued.taskIds[0], '--label', 'Still waiting', '--request-id', crypto.randomUUID()], 1);
  await f.request(`/api/runs/${foundation.runId}/merge`, { headCommit: foundation.headCommit });
  assert.equal((await f.cli(idleArgs)).json.idle, true, 'An idle request result remains stable after integration');
  const dependent = await claim('Dependent agent');
  assert.equal(dependent.taskId, queued.taskIds[0]); assert.equal(dependent.baseCommit, foundation.headCommit);
  assert.equal(await readFile(path.join(dependent.checkout, 'foundation.txt'), 'utf8'), 'foundation\n');
  await compareSelectors(f);
});

test('global and command help need no URL; invalid local inputs make no request', { timeout: 90000 }, async t => {
  const help = await invoke(['--help']); assert.match(help.stdout, /Acceptance and merge are controlled by the owner in the app/); assert.equal(help.stderr, '');
  for (const command of ['projects', 'status', 'connect', 'queue', 'claim', 'assign', 'show', 'revise', 'admission', 'start', 'submit', 'fail', 'check', 'recheck', 'update-base']) {
    assert.match((await invoke([command, '--help'])).stdout, new RegExp(`repository-work.mjs ${command} `));
  }
  const f = await setup(t), count = f.requests.length, task = f.connected.taskId;
  for (const value of ['0', '-1', '1.5', '1e2', 'NaN', '9007199254740992']) {
    const result = await f.cli(['revise', '--task', task, '--expected-revision', value, '--brief', 'unused'], 1);
    assert.match(result.stderr, /safe positive integer/); assert.equal(result.stdout, '');
  }
  assert.match((await f.cli(['admission', '--project', f.connected.projectId, '--expected-version', '1', '--state', 'paused'], 1)).stderr, /on or off/);
  assert.match((await f.cli(['recheck', '--run', crypto.randomUUID(), '--head', f.base, '--revision', '0'], 1)).stderr, /safe positive integer/);
  assert.match((await f.cli(['update-base', '--run', crypto.randomUUID(), '--head', f.base, '--revision', '1', '--mode', 'retry'], 1)).stderr, /reapply or resolve/);
  const malformed = await f.file('bad.json', Buffer.from([0x7b, 0xff, 0x7d])), oversized = await f.file('large.json', ' '.repeat(128 * 1024 + 1));
  for (const [filename, expression] of [[malformed, /valid UTF-8 JSON/], [oversized, /exceeds 128 KiB/]]) {
    assert.match((await f.cli(['revise', '--task', task, '--expected-revision', '1', '--brief', filename], 1)).stderr, expression);
  }
  assert.match((await f.cli(['check', '--run', crypto.randomUUID(), '--checks', malformed, '--checks-sha256', '0'.repeat(64), '--image', 'unused'], 1)).stderr, /valid UTF-8 JSON/);
  for (const url of ['https://127.0.0.1', 'http://example.com', f.url + '/api/workspace', f.url + '?token=x', f.url.replace('http://', 'http://user:pass@')]) {
    assert.match((await invoke(['projects', '--url', url], 1)).stderr, /loopback workspace origin/);
  }
  assert.equal(f.requests.length, count, 'Input validation happens before any workspace request');
  assert.match((await invoke(['merge', '--run', task], 1)).stderr, /browser operations/);
  for (const projectId of ['__proto__', 'constructor', 'toString', crypto.randomUUID()]) {
    const missing = await f.cli(['status', '--project', projectId], 1);
    assert.match(missing.stderr, /Project not found.*projects/); assert.equal(missing.stdout, '');
  }
});

test('non-JSON and redirected responses retain unknown outcomes without body reflection or mutation retries', { timeout: 30000 }, async t => {
  let mode = 'non-json'; const requests = [], runId = crypto.randomUUID(), taskId = crypto.randomUUID();
  const server = createServer((request, response) => {
    requests.push({ method: request.method, path: request.url });
    if (mode === 'redirect') { response.writeHead(302, { Location: '/redirect-target' }); response.end(); }
    else if (mode === 'readback' && request.method === 'POST') {
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ runId, taskId, checkout: 'retained-checkout', branch: 'retained-branch', baseCommit: 'a'.repeat(40) }));
    } else { response.setHeader('Content-Type', 'text/html'); response.end('<p>PRIVATE_RESPONSE_SENTINEL</p>'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const nonJson = await invoke(['start', '--url', url, '--run', runId], 1);
  assert.match(nonJson.stderr, /non-JSON response.*mutation outcome is unknown/); assert.doesNotMatch(nonJson.stderr, /PRIVATE_RESPONSE_SENTINEL/);
  assert.equal(requests.length, 1); assert.equal(nonJson.stdout, '');
  mode = 'redirect';
  assert.match((await invoke(['start', '--url', url, '--run', runId], 1)).stderr, /mutation outcome is unknown/);
  assert.equal(requests.length, 2, 'Redirect destinations are never followed');
  mode = 'readback';
  const readback = await invoke(['claim', '--url', url, '--project', taskId, '--label', 'Readback fixture', '--request-id', crypto.randomUUID()], 1);
  assert.match(readback.stderr, /request succeeded/); assert.ok(readback.stderr.includes(runId)); assert.doesNotMatch(readback.stderr, /PRIVATE_RESPONSE_SENTINEL/);
  assert.deepEqual(requests.slice(2).map(request => request.method), ['POST', 'GET'], 'A failed readback retains the successful mutation receipt without replay');
});

test('discovery, queued stacks and concurrent idempotent claims preserve IDs and visible denominators', { timeout: 90000 }, async t => {
  const f = await setup(t, ['First', 'Second']);
  assert.equal((await f.cli(f.connectArgs)).json.taskId, f.connected.taskId);
  const discovered = (await f.cli(['projects'])).json.projects;
  assert.equal(discovered.length, 1); assert.equal(discovered[0].id, f.connected.projectId); assert.equal(discovered[0].name, 'CLI fixture');
  assert.equal(discovered[0].admission, 'on'); assert.equal(discovered[0].policyVersion, 1);
  const queueArgs = ['queue', '--project', f.connected.projectId, '--brief', await f.file('extra.json', { tasks: [brief('Third')] }), '--request-id', crypto.randomUUID()];
  const queued = (await f.cli(queueArgs)).json; assert.deepEqual((await f.cli(queueArgs)).json.taskIds, queued.taskIds);
  const claims = ['Agent A', 'Agent B'].map(label => ['claim', '--project', f.connected.projectId, '--label', label, '--request-id', crypto.randomUUID()]);
  const before = f.requests.filter(request => request.method === 'POST' && request.path.endsWith('/claim')).length;
  const results = await Promise.all(claims.map(args => execute(process.execPath, [script, ...args, '--url', f.url], { windowsHide: true }).then(result => ({ ...result, code: 0 }), error => error)));
  assert.equal(f.requests.filter(request => request.method === 'POST' && request.path.endsWith('/claim')).length - before, 2, 'Concurrent clients never retry mutations automatically');
  const runs = [];
  for (const [index, result] of results.entries()) {
    if (result.code !== 0) { assert.equal(result.code, 1); assert.match(result.stderr, /repository_busy/); }
    const replay = (await f.cli(claims[index])).json;
    if (result.code === 0) assert.equal(replay.runId, JSON.parse(result.stdout).runId);
    runs.push(replay);
  }
  assert.equal(new Set(runs.map(run => run.runId)).size, 2); assert.equal(new Set(runs.map(run => run.taskId)).size, 2);
  for (const run of runs) { assert.ok(run.checkout && run.branch && run.baseCommit); assert.equal(run.candidate.runId, run.runId); }
  const status = await compareSelectors(f);
  assert.equal(status.queue.length, 1); assert.equal(status.activeCandidates.length, 2);
  assert.equal(status.counters.queuedTasks.denominator, 3); assert.equal(status.capacity.occupied, 2);
  const shown = (await f.cli(['show', '--task', runs[0].taskId])).json;
  assert.equal(shown.task.id, runs[0].taskId); assert.equal(shown.requirementsSha256, requirementsDigest(shown.task));
  assert.equal(shown.candidates[0].repository, runs[0].checkout, 'Existing show fields are retained');
  const differentLabel = [...claims[0]]; differentLabel[4] = 'Different agent';
  assert.match((await f.cli(differentLabel, 1)).stderr, /idempotency_conflict/);
  await claim(f, 'Agent C');
  const idle = await claim(f, 'Agent D'); assert.equal(idle.idle, true); assert.match(idle.reason, /No unassigned/);
});

test('admission pause/resume and requirement CAS are actionable and preserve in-flight work', { timeout: 90000 }, async t => {
  const f = await setup(t, ['First', 'Second']), run = await claim(f, 'In-flight agent');
  await f.cli(['start', '--run', run.runId]);
  const paused = (await f.cli(['admission', '--project', f.connected.projectId, '--expected-version', '1', '--state', 'off'])).json;
  assert.equal(paused.project.policyVersion, 2); assert.equal(paused.project.admission, 'off');
  assert.match(paused.admissionEffect, /New assignments and starts are paused.*Existing runs continue under their chat host/);
  assert.equal(paused.activeCandidates.find(candidate => candidate.runId === run.runId).status, 'running');
  assert.match((await f.cli(['claim', '--project', f.connected.projectId, '--label', 'Paused agent', '--request-id', crypto.randomUUID()], 1)).stderr, /project_paused.*[\s\S]*policyVersion/);
  assert.match((await f.cli(['assign', '--task', run.taskId, '--label', 'Paused alternative', '--request-id', crypto.randomUUID()], 1)).stderr, /project_paused/);
  const stack = await f.file('paused-stack.json', { tasks: [brief('Third')] });
  await f.cli(['queue', '--project', f.connected.projectId, '--brief', stack, '--request-id', crypto.randomUUID()]);
  await writeFile(path.join(run.checkout, 'main.mjs'), 'console.log("finished while paused");\n');
  git(run.checkout, 'add', '.'); git(run.checkout, 'commit', '-m', 'Finish while paused'); run.headCommit = git(run.checkout, 'rev-parse', 'HEAD');
  assert.equal((await f.cli(['submit', '--run', run.runId, '--head', run.headCommit, '--summary', 'In-flight work completed'])).json.status, 'awaiting_review');
  const stalePolicy = await f.cli(['admission', '--project', f.connected.projectId, '--expected-version', '1', '--state', 'on'], 1);
  assert.match(stalePolicy.stderr, /stale_project_policy/); assert.match(stalePolicy.stderr, /No automatic retry/);
  assert.equal((await f.cli(['projects'])).json.projects[0].policyVersion, 2);
  await f.cli(['admission', '--project', f.connected.projectId, '--expected-version', '2', '--state', 'on']);
  const assigned = await claim(f, 'Second agent');
  const revision = await f.file('revision.json', { purpose: 'Updated result', criteria: ['Updated criterion'], reason: 'Clarified while assigned', expectedRevision: 999 });
  assert.equal((await f.cli(['revise', '--task', assigned.taskId, '--expected-revision', '1', '--brief', revision])).json.task.revision, 2);
  assert.match((await f.cli(['start', '--run', assigned.runId], 1)).stderr, /stale_requirements/);
  assert.match((await f.cli(['revise', '--task', assigned.taskId, '--expected-revision', '1', '--brief', revision], 1)).stderr, /stale_requirements.*[\s\S]*show/);
  assert.equal((await f.cli(['show', '--task', assigned.taskId])).json.task.revision, 2);
  assert.equal((await f.cli(['fail', '--run', assigned.runId, '--message', 'Retained stale assignment'])).json.status, 'failed');
  await compareSelectors(f);
});

test('real independent checks distinguish failed checks, retained rechecks and revision-invalidated acceptance', { skip: !image, timeout: 180000 }, async t => {
  const f = await setup(t), run = await claim(f, 'Checked agent'), content = 'console.log("candidate");\n';
  await submit(f, run, 'main.mjs', content);
  const failed = await check(f, run, 'main.mjs', 'wrong expectation', 1);
  assert.equal(failed.checks.verified, true); assert.equal(failed.verification.independentlyVerified, true);
  assert.equal(failed.verification.currentChecksPassing, false); assert.equal(failed.outcome.label, 'Checks failed');
  assert.ok(failed.blockers.some(blocker => blocker.code === 'checks_failed'));
  assert.equal((await f.cli(['recheck', '--run', run.runId, '--head', run.headCommit, '--revision', '1'], 1)).json.outcome.label, 'Checks failed');
  await compareSelectors(f);
  await check(f, run, 'main.mjs', content); await accept(f, run);
  const old = (await f.cli(['show', '--task', run.taskId])).json.candidates[0];
  assert.deepEqual(old.nextActions, [old.outcome.next]);
  const revision = await f.file('new-requirements.json', { purpose: 'Updated purpose', criteria: ['Retain declared text'], reason: 'Changed requirements after review' });
  const revised = (await f.cli(['revise', '--task', run.taskId, '--expected-revision', '1', '--brief', revision])).json;
  assert.equal(revised.task.acceptedRunId, null); assert.equal(revised.task.revision, 2);
  assert.equal(revised.candidates[0].evidence.verifiedAt, old.evidence.verifiedAt);
  assert.equal(revised.candidates[0].decisionHistory.length, 1); assert.equal(revised.candidates[0].verification.independentlyVerified, false);
  assert.equal(revised.candidates[0].outcome.label, 'Recheck needed');
  assert.equal(revised.candidates[0].verification.reportedChecksPassing, true);
  assert.match((await f.cli(['recheck', '--run', run.runId, '--head', run.headCommit, '--revision', '1'], 1)).stderr, /stale_verification/);
  const unbound = await f.cli(['recheck', '--run', run.runId, '--head', run.headCommit, '--revision', '2'], 1);
  assert.match(unbound.stderr, /check_definition_invalid/); assert.match(unbound.stderr, /explicitly configure check/);
  assert.equal((await f.cli(['show', '--task', run.taskId])).json.candidates[0].evidence.verifiedAt, old.evidence.verifiedAt);
  const stale = await compareSelectors(f); assert.equal(stale.counters.reportedChecks.numerator, 1); assert.equal(stale.counters.currentPassingCandidates.numerator, 0);
  await check(f, run, 'main.mjs', content);
  assert.equal((await f.cli(['recheck', '--run', run.runId, '--head', run.headCommit, '--revision', '2'])).json.verification.currentChecksPassing, true);
  assert.equal((await compareSelectors(f)).counters.acceptedCandidates.numerator, 0, 'Checks do not accept the candidate');
});

test('base reapply carries checks without results and conflicts return a fresh resolution checkout', { skip: !image, timeout: 240000 }, async t => {
  const f = await setup(t, ['First', 'Disjoint', 'Conflict']);
  const first = await claim(f, 'First agent'), disjoint = await claim(f, 'Disjoint agent'), conflict = await claim(f, 'Conflict agent');
  for (const [run, filename, content] of [[first, 'main.mjs', 'console.log("first");\n'], [disjoint, 'README.md', 'Usage\n'], [conflict, 'main.mjs', 'console.log("conflict");\n']]) {
    await submit(f, run, filename, content); await check(f, run, filename, content);
  }
  await accept(f, first); await f.request(`/api/runs/${first.runId}/merge`, { headCommit: first.headCommit });
  const advanced = await compareSelectors(f);
  assert.equal(advanced.tasks.find(task => task.taskId === disjoint.taskId).outcome.label, 'Update base needed');
  assert.ok(advanced.candidates.find(run => run.runId === disjoint.runId).blockers.some(blocker => blocker.code === 'project_advanced'));
  const reapplied = (await f.cli(['update-base', '--run', disjoint.runId, '--head', disjoint.headCommit, '--revision', '1', '--mode', 'reapply'])).json;
  assert.equal(reapplied.revision, 2); assert.equal(reapplied.baseCommit, first.headCommit); assert.equal(reapplied.candidate.checks, null);
  assert.equal(reapplied.candidate.verification.independentlyVerified, false); assert.equal(reapplied.previousCandidate.status, 'superseded');
  assert.equal(reapplied.previousCandidate.checks.passed, 1); assert.ok(reapplied.instructions[0].includes('recheck'));
  const rechecked = (await f.cli(['recheck', '--run', reapplied.runId, '--head', reapplied.candidate.headCommit, '--revision', '2'])).json;
  assert.equal(rechecked.verification.currentChecksPassing, true, 'Reapply explicitly rebinds the retained definition');
  assert.equal((await compareSelectors(f)).counters.acceptedCandidates.denominator, 4);
  const before = await f.request('/api/workspace');
  const conflictError = await f.cli(['update-base', '--run', conflict.runId, '--head', conflict.headCommit, '--revision', '1', '--mode', 'reapply'], 1);
  assert.match(conflictError.stderr, /base_update_conflict/); assert.match(conflictError.stderr, /--mode resolve/);
  assert.equal((await f.request('/api/workspace')).version, before.version);
  const resolution = (await f.cli(['update-base', '--run', conflict.runId, '--head', conflict.headCommit, '--revision', '1', '--mode', 'resolve'])).json;
  const state = await f.request('/api/workspace'), replacement = state.runs.find(run => run.id === resolution.runId);
  assert.equal(resolution.checkout, replacement.repository); assert.equal(resolution.branch, replacement.branch);
  assert.equal(resolution.revision, 2); assert.equal(resolution.baseCommit, first.headCommit); assert.equal(resolution.candidate.status, 'assigned');
  assert.equal(resolution.previousCandidate.status, 'superseded'); assert.equal(resolution.previousCandidate.checks.passed, 1);
  assert.ok(resolution.instructions.some(instruction => instruction.includes(resolution.checkout) && instruction.includes(resolution.branch)));
  assert.equal(await readFile(path.join(resolution.checkout, 'main.mjs'), 'utf8'), 'console.log("first");\n');
  await f.cli(['start', '--run', resolution.runId]);
  const status = await compareSelectors(f); assert.equal(status.counters.acceptedCandidates.denominator, 5);
  assert.equal(status.counters.reportedChecks.denominator, 4, 'Superseded reports stay in the denominator');
});
