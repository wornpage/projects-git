import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createApplication } from '../src/local/server.mjs';
import { RepositoryRunner } from '../src/local/repository-runner.mjs';
import { digest, requirementsDigest, CHECK_FORMAT } from '../src/core/check-definition.mjs';

const image = process.env.PROJECTS_SANDBOX_TEST_IMAGE;
const git = (repo, ...args) => execFileSync('git', ['-c', 'user.name=External client QA', '-c', 'user.email=qa@localhost.invalid', '-c', 'core.autocrlf=false', ...args], { cwd: repo, windowsHide: true, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'projects-connected-tests-')), source = path.join(root, 'source'), dataDir = path.join(root, 'workspace');
  await mkdir(source); git(source, 'init', '-b', 'main');
  await writeFile(path.join(source, 'tags.mjs'), 'console.log(process.argv[2]);\n');
  git(source, 'add', '.'); git(source, 'commit', '-m', 'Initial tag normalizer');
  const baseCommit = git(source, 'rev-parse', 'HEAD');
  // Private untracked/dirty content must never enter the connected baseline.
  await writeFile(path.join(source, 'private.txt'), 'UNTRACKED');
  await writeFile(path.join(source, 'tags.mjs'), 'DIRTY CONTENT');
  const sourceRefs = git(source, 'show-ref');
  let app;
  const start = async () => {
    app = createApplication({ dataDir }); await app.ready; app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
    return `http://127.0.0.1:${app.server.address().port}`;
  };
  let origin = await start();
  const request = async (endpoint, body, expected = 200) => {
    const response = await fetch(origin + endpoint, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(90000) });
    const result = await response.json(); assert.equal(response.status, expected, JSON.stringify(result)); return result;
  };
  t.after(async () => { await app.close(); assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep)); await rm(root, { recursive: true, force: true }); });
  const input = { source: 'repository', requestId: crypto.randomUUID(), projectName: 'Tag service', repo: source, baseCommit,
    tasks: [{ title: 'Normalize tags', purpose: 'Trim and lowercase comma-separated tags.', criteria: ['Discard empty tags', 'Trim and lowercase tags'], owner: 'Test coordinator' }] };
  const connected = await request('/api/tasks', input, 201);
  return { root, dataDir, source, input, baseCommit, sourceRefs, connected, request, url: () => origin,
    restart: async checkpoint => { await app.close(); if (checkpoint) await writeFile(path.join(dataDir, 'workspace.json'), checkpoint); origin = await start(); } };
}

test('ordinary repository import and external assignments preserve source refs, dirty files and restart continuity', { timeout: 90000 }, async t => {
  const f = await setup(t);
  const a = await f.request(`/api/tasks/${f.connected.taskId}/agents`, { label: 'External A', requestId: crypto.randomUUID() }, 201);
  const b = await f.request(`/api/tasks/${f.connected.taskId}/agents`, { label: 'External B', requestId: crypto.randomUUID() }, 201);
  assert.notEqual(a.checkout, b.checkout);
  assert.equal(await readFile(path.join(a.checkout, 'tags.mjs'), 'utf8'), 'console.log(process.argv[2]);\n');
  await assert.rejects(readFile(path.join(a.checkout, 'private.txt')), { code: 'ENOENT' });
  await f.request(`/api/runs/${a.runId}/submit`, { headCommit: f.baseCommit, summary: 'Not started' }, 409);
  await f.request(`/api/runs/${a.runId}/start`, {});
  await f.request(`/api/runs/${b.runId}/start`, {});
  await f.restart();
  assert.equal((await f.request('/api/workspace')).runs.filter(run => run.status === 'running').length, 2);
  await writeFile(path.join(a.checkout, 'tags.mjs'), 'console.log("normalized");\n');
  git(a.checkout, 'add', '.'); git(a.checkout, 'commit', '-m', 'External candidate');
  const headCommit = git(a.checkout, 'rev-parse', 'HEAD');
  const state = await f.request(`/api/runs/${a.runId}/submit`, { headCommit, summary: 'Candidate from an external client' });
  assert.equal(state.runs[0].origin, 'external-agent'); assert.equal(state.runs[0].evidence, null);
  await f.request(`/api/runs/${a.runId}/submit`, { headCommit, summary: 'Duplicate submission' }, 409);
  assert.equal(git(f.source, 'show-ref'), f.sourceRefs);
  assert.equal(await readFile(path.join(f.source, 'tags.mjs'), 'utf8'), 'DIRTY CONTENT');
  assert.equal(git(f.connected.repository, 'rev-parse', 'refs/heads/main'), f.baseCommit);
});

