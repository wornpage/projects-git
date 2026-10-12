// Display-only helpers. Identity, assignment and review authority stay on the server.
import {candidateOutcome, independentlyVerified, mergeState, projectMergeBlocker} from './workbench-state.js';
import {independentReviewStatus} from './review-boundary.js';

/** Explain the next handoff from the snapshot; never authorize or start work. */
export function reviewNextStep(workspace, run, {demo = false} = {}) {
  const task = workspace.tasks.find(task => task.id === run.taskId);
  const project = workspace.projects?.[task?.projectId];
  const hosted = workspace.provider === 'cloudflare-artifacts';
  const policy = project?.automaticMergePolicy;
  const automatic = hosted && policy?.enabled === true;
  const integration = demo ? 'Read-only example' : !hosted ? 'Local operator decisions'
    : automatic ? 'Automatic for eligible submissions' : 'Owner decisions · automatic integration off';
  const owner = workspace.authentication?.principal?.kind === 'owner' && workspace.authentication.principal.displayName
    ? 'Workspace owner · ' + workspace.authentication.principal.displayName : hosted ? 'Workspace owner' : 'Local operator';
  const result = (responsibility, next, waiting) => ({owner: responsibility, next, waiting, integration});
  const builder = run.label ? 'Builder · ' + run.label : 'Assigned builder';
  const outcome = candidateOutcome(workspace, run);
  if (demo) return result('Viewer', 'Browse the recorded assessment and candidate outcome.', ['No live work is waiting. This example does not run agents or checks.']);
  const merging = mergeState(workspace, run);
  if (merging === 'recovery-required') return result(owner, outcome.next, ['Reconciliation of the retained merge attempt. Refresh does not retry it.']);
  if (merging === 'running') return result('Merge verifier', outcome.next, ['The current merge attempt must record its outcome.']);
  if (run.verificationPending) return result('Verifier', 'Independent checks have been requested. Wait for the recorded result.', ['Current independent check results.']);
  if (run.status === 'merged') return result('No action required', 'This candidate is integrated. Its assessment and outcome remain available.', []);
  if (['rejected', 'failed', 'superseded'].includes(run.status) || task?.acceptedRunId && task.acceptedRunId !== run.id)
    return result(owner, outcome.next, ['No further review is waiting on this retained candidate.']);
  if (run.repositoryObservation?.requiresSubmission) return result(builder, outcome.next, ['Authenticated submission of the current commit.']);
  if (['assigned', 'running'].includes(run.status)) return result(builder, outcome.next, ['A submitted candidate from the coding host.']);
  if (outcome.label === 'Update base needed') return result(owner, outcome.next, ['A candidate based on current main, followed by renewed checks and review.']);
  if (!independentlyVerified(workspace, run)) return result(owner, run.checksConfigured ? 'Run the preserved checks against the current candidate.' : 'Configure and run independent checks for this candidate.', ['Current independent check results before review can proceed.']);
  if (!run.evidence.total || run.evidence.passed !== run.evidence.total || run.evidence.exitCode !== 0)
    return result(builder, 'Inspect the failed checks and submit a correction. The owner can also reject this candidate.', ['Every required check must pass.']);

  const review = independentReviewStatus(workspace, run);
  const request = workspace.reviewRequests?.[run.id];
  const assignment = run.reviewAssignments?.at(-1);
  if (hosted && !review.passed) {
    if (review.state === 'changes-requested') return result(builder, 'Address the recorded findings and submit a revised candidate for checks and review.', ['A current passing independent assessment, including resolution of blocking findings.']);
    if (['stale', 'historical', 'invalid'].includes(review.state) || ['stale', 'reviewer-unavailable'].includes(request))
      return result(owner, 'Renew the review request with a currently allowed reviewer after checking the current candidate context.', [review.label]);
    if (!assignment) {
      const unconfigured = workspace.authentication?.principal?.kind === 'owner' && reviewerChoices(workspace).length === 0;
      return result(owner, unconfigured ? 'Configure a separate reviewer in Access and this workspace, then request review.' : 'Choose a configured independent reviewer and save the review request.', ['An independent reviewer assignment. Saving a request does not start an agent.']);
    }
    const choices = reviewerChoices(workspace);
    const names = assignment.reviewerIds.map(id => choices.find(choice => choice.id === id)?.name).filter(Boolean);
    const pending = workspace.reviewInferences?.some(attempt => attempt.runId === run.id && attempt.state === 'pending');
    return result(names.length ? 'Assigned reviewer · ' + names.join(', ') : 'Assigned independent reviewer',
      pending ? 'The reviewing host has reserved an attempt. Await its assessment; an interrupted attempt needs owner reconciliation.'
        : 'The coding host must start or continue an agent review, or the assigned person must open their review link.',
      ['A submitted assessment for this exact candidate. Assignment alone does not confirm that review has started.']);
  }

  const projectBlocker = projectMergeBlocker(workspace, run);
  if (projectBlocker) return result(mergeState(workspace, projectBlocker) === 'recovery-required' ? owner : 'Project merge verifier',
    'Resolve the other merge in this project before this candidate can integrate.', ['The other project merge must have a known outcome.']);
  if (run.status === 'accepted') {
    if (hosted && run.review?.codeReviewId !== run.codeReview?.id)
      return result(owner, 'Renew the candidate decision against the current independent assessment.', ['Owner acceptance bound to this assessment. The earlier decision remains history.']);
    if (run.review?.policy) {
      const stopped = !automatic || policy.version !== run.review.policy.version || run.automaticMergeStop?.decisionId === run.review.policy.decisionId;
      return stopped ? result(owner, outcome.next, ['The retained policy decision cannot start another automatic merge.'])
        : result('Automatic merge policy', 'The policy has approved this candidate. Fresh merge checks must pass before Git is updated.', ['The queued merge and its verification capacity.']);
    }
    return result(owner, 'Request the guarded merge of this accepted candidate.', ['A merge request and fresh merge checks.']);
  }
  const related = workspace.coordination?.[run.id];
  if (!Array.isArray(related?.acceptance)) return result(owner, 'Refresh the workspace to read the current decision prerequisites.', ['Current server-reported prerequisites. Eligibility has not been established.']);
  const missing = related.acceptance.filter(rule => !rule.met);
  if (missing.length) return result(missing.every(rule => rule.code === 'work_in_progress') ? 'Related builders' : owner,
    'Resolve the remaining prerequisites shown by the server before choosing this candidate.', missing.map(rule => rule.message));
  const alternatives = workspace.runs.some(other => other.id !== run.id && other.taskId === run.taskId && ['assigned', 'running', 'awaiting_review', 'accepted'].includes(other.status));
  if (related.overlaps?.length || automatic && alternatives) return result(owner, 'Compare the current alternatives and record a choice.', ['An explicit choice between competing or overlapping work.']);
  return automatic ? result('Automatic merge policy', 'The policy will evaluate this submission against its current rules. It does not launch the agents.', ['Policy evaluation, available capacity and fresh merge checks.'])
    : result(owner, 'Inspect the assessment and record your candidate decision.', ['An owner decision. Acceptance and the guarded merge remain separate actions.']);
}

