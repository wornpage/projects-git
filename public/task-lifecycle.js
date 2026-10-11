import {independentlyVerified, mergeState} from './workbench-state.js';
import {independentReviewStatus} from './review-boundary.js';

// Read-only presentation of one candidate. These stages never authorize an action
// or infer a missing earlier receipt from a later outcome.
export function candidateLifecycle(workspace, run) {
  const sample = workspace.demonstration?.kind === 'read-only-sample';
  const task = workspace.tasks.find(task => task.id === run.taskId);
  if (!task) return [];
  const stage = (id, title, label, tone, detail, section) => ({id, title, label, tone, detail, section});
  const hasCommit = Boolean(run.headCommit);
  const execution = run.status === 'failed'
    ? stage('work', 'Agent work', 'Execution failed', 'attention', hasCommit ? 'A commit was retained with this failed attempt.' : 'The failed attempt remains in the record.')
    : ['assigned', 'running'].includes(run.status)
      ? stage('work', 'Agent work', run.status === 'running' ? 'In progress' : 'Waiting to start', 'active', hasCommit ? 'A retained commit is available; work is still active.' : 'No submitted commit yet.')
      : stage('work', 'Agent work', hasCommit ? 'Commit submitted' : 'No commit', hasCommit ? 'complete' : 'waiting', hasCommit ? `${run.changedFiles.length} changed file${run.changedFiles.length === 1 ? '' : 's'}` : 'Waiting for a submitted change.');
  execution.section = hasCommit ? 'candidate-changes' : null;

  const report = run.evidence;
  const counts = report ? `${report.passed} / ${report.total} checks passing` : 'No check report retained.';
  const current = independentlyVerified(workspace, run);
  const passing = current && Number.isSafeInteger(report?.total) && report.total > 0
    && report.passed === report.total && report.exitCode === 0;
  const checks = stage('checks', 'Checks', run.verificationPending ? 'Running'
    : !report ? 'Not recorded' : !current ? 'Recheck needed' : passing ? 'Passed' : 'Not passing',
    run.verificationPending ? 'active' : !report ? 'waiting' : passing ? 'complete' : 'attention',
    run.verificationPending && report ? 'Previous report: ' + counts
      : run.status === 'merged' && report ? 'Acceptance-time report: ' + counts : counts, hasCommit ? 'verification' : null);

  const review = independentReviewStatus(workspace, run);
  const reviewLabels = {unavailable: 'Hosted only', historical: 'Historical / missing', pending: 'Awaiting reviewer',
    invalid: 'Identity invalid', stale: 'Stale', passed: 'Passed', 'changes-requested': 'Changes requested'};
  const codeReview = stage('review', 'Independent review', reviewLabels[review.state],
    review.passed ? 'complete' : ['stale', 'invalid', 'changes-requested'].includes(review.state) ? 'attention'
      : ['historical', 'unavailable'].includes(review.state) ? 'history' : 'waiting',
    sample ? 'Illustrative reviewer assessment; no real session.' : review.label, hasCommit ? 'code-review' : null);

  const receipt = run.review;
  const authenticated = receipt?.identity?.provider === 'cloudflare-access'
    && receipt.identity.kind === 'owner' && receipt.identity.workspaceId === workspace.id;
  const local = workspace.provider === 'local-git';
  const sameRevision = receipt?.headCommit === run.headCommit
    && (receipt?.taskRevision ?? 1) === (task.revision ?? 1);
  const accepted = receipt?.decision === 'accept' && ['accepted', 'merged'].includes(run.status)
    && task.acceptedRunId === run.id && sameRevision && receipt.ownerVersion === task.ownerVersion;
  const rejected = receipt?.decision === 'reject' && run.status === 'rejected' && sameRevision;
  const automated = receipt?.policy?.mode === 'checks-and-independent-review';
  const renew = accepted && !local && ((!authenticated && !automated) || !review.passed || receipt.codeReviewId !== run.codeReview?.id);
  const attribution = automated ? `Automatic policy v${receipt.policy.version}. Enabled by ${receipt.policy.enabledBy.displayName}.`
    : sample ? 'Illustrative owner decision; no real session.' : authenticated ? 'Authenticated owner decision.' : local ? 'Local attribution.' : 'Unauthenticated historical attribution.';
  const decision = stage('decision', automated ? 'Policy decision' : 'Owner decision', renew ? (run.status === 'merged' ? 'Historical acceptance' : 'Renew acceptance')
    : accepted ? 'Accepted' : rejected ? 'Rejected' : receipt ? 'Earlier decision' : 'Not recorded',
    renew ? 'attention' : accepted ? 'complete' : rejected ? 'attention' : receipt ? 'history' : 'waiting',
    receipt ? attribution : 'A check or reviewer pass is not an owner decision.', hasCommit ? 'review-decision' : null);

  const pendingMerge = mergeState(workspace, run);
  const merged = run.status === 'merged' && task.acceptedRunId === run.id && task.mergedCommit === run.headCommit;
  const merge = stage('merge', 'Merge', pendingMerge === 'running' ? 'In progress'
    : pendingMerge === 'recovery-required' ? 'Recovery required' : merged ? 'Merged' : 'Not merged',
    pendingMerge === 'running' ? 'active' : pendingMerge === 'recovery-required' ? 'attention' : merged ? 'complete' : 'waiting',
    pendingMerge ? 'Follow the retained operation in Review.' : merged ? 'The commit is integrated; merge-attempt checks remain separate.'
      : task.mergedCommit ? 'Another candidate was integrated.' : 'Acceptance and Git integration are separate actions.',
    hasCommit ? 'review-decision' : null);
  if (merged && !pendingMerge) { merge.view = 'evidence'; merge.section = null; }
  return [execution, checks, codeReview, decision, merge];
}