test('external commits need pinned independent checks and a current review before owned-main merge', { skip: !image, timeout: 180000 }, async t => {
  const f = await setup(t);
  const a = await f.request(`/api/tasks/${f.connected.taskId}/agents`, { label: 'Correct parser', requestId: crypto.randomUUID() }, 201);
  const b = await f.request(`/api/tasks/${f.connected.taskId}/agents`, { label: 'Minimal parser', requestId: crypto.randomUUID() }, 201);
  for (const candidate of [a, b]) {
    await f.request(`/api/runs/${candidate.runId}/start`, {});
    await writeFile(path.join(candidate.checkout, 'tags.mjs'), candidate === a
      ? 'console.log(process.argv[2].split(",").map(s=>s.trim().toLowerCase()).filter(Boolean).join(","));\n'
      : 'console.log(process.argv[2].toLowerCase());\n');
    git(candidate.checkout, 'add', '.'); git(candidate.checkout, 'commit', '-m', 'External parser change');
    candidate.headCommit = git(candidate.checkout, 'rev-parse', 'HEAD');
    await f.request(`/api/runs/${candidate.runId}/submit`, { headCommit: candidate.headCommit, summary: 'External protocol test candidate' });
  }
  let state = await f.request('/api/workspace'), task = state.tasks[0];
  const review = candidate => ({ decision: 'accept', reviewer: 'QA', note: 'Compared both changes', headCommit: candidate.headCommit, taskRevision: task.revision, ownerVersion: task.ownerVersion,
    comparisons: state.coordination[candidate.runId].overlaps.map(({runId,headCommit}) => ({runId,headCommit})) });
  await f.request(`/api/runs/${a.runId}/review`, review(a), 409);
  for (const candidate of [a, b]) {
    const definition = JSON.stringify({ format: CHECK_FORMAT, commit: candidate.headCommit, taskRevision: task.revision, requirementsSha256: requirementsDigest(task), timeoutMs: 15000,
      checks: [{ name: 'Normalize nonempty tags', argv: ['node', 'tags.mjs', ' A, ,B '], stdin: '', expected: { exitCode: 0, stdout: 'a,b\n' } }] });
    await f.request(`/api/runs/${candidate.runId}/checks`, { definition, definitionSha256: '0'.repeat(64), image }, 422);
    state = await f.request(`/api/runs/${candidate.runId}/checks`, { definition, definitionSha256: digest(definition), image });
  }
  assert.equal(state.runs[0].evidence.passed, 1, JSON.stringify(state.runs[0].evidence));
  assert.equal(state.runs[1].evidence.passed, 0, JSON.stringify(state.runs[1].evidence));
  await f.request(`/api/runs/${b.runId}/review`, review(b), 409);
  await f.request(`/api/runs/${a.runId}/review`, { ...review(a), comparisons: [] }, 409);
  await f.request(`/api/runs/${a.runId}/review`, review(a));
  assert.equal(git(f.connected.repository, 'rev-parse', 'main'), f.baseCommit, 'Acceptance must not merge');
  await f.restart();
  state = await f.request(`/api/runs/${a.runId}/merge`, { headCommit: a.headCommit });
  assert.equal(state.tasks[0].mergedCommit, a.headCommit);
  assert.equal(git(f.connected.repository, 'rev-parse', 'main'), a.headCommit);
  assert.equal(git(f.source, 'show-ref'), f.sourceRefs);
  assert.equal(await readFile(path.join(f.source, 'tags.mjs'), 'utf8'), 'DIRTY CONTENT');
  assert.equal(state.runs.length, 2); assert.equal(state.metrics.checks.total, 2);
});

