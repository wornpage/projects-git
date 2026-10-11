import test from 'node:test';
import assert from 'node:assert/strict';
import { reviseTask } from '../src/core/workflow.mjs';
import { createWorkspace, createTask, assignRun, startRun, completeRun, verifyRun,
  failRun, reviewRun, mergeRun, metrics } from '../src/core/workflow.mjs';

const base = 'a'.repeat(40);
const head = 'b'.repeat(40);
const next = 'c'.repeat(40);
const review = { decision: 'accept', ownerVersion: 1, note: 'I reviewed the diff and independently passing checks.', reviewer: 'Jared', headCommit: head };
function fixture() {
  const state = createWorkspace();
  const task = createTask(state, { owner: 'Test coordinator', title: 'Robust totals', purpose: 'Avoid invalid checkout amounts.', criteria: ['Reject negative quantities.'], baseCommit: base });
  const run = assignRun(state, task.id, { agent: 'careful', label: 'Careful agent', branch: 'newwork/careful' });
  startRun(state, run.id);
  completeRun(state, run.id, { headCommit: head, changedFiles: ['checkout.mjs'], diff: '+validate items', summary: 'Validate checkout amounts.' });
  return { state, task, run };
}
function evidence({ passed = true, commit = head, verified = true, source = 'independent-local-checks' } = {}) {
  return { verified, commit, passed: passed ? 1 : 0, total: 1, checks: [{ name: 'negative quantity', passed, detail: 'Executed the pinned check.' }],
    command: 'node independent-checks.mjs', exitCode: passed ? 0 : 1, output: 'Independent check receipt.', verifiedAt: new Date().toISOString(), source };
}

test('execution, verification, human acceptance, and merge remain separate', () => {
  const { state, task, run } = fixture();
  assert.equal(run.status, 'awaiting_review');
  assert.throws(() => reviewRun(state, run.id, review), { code: 'verification_required' });
  verifyRun(state, run.id, evidence());
  assert.equal(task.status, 'review');
  assert.equal(task.acceptedRunId, null);
  assert.throws(() => mergeRun(state, run.id, { headCommit: head, baseCommit: base, mergedCommit: head }), { code: 'acceptance_required' });
  reviewRun(state, run.id, review);
  assert.equal(task.status, 'accepted');
  assert.equal(task.mergedCommit, null);
  mergeRun(state, run.id, { headCommit: head, baseCommit: base, mergedCommit: head });
  assert.equal(task.status, 'merged');
  assert.equal(state.events.at(-1).type, 'run.merged');
});

test('changed requirements retain the accepted commit and receipts but revoke stale acceptance', () => {
  const { state, task, run } = fixture();
  verifyRun(state, run.id, evidence());
  reviewRun(state, run.id, review);
  const oldEvidence = structuredClone(run.evidence);
  reviseTask(state, task.id, { expectedRevision: 1, purpose: 'Preserve correctness under the updated order policy.', criteria: ['Reject invalid quantities', 'Apply the updated policy'], reason: 'Order policy changed while work was underway.' });
  assert.equal(task.revision, 2);
  assert.equal(task.acceptedRunId, null);
  assert.equal(run.headCommit, head);
  assert.deepEqual(run.evidence, oldEvidence);
  assert.equal(run.reviewHistory[0].taskRevision, 1);
  assert.equal(run.status, 'awaiting_review');
  assert.throws(() => reviewRun(state, run.id, { ...review, taskRevision: 2 }), { code: 'stale_evidence' });
  assert.throws(() => mergeRun(state, run.id, { headCommit: head, baseCommit: base, mergedCommit: head }), { code: 'acceptance_required' });
  assert.equal(task.revisions.length, 2);
  assert.deepEqual(metrics(state).checks, { passed: 1, total: 1, verifiedRuns: 0, evidencedRuns: 1 });
});

test('compatible retained code can be reverified for a new revision without another agent run', () => {
  const { state, task, run } = fixture();
  verifyRun(state, run.id, evidence());
  reviseTask(state, task.id, { expectedRevision: 1, purpose: 'Updated current purpose', criteria: ['Current criterion'], reason: 'Current owner requirement' });
  verifyRun(state, run.id, { ...evidence(), taskRevision: 2 });
  assert.equal(run.evidenceHistory[0].taskRevision, 1);
  assert.equal(run.evidence.taskRevision, 2);
  assert.equal(run.assignedRevision, 1);
  assert.equal(state.runs.length, 1);
  assert.throws(() => reviewRun(state, run.id, review), { code: 'stale_requirements' });
  reviewRun(state, run.id, { ...review, taskRevision: 2 });
  mergeRun(state, run.id, { headCommit: head, baseCommit: base, mergedCommit: head });
  assert.equal(task.mergedCommit, head);
});

