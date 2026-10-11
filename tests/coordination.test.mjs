import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspace, createTask, setTaskOwner, assignRun, startRun, completeRun, failRun, verifyRun, reviewRun, mergeRun, coordination, metrics } from '../src/core/workflow.mjs';
import { buildTaskHandoff } from '../src/core/handoff.mjs';

const base = 'a'.repeat(40), head = 'b'.repeat(40), secondHead = 'c'.repeat(40);
const taskInput = { title: 'Coordinate real changes', purpose: 'Compare work before accepting it', criteria: ['Keep all candidates'], baseCommit: base };
function assigned(state, task, label = 'Worker') {
  return assignRun(state, task.id, { agent: label, label, branch: `newwork/${label.toLowerCase()}` });
}
function finish(state, run, commit = head, paths = ['src/shared.py']) {
  completeRun(state, run.id, { headCommit: commit, changedFiles: paths, diff: '+change', summary: 'Submitted change' });
  verifyRun(state, run.id, { verified: true, source: 'independent-local-checks', commit, taskRevision: 1, passed: 1, total: 1,
    checks: [{ name: 'Behavior', passed: true, detail: 'Independent test' }], command: 'Test fixture', exitCode: 0, output: 'PASS', verifiedAt: new Date().toISOString() });
}
function decision(state, run, extra = {}) {
  const task = state.tasks.find(task => task.id === run.taskId);
  return { decision: 'accept', reviewer: 'Test reviewer', note: 'Compared current diffs and exact heads', headCommit: run.headCommit,
    taskRevision: task.revision, ownerVersion: task.ownerVersion, comparisons: coordination(state, run.id).overlaps.map(({runId,headCommit}) => ({runId,headCommit})), ...extra };
}

test('ownership claims use compare-and-set and execution capacity is shared across tasks', () => {
  const state = createWorkspace(), task = createTask(state, taskInput);
  assert.throws(() => assigned(state, task), { code: 'owner_required' });
  setTaskOwner(state, task.id, { owner: 'Coordinator', expectedOwnerVersion: 0 });
  assert.throws(() => setTaskOwner(state, task.id, { owner: 'Other', expectedOwnerVersion: 0 }), { code: 'stale_owner' });
  const other = createTask(state, { ...taskInput, owner: 'Other coordinator' });
  const runs = Array.from({ length: 5 }, (_, i) => assigned(state, i < 2 ? task : other, `Worker${i}`));
  runs.slice(0, 4).forEach(run => startRun(state, run.id));
  const before = structuredClone(state);
  assert.throws(() => startRun(state, runs[4].id), { code: 'capacity_full' });
  assert.deepEqual(state, before);
  assert.throws(() => setTaskOwner(state, task.id, { owner: 'Replacement', expectedOwnerVersion: 1 }), { code: 'work_in_progress' });
  failRun(state, runs[0].id, 'Bounded attempt failed');
  startRun(state, runs[4].id);
  assert.equal(metrics(state).runs.running, 4);
  assert.equal(metrics(state).runs.total, 5);
});

test('related in-flight work blocks acceptance and all overlapping heads need explicit comparison', () => {
  const state = createWorkspace(), task = createTask(state, { ...taskInput, owner: 'Coordinator', repositoryKey: 'shared-repository' });
  const first = assigned(state, task, 'First'), second = assigned(state, task, 'Second');
  startRun(state, first.id); startRun(state, second.id); finish(state, first);
  assert.throws(() => reviewRun(state, first.id, decision(state, first)), { code: 'work_in_progress' });
  finish(state, second, secondHead);
  assert.deepEqual(coordination(state, first.id).overlaps[0].paths, ['src/shared.py']);
  assert.throws(() => reviewRun(state, first.id, decision(state, first, { comparisons: [] })), { code: 'comparison_required' });
  assert.throws(() => reviewRun(state, first.id, decision(state, first, { comparisons: [{ runId: second.id, headCommit: head }] })), { code: 'comparison_required' });
  reviewRun(state, first.id, decision(state, first));
  assert.equal(first.review.comparisons[0].headCommit, secondHead);
  assert.deepEqual(metrics(state).acceptedCandidates, { numerator: 1, denominator: 2 });
  const saved = first.review.comparisons; first.review.comparisons = [];
  assert.throws(() => mergeRun(state, first.id, { headCommit: head, baseCommit: base, mergedCommit: head }), { code: 'stale_comparison' });
  first.review.comparisons = saved;
  mergeRun(state, first.id, { headCommit: head, baseCommit: base, mergedCommit: head });
});

test('cross-task overlap shares a repository boundary and reserves an accepted base', () => {
  const state = createWorkspace();
  const a = createTask(state, { ...taskInput, owner: 'A', repositoryKey: 'shared' });
  const b = createTask(state, { ...taskInput, owner: 'B', repositoryKey: 'shared' });
  const c = createTask(state, { ...taskInput, owner: 'C', repositoryKey: 'separate' });
  const first = assigned(state, a, 'First'), second = assigned(state, b, 'Second'), isolated = assigned(state, c, 'Isolated');
  for (const run of [first, second, isolated]) { startRun(state, run.id); finish(state, run, run === first ? head : secondHead); }
  assert.deepEqual(coordination(state, first.id).overlaps.map(item => item.runId), [second.id]);
  reviewRun(state, first.id, decision(state, first));
  assert.throws(() => reviewRun(state, second.id, decision(state, second)), { code: 'overlap_blocked' });
  assert.throws(() => assigned(state, b, 'Late'), { code: 'repository_reserved' });
  assert.doesNotThrow(() => reviewRun(state, isolated.id, decision(state, isolated)));
});

test('ownership transfer revokes acceptance, preserves review history and exports attribution', async () => {
  const state = createWorkspace(), task = createTask(state, { ...taskInput, owner: 'Original coordinator' });
  const run = assigned(state, task); startRun(state, run.id); finish(state, run);
  reviewRun(state, run.id, decision(state, run));
  setTaskOwner(state, task.id, { owner: 'New coordinator', expectedOwnerVersion: 1 });
  assert.equal(task.acceptedRunId, null); assert.equal(run.status, 'awaiting_review');
  assert.equal(run.reviewHistory[0].ownerVersion, 1);
  assert.throws(() => reviewRun(state, run.id, decision(state, run, { ownerVersion: 1 })), { code: 'owner_required' });
  reviewRun(state, run.id, decision(state, run));
  const handoff = await buildTaskHandoff(state, task.id);
  assert.equal(handoff.payload.task.owner, 'New coordinator');
  assert.equal(handoff.payload.task.ownerHistory[0].owner, 'Original coordinator');
  assert.equal(handoff.payload.runs[0].review.ownerVersion, 2);
  assert.equal(handoff.payload.runs[0].reviewHistory[0].ownerVersion, 1);
  assert.equal(run.headCommit, head);
});