test('queued stacks, CLI claims and pause policy share durable, idempotent project state', { timeout: 90000 }, async t => {
  const f = await setup(t);
  const replay = await f.request('/api/tasks', f.input, 201);
  assert.equal(replay.taskId, f.connected.taskId);
  await f.request('/api/tasks', { ...f.input, projectName: 'Changed intent' }, 409);
  const invalid = await f.request('/api/tasks', { ...f.input, requestId: crypto.randomUUID(), repo: path.join(f.root, 'missing') }, 422);
  assert.equal(invalid.error.code, 'repository_import_refused');
  const pending = crypto.randomUUID();
  assert.deepEqual(await f.request(`/api/task-requests/${pending}/release`, {}), { released: true });
  await f.request('/api/tasks', { ...f.input, requestId: pending }, 410);
  assert.equal((await f.request(`/api/task-requests/${f.input.requestId}/release`, {})).result.taskId, f.connected.taskId);
  const brief = path.join(f.root, 'stack.json');
  await writeFile(brief, JSON.stringify({ tasks: [2, 3].map(index => ({ ...f.input.tasks[0], title: 'Queued task ' + index })) }));
  const execute = promisify(execFile);
  const cli = async args => JSON.parse((await execute(process.execPath, ['scripts/repository-work.mjs', ...args, '--url', f.url()], { windowsHide: true })).stdout);
  const queued = await cli(['queue', '--project', f.connected.projectId, '--brief', brief, '--request-id', crypto.randomUUID()]);
  assert.equal(queued.taskIds.length, 2);
  const claimId = crypto.randomUUID();
  const claimed = await cli(['claim', '--project', f.connected.projectId, '--label', 'CLI agent', '--request-id', claimId]);
  assert.equal(claimed.taskId, f.connected.taskId);
  await f.restart();
  assert.equal((await cli(['claim', '--project', f.connected.projectId, '--label', 'CLI agent', '--request-id', claimId])).runId, claimed.runId);
  let state = await f.request(`/api/projects/${f.connected.projectId}/policy`, { acceptingWork: false, expectedVersion: 1 });
  assert.equal(state.projects[f.connected.projectId].acceptingWork, false);
  const pausedEvent = state.events.at(-1);
  assert.equal(pausedEvent.type, 'project.policy_changed');
  assert.equal(pausedEvent.projectId, f.connected.projectId);
  await f.restart();
  state = await f.request('/api/workspace');
  assert.deepEqual(state.events.find(event => event.id === pausedEvent.id), pausedEvent, 'Project attribution survives persistence and restart');
  await f.request(`/api/projects/${f.connected.projectId}/claim`, { label: 'Paused', requestId: crypto.randomUUID() }, 409);
  await f.request(`/api/runs/${claimed.runId}/start`, {}, 409);
  await f.request('/api/tasks', { source: 'project', projectId: f.connected.projectId, requestId: crypto.randomUUID(), tasks: [f.input.tasks[0]] }, 201);
  await f.request(`/api/projects/${f.connected.projectId}/policy`, { acceptingWork: true, expectedVersion: 1 }, 409);
  assert.equal((await f.request('/api/workspace')).events.filter(event => event.type === 'project.policy_changed').length, 1, 'A stale policy write creates no audit event');
  await f.request(`/api/projects/${f.connected.projectId}/policy`, { acceptingWork: true, expectedVersion: 2 });
  await f.request(`/api/runs/${claimed.runId}/start`, {});
  // The CLI connect command uses the same stack contract and same retry key.
  const connection = await cli(['connect', '--repo', f.source, '--base', f.baseCommit, '--project-name', 'CLI project', '--brief', brief, '--request-id', crypto.randomUUID()]);
  assert.equal(connection.taskIds.length, 2);
});

for (const completedCheckout of [false, true]) test(`restart reconciles a ${completedCheckout ? 'finished' : 'missing'} checkout with its original claim`, { timeout: 90000 }, async t => {
  const f = await setup(t), requestId = crypto.randomUUID();
  const assign = RepositoryRunner.prototype.assign;
  let checkpoint;
  RepositoryRunner.prototype.assign = async function(task, run) {
    checkpoint = await readFile(path.join(f.dataDir, 'workspace.json'), 'utf8');
    if (!completedCheckout) throw new Error('Simulated interruption after durable reservation');
    return assign.call(this, task, run);
  };
  t.after(() => { RepositoryRunner.prototype.assign = assign; });
  const claim = { requestId, label: 'Crash checkpoint agent' };
  await f.request(`/api/projects/${f.connected.projectId}/claim`, claim, completedCheckout ? 201 : 500);
  RepositoryRunner.prototype.assign = assign;
  // Restore the actual pre-checkout durable checkpoint, preserving the Git files.
  await f.restart(checkpoint);
  let state = await f.request('/api/workspace');
  const original = state.runs[0];
  if (completedCheckout) {
    assert.equal(original.status, 'assigned'); assert.equal(original.checkoutState, 'ready');
    assert.equal((await f.request(`/api/projects/${f.connected.projectId}/claim`, claim, 201)).runId, original.id);
    assert.equal((await f.request('/api/workspace')).runs.length, 1);
  } else {
    assert.equal(original.status, 'failed'); assert.equal(original.checkoutState, 'failed');
    await f.request(`/api/projects/${f.connected.projectId}/claim`, claim, 409);
    const next = await f.request(`/api/projects/${f.connected.projectId}/claim`, { ...claim, requestId: crypto.randomUUID() }, 201);
    assert.equal(next.taskId, original.taskId); assert.notEqual(next.runId, original.id);
  }
});