test('stale requirement updates are rejected without mutating current intent or proof', () => {
  const { state, task } = fixture();
  const before = structuredClone(state);
  assert.throws(() => reviseTask(state, task.id, { expectedRevision: 0, purpose: 'Old edit', criteria: ['old'], reason: 'stale client' }), { code: 'stale_requirements' });
  assert.deepEqual(state, before);
});

test('failing checks cannot qualify a candidate', () => {
  const { state, run } = fixture();
  verifyRun(state, run.id, evidence({ passed: false }));
  assert.throws(() => reviewRun(state, run.id, review), { code: 'checks_failed' });
  assert.equal(run.status, 'awaiting_review');
  reviewRun(state, run.id, { ...review, decision: 'reject', note: 'Negative quantities still produce a discount.' });
  assert.equal(run.status, 'rejected');
});

test('agent-reported checks cannot claim independent verification', () => {
  const { state, run } = fixture();
  assert.throws(() => verifyRun(state, run.id, evidence({ source: 'hosted-harness-report' })), { code: 'untrusted_verifier' });
  verifyRun(state, run.id, evidence({ verified: false, source: 'hosted-harness-report' }));
  assert.throws(() => reviewRun(state, run.id, review), { code: 'verification_required' });
});

test('evidence counts cannot hide a changed denominator', () => {
  const { state, run } = fixture();
  assert.throws(() => verifyRun(state, run.id, { ...evidence(), total: 2 }), { code: 'denominator_mismatch' });
  assert.equal(run.evidence, null);
});

test('stale evidence, review, and merge are refused without mutation', () => {
  const { state, run } = fixture();
  assert.throws(() => verifyRun(state, run.id, evidence({ commit: next })), { code: 'stale_evidence' });
  verifyRun(state, run.id, evidence());
  const version = state.version;
  assert.throws(() => reviewRun(state, run.id, { ...review, headCommit: next }), { code: 'stale_review' });
  assert.equal(state.version, version);
  reviewRun(state, run.id, review);
  assert.throws(() => mergeRun(state, run.id, { headCommit: next, baseCommit: base, mergedCommit: next }), { code: 'stale_merge' });
  assert.throws(() => mergeRun(state, run.id, { headCommit: head, baseCommit: next, mergedCommit: head }), { code: 'stale_base' });
  assert.equal(run.status, 'accepted');
});

test('only one candidate may be accepted for a task', () => {
  const { state, task, run } = fixture();
  const second = assignRun(state, task.id, { agent: 'other', label: 'Second agent', branch: 'newwork/other' });
  startRun(state, second.id);
  completeRun(state, second.id, { headCommit: next, changedFiles: ['checkout.mjs'], diff: '+second implementation', summary: 'Another implementation.' });
  verifyRun(state, run.id, evidence());
  verifyRun(state, second.id, evidence({ commit: next }));
  reviewRun(state, run.id, { ...review, comparisons: [{ runId: second.id, headCommit: next }] });
  assert.throws(() => reviewRun(state, second.id, { ...review, headCommit: next }), { code: 'already_accepted' });
  assert.throws(() => assignRun(state, task.id, { agent: 'late', label: 'Late', branch: 'newwork/late' }), { code: 'task_closed' });
});

test('metrics retain all candidates and check denominators after review', () => {
  const { state, task, run } = fixture();
  const second = assignRun(state, task.id, { agent: 'other', label: 'Second agent', branch: 'newwork/other' });
  failRun(state, second.id, 'Runner process crashed.');
  verifyRun(state, run.id, evidence());
  reviewRun(state, run.id, review);
  assert.deepEqual(metrics(state).acceptedCandidates, { numerator: 1, denominator: 2 });
  assert.deepEqual(metrics(state).checks, { passed: 1, total: 1, verifiedRuns: 1, evidencedRuns: 1 });
  assert.equal(metrics(state).runs.failed, 1);
});

test('invalid submissions do not partially modify a run', () => {
  const state = createWorkspace();
  assert.throws(() => createTask(state, { owner: 'Test coordinator', title: 'x', purpose: 'y', criteria: [], baseCommit: base }), { code: 'invalid_criteria' });
  assert.equal(state.tasks.length, 0);
  const task = createTask(state, { owner: 'Test coordinator', title: 'x', purpose: 'y', criteria: ['One'], baseCommit: base });
  const run = assignRun(state, task.id, { agent: 'a', label: 'a', branch: 'newwork/a' });
  startRun(state, run.id);
  assert.throws(() => completeRun(state, run.id, { headCommit: head, changedFiles: ['../escape'], diff: '', summary: 'bad' }), { code: 'invalid_changes' });
  assert.equal(run.headCommit, null);
  assert.equal(run.status, 'running');
});
