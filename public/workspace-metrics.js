import {repositoryObservationCurrent} from './review-boundary.js';

export function metrics(state) {
  const tasks = { total: state.tasks.length, open: 0, running: 0, review: 0, accepted: 0, merged: 0 };
  const runs = { total: state.runs.length, assigned: 0, running: 0, awaitingReview: 0, accepted: 0, rejected: 0, failed: 0, merged: 0, superseded: 0 };
  for (const task of state.tasks) tasks[task.status] += 1;
  for (const run of state.runs) runs[run.status === 'awaiting_review' ? 'awaitingReview' : run.status] += 1;
  const evidenced = state.runs.filter(run => run.evidence);
  const checks = { passed: evidenced.reduce((n, run) => n + run.evidence.passed, 0),
    total: evidenced.reduce((n, run) => n + run.evidence.total, 0),
    verifiedRuns: evidenced.filter(run => !run.verificationPending && repositoryObservationCurrent(state,run) && run.evidence.verified && run.evidence.commit === run.headCommit && (run.evidence.taskRevision ?? 1) === (state.tasks.find(task => task.id === run.taskId)?.revision ?? 1)).length, evidencedRuns: evidenced.length };
  return { tasks, runs, checks, acceptedCandidates: { numerator: runs.accepted + runs.merged, denominator: runs.total } };
}