test('parallel disjoint changes update their base, retain old evidence, and merge after new checks and review', { skip: !image, timeout: 180000 }, async t => {
  const f = await setup(t);
  await f.request('/api/tasks', { source: 'project', projectId: f.connected.projectId, requestId: crypto.randomUUID(), tasks: [
    { title: 'Document tags', purpose: 'Write usage notes', criteria: ['README contains tag guidance'], owner: 'Test coordinator' },
    { title: 'Follow-up', purpose: 'Use the completed changes', criteria: ['Both changes are present'], owner: 'Test coordinator' }] }, 201);
  const runs = [];
  for (const file of ['tags.mjs', 'README.md']) {
    const run = await f.request(`/api/projects/${f.connected.projectId}/claim`, { requestId: crypto.randomUUID(), label: 'Edit ' + file }, 201);
    runs.push(run);
    await f.request(`/api/runs/${run.runId}/start`, {});
    await writeFile(path.join(run.checkout, file), file === 'README.md' ? 'Tag guidance\n' : 'console.log("tags");\n');
    git(run.checkout, 'add', file); git(run.checkout, 'commit', '-m', 'Edit ' + file);
    run.headCommit = git(run.checkout, 'rev-parse', 'HEAD');
    let state = await f.request(`/api/runs/${run.runId}/submit`, { headCommit: run.headCommit, summary: 'Disjoint change' });
    const task = state.tasks.find(task => task.id === run.taskId);
    const definition = JSON.stringify({ format: CHECK_FORMAT, commit: run.headCommit, taskRevision: task.revision, requirementsSha256: requirementsDigest(task), timeoutMs: 15000,
      checks: [{ name: 'Expected content', argv: ['node', '-e', `process.stdout.write(require('fs').readFileSync('${file}','utf8'))`], stdin: '', expected: { exitCode: 0, stdout: file === 'README.md' ? 'Tag guidance\n' : 'console.log("tags");\n' } }] });
    await f.request(`/api/runs/${run.runId}/checks`, { definition, definitionSha256: digest(definition), image });
  }
  const review = async (runId, expected = 200) => {
    const state = await f.request('/api/workspace'), run = state.runs.find(run => run.id === runId), task = state.tasks.find(task => task.id === run.taskId);
    return f.request(`/api/runs/${runId}/review`, { decision: 'accept', reviewer: 'QA', note: 'Reviewed current changes and reports', headCommit: run.headCommit,
      taskRevision: task.revision, ownerVersion: task.ownerVersion, comparisons: state.coordination[runId].overlaps.map(({runId,headCommit})=>({runId,headCommit})) }, expected);
  };
  await review(runs[0].runId); await review(runs[1].runId);
  await f.request(`/api/runs/${runs[0].runId}/merge`, { headCommit: runs[0].headCommit });
  await f.request(`/api/runs/${runs[1].runId}/merge`, { headCommit: runs[1].headCommit }, 409);
  assert.equal((await f.request('/api/workspace')).recovery.pendingMergeIntents, 0);
  const replacement = await f.request(`/api/runs/${runs[1].runId}/update-base`, { headCommit: runs[1].headCommit, taskRevision: 1, mode: 'reapply' }, 201);
  let state = await f.request('/api/workspace'), run = state.runs.find(run => run.id === replacement.runId);
  assert.equal(run.baseCommit, runs[0].headCommit); assert.equal(run.evidence, null); assert.equal(run.review, null);
  assert.equal(state.runs.find(run => run.id === runs[1].runId).status, 'superseded');
  assert.equal(state.runs.find(run => run.id === runs[1].runId).reviewHistory[0].decision, 'accept');
  await review(run.id, 409);
  await f.request(`/api/runs/${run.id}/verify`, { headCommit: run.headCommit, taskRevision: 2 });
  await review(run.id); await f.request(`/api/runs/${run.id}/merge`, { headCommit: run.headCommit });
  assert.equal(git(f.connected.repository, 'show', 'main:tags.mjs'), 'console.log("tags");');
  assert.equal(git(f.connected.repository, 'show', 'main:README.md'), 'Tag guidance');
  const follow = await f.request(`/api/projects/${f.connected.projectId}/claim`, { requestId: crypto.randomUUID(), label: 'Follow-up agent' }, 201);
  assert.equal(follow.baseCommit, run.headCommit);
  assert.equal(git(f.source, 'show-ref'), f.sourceRefs);
});

