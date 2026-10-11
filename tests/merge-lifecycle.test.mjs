import test from 'node:test';
import assert from 'node:assert/strict';
import { hostedMergeStateByRun, localMergeStateByRun, mergeEvidence, mergeEvidenceChanged, retainMergeEvidence } from '../src/core/merge-lifecycle.mjs';
import { RepositoryRunner } from '../src/local/repository-runner.mjs';

const COMMIT = 'a'.repeat(40);
const digest = value => value.repeat(64);
const verification = overrides => ({ kind: 'repository-command-checks/v1', definitionSha256: digest('1'), verifierSha256: digest('2'),
  inputHandoffSha256: digest('3'), requirementsSha256: digest('4'), image: 'sha256:' + digest('5'), tree: '6'.repeat(40), ...overrides });
const report = overrides => ({ verified: true, source: 'independent-sandbox-checks', commit: COMMIT, taskRevision: 3,
  checks: [{ name: 'node', passed: true, detail: 'exact output matched' }], passed: 1, total: 1, command: 'node check.mjs',
  exitCode: 0, output: 'ok\n', verifiedAt: '2026-10-05T12:00:00.000Z', verification: verification(), ...overrides });

function acceptedState() {
  const evidence = report();
  const review = { decision: 'accept', note: 'Reviewed exact commit.', reviewer: 'Owner', at: '2026-10-05T12:01:00.000Z', headCommit: COMMIT, taskRevision: 3 };
  return { schemaVersion: 1, id: 'workspace', name: 'Projects Git', provider: 'local-git', createdAt: '2026-10-05T11:00:00.000Z', version: 9,
    tasks: [{ id: 'task', title: 'Merge lifecycle', purpose: 'Retain proof.', criteria: ['Keep exact provenance.'], status: 'accepted', baseCommit: 'b'.repeat(40),
      createdAt: '2026-10-05T11:00:00.000Z', acceptedRunId: 'run', mergedCommit: null, revision: 3 }],
    runs: [{ id: 'run', taskId: 'task', agent: 'worker', label: 'Backend', status: 'accepted', baseCommit: 'b'.repeat(40), headCommit: COMMIT,
      branch: 'newwork/backend', repository: null, startedAt: null, finishedAt: null, changedFiles: [], diff: '', summary: '', evidence,
      review, error: null, assignedRevision: 3, evidenceHistory: [], reviewHistory: [] }], events: [] };
}

test('read-only merge projections distinguish active work from interrupted intent', () => {
  assert.deepEqual(localMergeStateByRun({ active: {}, interrupted: {} }, new Set(['active'])), {
    active: 'running', interrupted: 'recovery-required' });
  assert.deepEqual(hostedMergeStateByRun({
    active: { kind: 'merge', state: 'pending', itemId: 'active', leaseUntil: 101 },
    interrupted: { kind: 'merge', state: 'pending', itemId: 'interrupted', leaseUntil: 100 },
    refused: { kind: 'merge', state: 'failed', itemId: 'refused', leaseUntil: 500 },
    checks: { kind: 'checks', state: 'pending', itemId: 'checks', leaseUntil: 500 },
  }, 100), { active: 'running', interrupted: 'recovery-required' });
});

test('successful fresh checks are retained once without replacing acceptance evidence', () => {
  const state = acceptedState();
  const acceptedEvidence = structuredClone(state.runs[0].evidence);
  const acceptedReview = structuredClone(state.runs[0].review);
  const fresh = mergeEvidence(report({ verifiedAt: '2026-10-05T12:02:00.000Z' }), 'attempt-success');
  assert.equal(retainMergeEvidence(state, 'run', fresh), true);
  assert.equal(retainMergeEvidence(state, 'run', fresh), false, 'same attempt replay is read-only');
  assert.deepEqual(state.runs[0].evidence, acceptedEvidence);
  assert.deepEqual(state.runs[0].review, acceptedReview);
  assert.deepEqual(state.runs[0].evidenceHistory, [fresh]);
  assert.equal(state.version, 10);
  assert.throws(() => retainMergeEvidence(state, 'run', { ...fresh, output: 'changed' }), { code: 'merge_attempt_conflict' });
});

test('failed or stale fresh checks preserve old proof and require renewed review', () => {
  const state = acceptedState();
  const acceptedEvidence = structuredClone(state.runs[0].evidence);
  const fresh = mergeEvidence(report({ verified: false, passed: 0, exitCode: 1,
    checks: [{ name: 'node', passed: false, detail: 'exit differed' }], verifiedAt: '2026-10-05T12:03:00.000Z' }), 'attempt-failed');
  retainMergeEvidence(state, 'run', fresh, { requiresReview: true });
  assert.equal(state.tasks[0].acceptedRunId, null);
  assert.equal(state.tasks[0].status, 'review');
  assert.equal(state.runs[0].status, 'awaiting_review');
  assert.equal(state.runs[0].review, null);
  assert.equal(state.runs[0].reviewHistory.length, 1);
  assert.deepEqual(state.runs[0].evidence, fresh);
  assert.deepEqual(state.runs[0].evidenceHistory, [acceptedEvidence, fresh]);
  assert.equal(state.runs[0].evidenceHistory[0].operation, undefined, 'older evidence remains unmarked');
});

test('fresh merge parity compares exact revision and verifier provenance', () => {
  const accepted = report();
  assert.equal(mergeEvidenceChanged(accepted, report(), 'commands'), false);
  assert.equal(mergeEvidenceChanged(accepted, report({ taskRevision: 2 }), 'commands'), true);
  assert.equal(mergeEvidenceChanged(accepted, report({ verification: verification({ image: 'sha256:' + digest('9') }) }), 'commands'), true);
  assert.equal(mergeEvidenceChanged(accepted, report({ verification: verification({ inputHandoffSha256: digest('9') }) }), 'commands'), false,
    'the export digest may change when history is retained; it remains recorded but is not a policy identity');
});

test('connected Git tasks without a stored profile still compare command provenance', async () => {
  const state = acceptedState(), task = state.tasks[0], run = state.runs[0];
  task.origin = 'connected-git';
  delete task.verificationProfile;
  const changed = report({ verification: verification({ verifierSha256: digest('9') }) });
  const runner = { directory: async () => '/repository',
    git: async (_repository, args) => args[1] === 'refs/heads/main' ? task.baseCommit : run.headCommit,
    verify: async () => changed };
  const result = await RepositoryRunner.prototype.verifyMerge.call(runner, state, task, run);
  assert.equal(result.changed, true);
});
