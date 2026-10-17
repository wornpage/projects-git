// Shared, deterministic context for the server gate and its read-only UI.
export function authenticatedReviewer(workspace,identity) {
  if(identity?.kind!=='reviewer'||identity.workspaceId!==workspace.id||typeof identity.id!=='string'||!identity.id)return false;
  if(identity.provider==='cloudflare-access')return true;
  const issuer=workspace.authentication?.issuer??workspace.authentication?.principal?.issuer;
  return identity.provider==='trial-credential'&&workspace.provider==='cloudflare-artifacts'&&/^trial-[a-f0-9]{64}$/.test(workspace.id)
    &&identity.id==='reviewer-'+workspace.id&&typeof issuer==='string'&&identity.issuer===issuer;
}
export function automaticMergePolicyCurrent(workspace, project) {
  const policy = project?.automaticMergePolicy, owner = workspace.authentication;
  return Boolean(workspace.provider === 'cloudflare-artifacts' && owner && policy?.enabled
    && policy.mode === 'checks-and-independent-review' && Number.isSafeInteger(policy.version) && policy.version > 0
    && policy.enabledBy?.kind === 'owner' && policy.enabledBy.provider === 'cloudflare-access'
    && policy.enabledBy.id === owner.subject && policy.enabledBy.issuer === owner.issuer && policy.enabledBy.workspaceId === owner.workspaceId
    && policy.ownerAudience === owner.audience && policy.sessionsValidAfter === (workspace.sessionsValidAfter ?? 0));
}

export function repositoryObservationCurrent(workspace,run){
  const task=workspace.tasks.find(item=>item.id===run.taskId),project=workspace.projects?.[task?.projectId];
  return Boolean(!run.repositoryObservation?.requiresSubmission&&
    (task?.mergedCommit||!project?.repositoryObservation||project.repositoryObservation.headCommit===task?.baseCommit));
}

export function independentReviewBinding(workspace, run) {
  const task = workspace.tasks.find(task => task.id === run.taskId);
  const evidence = run.evidence;
  return { workspaceId: workspace.id, taskId: task?.id, runId: run.id,
    headCommit: run.headCommit, baseCommit: task?.baseCommit, taskRevision: task?.revision ?? 1,
    ownerVersion: task?.ownerVersion, reviewAssignmentId: run.reviewAssignments?.at(-1)?.id ?? null,
    requirements: { title: task?.title, purpose: task?.purpose, criteria: task?.criteria ? [...task.criteria] : undefined },
    evidence: evidence ? { commit: evidence.commit, taskRevision: evidence.taskRevision ?? 1, source: evidence.source,
      verified: evidence.verified, passed: evidence.passed, total: evidence.total, exitCode: evidence.exitCode,
      command: evidence.command, checks: evidence.checks.map(({name, passed}) => ({name, passed})),
      verification: evidence.verification ? Object.fromEntries(['kind', 'definitionSha256', 'verifierSha256', 'requirementsSha256', 'image', 'tree'].map(key => [key, evidence.verification[key]])) : null } : null };
}

export function independentReviewStatus(workspace, run) {
  if (workspace.provider !== 'cloudflare-artifacts') return { state: 'unavailable', passed: false, label: 'Independent review requires authenticated hosted identities' };
  const review = run.codeReview;
  if (run.status !== 'merged' && workspace.reviewRequests?.[run.id] === 'reviewer-unavailable') {
    return {state:'invalid',passed:false,label:'Reviewer access changed; a current independent assessment is required'};
  }
  if (!review && run.status === 'merged') return { state: 'historical', passed: false, label: 'No independent code review recorded for this historical merge' };
  if (!review) return { state: 'pending', passed: false, label: 'Independent code review required' };
  if (review.format !== 'projects-code-review-assessment/v2') return { state: 'historical', passed: false, label: 'Earlier prose assessment needs a current structured review' };
  const identity = review.identity;
  const assignment = run.reviewAssignments?.at(-1);
  if (!assignment || review.assignmentId !== assignment.id || !assignment.reviewerIds.includes(identity?.id)) {
    return {state:'historical',passed:false,label:'A current reviewer assignment and assessment are required'};
  }
  const independent = authenticatedReviewer(workspace,identity)
    && !workspace.runs.some(other => other.taskId === run.taskId && other.agentIdentity?.id === identity.id && other.agentIdentity?.issuer === identity.issuer);
  if (!independent) return { state: 'invalid', passed: false, label: 'Independent reviewer identity required' };
  if (run.verificationPending || !repositoryObservationCurrent(workspace,run)
    || JSON.stringify(review.context) !== JSON.stringify(independentReviewBinding(workspace, run))) {
    return { state: 'stale', passed: false, label: 'Independent code review is stale' };
  }
  if (review.unresolvedFindingIds?.length) return {state:'changes-requested',passed:false,label:'Earlier blocking findings still need a fresh reviewer resolution'};
  return review.verdict === 'pass' ? { state: 'passed', passed: true, label: 'Independent code review passed' }
    : { state: 'changes-requested', passed: false, label: 'Independent reviewer requested changes' };
}