test('conflicting base update preserves the old result and offers an isolated resolution checkout', { skip: !image, timeout: 180000 }, async t => {
  const f = await setup(t);
  await f.request('/api/tasks', { source: 'project', projectId: f.connected.projectId, requestId: crypto.randomUUID(), tasks: [{ ...f.input.tasks[0], title: 'Alternative tag policy' }] }, 201);
  const runs = [];
  for (const label of ['first', 'second']) {
    const run = await f.request(`/api/projects/${f.connected.projectId}/claim`, { requestId: crypto.randomUUID(), label }, 201);
    runs.push(run); await f.request(`/api/runs/${run.runId}/start`, {});
    await writeFile(path.join(run.checkout, 'tags.mjs'), `console.log("${label}");\n`);
    git(run.checkout, 'add', '.'); git(run.checkout, 'commit', '-m', label);
    run.headCommit = git(run.checkout, 'rev-parse', 'HEAD');
    const state = await f.request(`/api/runs/${run.runId}/submit`, { headCommit: run.headCommit, summary: label });
    const task = state.tasks.find(task => task.id === run.taskId);
    const definition = JSON.stringify({ format: CHECK_FORMAT, commit: run.headCommit, taskRevision: task.revision, requirementsSha256: requirementsDigest(task), timeoutMs: 15000,
      checks: [{ name: 'Declared tag behavior', argv: ['node', 'tags.mjs'], stdin: '', expected: { exitCode: 0, stdout: label + '\n' } }] });
    await f.request(`/api/runs/${run.runId}/checks`, { definition, definitionSha256: digest(definition), image });
  }
  let state = await f.request('/api/workspace');
  await f.request(`/api/runs/${runs[0].runId}/review`, { decision: 'accept', reviewer: 'QA', note: 'Reviewed overlapping policies', headCommit: runs[0].headCommit, taskRevision: 1, ownerVersion: 1,
    comparisons: state.coordination[runs[0].runId].overlaps.map(({ runId, headCommit }) => ({ runId, headCommit })) });
  await f.request(`/api/runs/${runs[0].runId}/merge`, { headCommit: runs[0].headCommit });
  const before = await f.request('/api/workspace');
  const conflict = await f.request(`/api/runs/${runs[1].runId}/update-base`, { headCommit: runs[1].headCommit, taskRevision: 1, mode: 'reapply' }, 409);
  assert.equal(conflict.error.code, 'base_update_conflict');
  assert.equal((await f.request('/api/workspace')).version, before.version);
  const resolution = await f.request(`/api/runs/${runs[1].runId}/update-base`, { headCommit: runs[1].headCommit, taskRevision: 1, mode: 'resolve' }, 201);
  state = await f.request('/api/workspace');
  const next = state.runs.find(run => run.id === resolution.runId), original = state.runs.find(run => run.id === runs[1].runId);
  assert.equal(next.status, 'assigned'); assert.equal(next.baseCommit, runs[0].headCommit);
  assert.equal(next.reconcilesRunId, original.id); assert.equal(next.evidence, null);
  assert.equal(original.status, 'superseded'); assert.equal(original.evidence.passed, 1);
  assert.equal(await readFile(path.join(next.repository, 'tags.mjs'), 'utf8'), 'console.log("first");\n');
  await f.request(`/api/runs/${next.id}/start`, {});
});