export function reviewerChoices(workspace) {
  const authentication = workspace.authentication ?? {};
  return [
    ...(authentication.reviewerClientIds ?? []).map(id => ({id, kind:'agent', role:'Agent reviewer'})),
    ...(authentication.reviewerSubjects ?? []).map(id => ({id, kind:'human', role:'Human reviewer'})),
  ].map(option => ({...option, name:Object.hasOwn(workspace.reviewerNames??{},option.id) ? workspace.reviewerNames[option.id] : `${option.role} · ${option.id.slice(0,8)}…${option.id.slice(-6)}`}));
}

export function reviewRequestLabel(state) {
  return ({unassigned:'Choose reviewers',pending:'Awaiting review',pass:'Passed',changes_requested:'Changes requested',
    stale:'Needs renewed assignment',closed:'Candidate closed',
    'reviewer-unavailable':'Reviewer access needs attention'})[state] ?? 'Refresh review status';
}

export function humanReviewLink(origin, pathname, workspaceId, runId, assignmentId) {
  const url = new URL(pathname.startsWith('/workspace/') ? '/workspace/reviewer' : '/reviewer.html', origin);
  url.search = new URLSearchParams({workspace:workspaceId,run:runId,assignment:assignmentId}).toString();
  return url.href;
}

export function linkedReview(search, inbox) {
  const params = new URLSearchParams(search);
  if (!['workspace','run','assignment'].some(key => params.has(key))) return {kind:'none'};
  if (['workspace','run','assignment'].some(key => params.getAll(key).length !== 1 || !params.get(key))
    || params.get('workspace') !== inbox.workspaceId) return {kind:'unavailable'};
  const item = inbox.items.find(item => item.runId === params.get('run'));
  if (!item) return {kind:'unavailable'};
  if (item.assignmentId !== params.get('assignment') || ['stale','closed','reviewer-unavailable'].includes(item.status)) return {kind:'stale'};
  return {kind:'ready',item};
}
