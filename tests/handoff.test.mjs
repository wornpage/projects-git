import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildTaskHandoff, readTaskHandoff, MAX_HANDOFF_BYTES } from '../src/core/handoff.mjs';
import { createWorkspace, createTask, assignRun, startRun, completeRun, verifyRun, reviewRun, reviseTask, failRun } from '../src/core/workflow.mjs';

const at = '2026-10-04T02:40:00.000Z';
function fixture() {
  const state = createWorkspace();
  const task = createTask(state, { owner: 'Test coordinator', title: 'Retain useful work', purpose: 'Safe checkout totals', criteria: ['Reject invalid quantities'], baseCommit: 'a'.repeat(40) });
  const run = assignRun(state, task.id, { agent: 'careful', label: 'Candidate', branch: 'newwork/candidate', repository: '/private/local/repository' });
  startRun(state, run.id);
  completeRun(state, run.id, { headCommit: 'b'.repeat(40), changedFiles: ['checkout.mjs'], diff: '+ retained source', summary: 'Candidate completed' });
  const report = { verified: true, commit: run.headCommit, passed: 1, total: 1, checks: [{ name: 'Invalid quantity', passed: true, detail: 'Independent result' }], command: 'fixed trusted check', exitCode: 0, output: 'PASS', verifiedAt: at, source: 'independent-local-checks' };
  verifyRun(state, run.id, report);
  const failed = assignRun(state, task.id, { agent: 'other', label: 'Retained failure', branch: 'newwork/failed' });
  failRun(state, failed.id, 'Execution interrupted; usage unknown.');
  return { state, task, run, failed, report };
}

test('task export retains failures and original denominators while excluding other tasks and private sidecars', async () => {
  const { state, task, run } = fixture();
  createTask(state, { owner: 'Test coordinator', title: 'PRIVATE_OTHER_TASK', purpose: 'not selected', criteria: ['other'], baseCommit: 'c'.repeat(40) });
  state.token = 'CONTROL_TOKEN_SENTINEL';
  run.credentials = { token: 'GIT_TOKEN_SENTINEL' };
  run.execution = { kind: 'model-agent', status: 'finished', limits: { maxRequests: 1, maxInputBytes: 4096, maxOutputTokens: 512, timeoutMs: 5000 },
    inputTokens: 10, outputTokens: 20, cachedInputTokens: null, usageComplete: false,
    requests: [{ number: 1, inputBytes: 100, outputTokenLimit: 512, status: 'usage_unknown', usage: null, result: { secret: 'RAW_PROVIDER_SENTINEL' } }] };
  const before = structuredClone(state);
  const handoff = await buildTaskHandoff(state, task.id, at);
  const text = JSON.stringify(handoff);
  assert.doesNotMatch(text, /PRIVATE_OTHER_TASK|CONTROL_TOKEN_SENTINEL|GIT_TOKEN_SENTINEL|RAW_PROVIDER_SENTINEL|\/private\/local/);
  assert.equal(handoff.payload.runs.length, 2);
  assert.equal(handoff.payload.runs[1].status, 'failed');
  assert.deepEqual(handoff.payload.recordedMetrics.acceptedCandidates, { numerator: 0, denominator: 2 });
  assert.equal(handoff.payload.runs[0].execution.usageComplete, false);
  assert.equal(handoff.payload.runs[0].execution.requests[0].usage, null);
  assert.ok(handoff.payload.events.every(event => event.taskId === task.id));
  assert.deepEqual(state, before);
  assert.deepEqual(await readTaskHandoff(text), handoff);
});

test('a revised task exports stale proof, prior approval and recheck direction without generating new work', async () => {
  const { state, task, run, report } = fixture();
  reviewRun(state, run.id, { decision: 'accept', ownerVersion: 1, note: 'Test review', reviewer: 'QA', headCommit: run.headCommit, taskRevision: 1 });
  reviseTask(state, task.id, { expectedRevision: 1, purpose: 'Updated policy', criteria: ['Keep checkoutTotal export'], reason: 'Clarify interface' });
  const stale = await buildTaskHandoff(state, task.id, at);
  assert.equal(stale.payload.nextAction.kind, 'recheck');
  assert.equal(stale.payload.task.revision, 2);
  assert.equal(stale.payload.runs[0].headCommit, run.headCommit);
  assert.equal(stale.payload.runs[0].reviewHistory[0].taskRevision, 1);
  assert.equal(stale.payload.recordedMetrics.checks.verifiedRuns, 0);
  verifyRun(state, run.id, { ...report, taskRevision: 2 });
  const current = await buildTaskHandoff(state, task.id, at);
  assert.equal(current.payload.nextAction.kind, 'human_review');
  assert.equal(current.payload.runs[0].evidenceHistory.length, 1);
  assert.equal(current.payload.runs.length, 2);
});

test('handoff exports merge attempt identity without relabelling older evidence', async () => {
  const { state, task, run, report } = fixture();
  run.evidenceHistory = [structuredClone(report), { ...structuredClone(report), operation: 'merge', attemptId: 'merge-attempt-1', verifiedAt: '2026-10-05T12:03:00.000Z' }];
  const handoff = await buildTaskHandoff(state, task.id, at);
  assert.equal(handoff.payload.runs[0].evidenceHistory[0].operation, undefined);
  assert.equal(handoff.payload.runs[0].evidenceHistory[1].operation, 'merge');
  assert.equal(handoff.payload.runs[0].evidenceHistory[1].attemptId, 'merge-attempt-1');
  assert.equal((await readTaskHandoff(JSON.stringify(handoff))).payload.runs[0].evidenceHistory[1].attemptId, 'merge-attempt-1');
});

test('checksum detects tampering and parsing refuses invalid or oversized envelopes', async () => {
  const { state, task } = fixture();
  const handoff = await buildTaskHandoff(state, task.id, at);
  assert.equal((await buildTaskHandoff(state, task.id, at)).sha256, handoff.sha256);
  const reordered = { payload: handoff.payload, sha256: handoff.sha256, format: handoff.format };
  assert.equal((await readTaskHandoff(JSON.stringify(reordered))).sha256, handoff.sha256);
  handoff.payload.runs[0].headCommit = 'f'.repeat(40);
  await assert.rejects(readTaskHandoff(JSON.stringify(handoff)), /checksum mismatch/);
  await assert.rejects(readTaskHandoff('{ "private": secret'), /^Error: Handoff is not valid JSON\.$/);
  await assert.rejects(readTaskHandoff('x'.repeat(MAX_HANDOFF_BYTES + 1)), /2 MiB/);
  await assert.rejects(readTaskHandoff(JSON.stringify({ format: 'unknown' })), /Unsupported/);
  await assert.rejects(buildTaskHandoff(state, 'missing', at), { code: 'task_not_found' });
  await assert.rejects(buildTaskHandoff(state, task.id, 'invalid'), { code: 'invalid_timestamp' });
});

test('offline CLI inspects saved proof and never executes a recorded command', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'projects-handoff-'));
  try {
    const { state, task, run } = fixture();
    run.evidence.command = 'throw new Error("RECORDED_COMMAND_MUST_NOT_RUN")';
    const file = join(directory, 'handoff.json');
    await writeFile(file, JSON.stringify(await buildTaskHandoff(state, task.id, at)));
    const result = spawnSync(process.execPath, ['scripts/inspect-handoff.mjs', file], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.match(summary.integrity, /not authenticated/);
    assert.equal(summary.candidates.length, 2);
    assert.equal(summary.nextAction.kind, 'human_review');
    const changed = JSON.parse(await readFile(file, 'utf8'));
    changed.payload.task.title = 'Tampered';
    await writeFile(file, JSON.stringify(changed));
    const refused = spawnSync(process.execPath, ['scripts/inspect-handoff.mjs', file], { encoding: 'utf8', windowsHide: true });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /checksum mismatch/);
    assert.equal(refused.stdout, '');
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    await rm(directory, { recursive: true, force: true });
  }
});
