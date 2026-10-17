import { dependencyState } from '../../public/task-dependencies.js';
import { createHash } from 'node:crypto';
import { independentReviewBinding, independentReviewStatus,repositoryObservationCurrent, automaticMergePolicyCurrent,authenticatedReviewer } from '../../public/review-boundary.js';
export { independentReviewStatus } from '../../public/review-boundary.js';

export class WorkflowError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'WorkflowError';
    this.code = code;
    this.status = status;
  }
}

const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();
export const MAX_ACTIVE_RUNS = 4;

function requireThat(condition, code, message, status = 409) {
  if (!condition) throw new WorkflowError(code, message, status);
}

function text(value, label, max = 4000) {
  requireThat(typeof value === 'string' && value.trim().length > 0 && value.length <= max,
    'invalid_input', `${label} must be nonempty text of at most ${max} characters.`, 422);
  return value.trim();
}

export function validateCommit(value) {
  requireThat(typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value),
    'invalid_commit', 'Use a full lowercase Git commit ID.', 422);
  return value;
}

function taskFor(state, id) {
  const task = state.tasks.find(item => item.id === id);
  requireThat(task, 'task_not_found', 'Task not found.', 404);
  return task;
}

function runFor(state, id) {
  const run = state.runs.find(item => item.id === id);
  requireThat(run, 'run_not_found', 'Agent run not found.', 404);
  return run;
}

function event(state, type, message, taskId = null, runId = null) {
  state.version += 1;
  state.events.push({ id: uuid(), at: now(), type, taskId, runId, message });
}

function refreshTask(state, task) {
  if (task.mergedCommit) task.status = 'merged';
  else if (task.acceptedRunId) task.status = 'accepted';
  else {
    const runs = state.runs.filter(run => run.taskId === task.id);
    task.status = runs.some(run => ['assigned', 'running'].includes(run.status)) ? 'running'
      : runs.length ? 'review' : 'open';
  }
}

export function createWorkspace({ id = uuid(), name = 'Projects Git', provider = 'local-git' } = {}) {
  requireThat(['local-git', 'cloudflare-artifacts'].includes(provider), 'invalid_provider', 'Unknown repository provider.', 422);
  return { schemaVersion: 1, id: text(id, 'Workspace ID', 100), name: text(name, 'Workspace name', 160),
    provider, createdAt: now(), version: 0, tasks: [], runs: [], events: [] };
}

export function createTask(state, { id = uuid(), title, purpose, criteria, baseCommit, owner = null, repositoryKey = null }) {
  requireThat(typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id) && !state.tasks.some(task => task.id === id), 'invalid_task_id', 'Task ID must be a new UUID.', 422);
  requireThat(Array.isArray(criteria) && criteria.length > 0 && criteria.length <= 12,
    'invalid_criteria', 'Provide 1 to 12 acceptance criteria.', 422);
  const task = { id, title: text(title, 'Title', 180), purpose: text(purpose, 'Purpose'),
    criteria: criteria.map(value => text(value, 'Criterion', 500)), baseCommit: validateCommit(baseCommit),
    status: 'open', createdAt: now(), acceptedRunId: null, mergedCommit: null,
    owner: owner === null ? null : text(owner, 'Task owner', 100), ownerVersion: owner === null ? 0 : 1,
    repositoryKey: repositoryKey === null ? null : text(repositoryKey, 'Repository key', 200) };
  state.tasks.push(task);
  task.revision = 1;
  task.revisions = [{ revision: 1, purpose: task.purpose, criteria: [...task.criteria], reason: 'Task created', at: task.createdAt }];
  event(state, 'task.created', `Task created: ${task.title}`, task.id);
  return task;
}

export function setTaskOwner(state, taskId, { owner, expectedOwnerVersion }) {
  const task = taskFor(state, taskId);
  const name = text(owner, 'Task owner', 100);
  requireThat(expectedOwnerVersion === (task.ownerVersion ?? 0), 'stale_owner', 'Task ownership changed. Read the current owner.');
  requireThat(!task.mergedCommit, 'task_merged', 'Ownership of a merged task is retained as history.');
  requireThat(!state.runs.some(run => run.taskId === taskId && ['assigned', 'running'].includes(run.status)), 'work_in_progress', 'Wait for assigned work to finish before changing its owner.');
  requireThat(name !== task.owner, 'unchanged_owner', 'This owner is already recorded.');
  task.ownerHistory ??= [];
  task.ownerHistory.push({ owner: task.owner ?? null, version: task.ownerVersion ?? 0, at: now() });
  task.owner = name;
  task.ownerVersion = (task.ownerVersion ?? 0) + 1;
  task.acceptedRunId = null;
  for (const run of state.runs.filter(item => item.taskId === taskId && item.status === 'accepted')) {
    run.reviewHistory ??= []; run.reviewHistory.push(run.review); run.review = null; run.status = 'awaiting_review';
  }
  refreshTask(state, task);
  event(state, 'task.owner_changed', `Task owner set to ${name}. Earlier decisions are retained; acceptance requires a current review.`, taskId);
  return task;
}

// Built from one current snapshot and discarded after the read. Never retain an
// index across workflow mutations or use presentation results as authorization.
function coordinationIndex(state) {
  const tasks = new Map(), runs = new Map(), byTask = new Map(), byRepository = new Map(), missingTasks = [];
  for (const task of state.tasks) if (!tasks.has(task.id)) tasks.set(task.id, task);
  const append = (map, key, entry) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(entry);
  };
  state.runs.forEach((run, position) => {
    if (!runs.has(run.id)) runs.set(run.id, run);
    if (run.status === 'superseded') return;
    const entry = {run, position}, task = tasks.get(run.taskId);
    append(byTask, run.taskId, entry);
    if (!task) { missingTasks.push(run); return; }
    if (task.repositoryKey) {
      if (!byRepository.has(task.repositoryKey)) byRepository.set(task.repositoryKey, new Map());
      append(byRepository.get(task.repositoryKey), run.baseCommit, entry);
    }
  });
  return {tasks, runs, byTask, byRepository, missingTasks};
}

function relatedRuns(index, task, run) {
  // The existing repository comparison refuses a missing related task. Keep
  // that refusal even when an orphan's base would otherwise exclude it.
  if (task.repositoryKey) requireThat(!index.missingTasks.some(other => other.id !== run.id), 'task_not_found', 'Task not found.', 404);
  const taskRuns = index.byTask.get(task.id) ?? [];
  const baseRuns = task.repositoryKey ? index.byRepository.get(task.repositoryKey)?.get(run.baseCommit) ?? [] : [];
  const related = [];
  let left = 0, right = 0;
  // Both lists already follow retained order. Merge their union without
  // duplicating a candidate present in both lists or sorting every result.
  while (left < taskRuns.length || right < baseRuns.length) {
    let entry;
    if (right === baseRuns.length || left < taskRuns.length && taskRuns[left].position < baseRuns[right].position) entry = taskRuns[left++];
    else {
      entry = baseRuns[right++];
      if (left < taskRuns.length && taskRuns[left].position === entry.position) left++;
    }
    if (entry.run.id !== run.id) related.push(entry.run);
  }
  return related;
}

/** Same-file overlap is a review signal, not a claim of semantic merge conflict. */
function coordinatedRun(state, runId, index) {
  const run = index.runs.get(runId);
  requireThat(run, 'run_not_found', 'Agent run not found.', 404);
  const task = index.tasks.get(run.taskId);
  requireThat(task, 'task_not_found', 'Task not found.', 404);
  const related = relatedRuns(index, task, run);
  const overlaps = related.filter(other => other.headCommit && other.status !== 'rejected').map(other => ({ runId: other.id, taskId: other.taskId,
    headCommit: other.headCommit, label: other.label, status: other.status,
    paths: run.changedFiles.filter(file => other.changedFiles.some(path => file === path || file.startsWith(path + '/') || path.startsWith(file + '/'))) })).filter(item => item.paths.length);
  const result = { activeRunIds: related.filter(other => ['assigned', 'running'].includes(other.status)).map(other => other.id), overlaps,
    blockingRunIds: overlaps.filter(other => other.taskId !== task.id && ['accepted', 'merged'].includes(other.status)).map(other => other.runId) };
  // The snapshot and review transition use the same prerequisites. Browser
  // hints never replace the server's current head/revision/owner/comparison checks.
  result.acceptance = acceptanceRequirements(task, run, result);
  if (state.provider === 'cloudflare-artifacts') {
    const review = independentReviewStatus(state, run);
    result.acceptance.push({ code: 'independent_review_required', met: review.passed,
      label: review.label, message: 'Obtain a passing independent code review of this commit, requirements and verification policy before owner acceptance.' });
  }
  if (state.projects?.[task.projectId]) result.acceptance.push({ code: 'project_advanced', met: state.projects[task.projectId].mainCommit === task.baseCommit
    && (!state.projects[task.projectId].repositoryObservation || state.projects[task.projectId].repositoryObservation.headCommit === task.baseCommit),
    label: 'Task includes the current project main', message: 'Project main advanced. Update the task base and verify the resulting candidate before acceptance.' });
  return result;
}

export function coordination(state, runId) {
  return coordinatedRun(state, runId, coordinationIndex(state));
}

export function workspaceCoordination(state) {
  const index = coordinationIndex(state);
  return Object.fromEntries(state.runs.map(run => [run.id, coordinatedRun(state, run.id, index)]));
}

function acceptanceRequirements(task, run, related) {
  const evidence = run.evidence;
  return [
    { code: 'repository_head_changed', met: !run.repositoryObservation?.requiresSubmission, label: 'Observed repository head matches authenticated submission', message: 'New code was pushed. Prepare and submit a fresh assigned candidate before checks, review and acceptance.' },
    { code: 'stale_base', met: run.baseCommit === task.baseCommit, label: 'Candidate uses the current task base', message: 'This candidate belongs to an earlier task base. Review the replacement candidate.' },
    { code: 'already_accepted', met: !task.mergedCommit && (!task.acceptedRunId || task.acceptedRunId === run.id && Boolean(run.review?.policy)),
      label: run.review?.policy ? 'An unmerged policy decision can be replaced by the owner' : 'No candidate has already been chosen', message: 'This task already has an accepted candidate.' },
    { code: 'verification_required', met: Boolean(!run.verificationPending && evidence?.verified && evidence.commit === run.headCommit), label: 'Independent verification at this commit', message: 'Finish independent verification of the exact commit before acceptance.' },
    { code: 'stale_evidence', met: Boolean(evidence && (evidence.taskRevision ?? 1) === (task.revision ?? 1)), label: 'Checks cover the current requirements', message: 'The requirements changed. Reverify the retained commit against the current task.' },
    { code: 'checks_failed', met: Boolean(evidence && evidence.passed === evidence.total && evidence.total > 0 && evidence.exitCode === 0), label: 'Every required check passes', message: 'Every required check must pass before acceptance.' },
    { code: 'owner_required', met: Boolean(task.owner), label: 'A task owner is recorded', message: 'Review under the current named task owner.' },
    { code: 'work_in_progress', met: related.activeRunIds.length === 0, label: 'Related agents have finished', message: 'Wait for related assigned work to finish before choosing a candidate.' },
    { code: 'overlap_blocked', met: related.blockingRunIds.length === 0, label: 'No other task has reserved overlapping work', message: 'Another task already accepted overlapping work from this base. Reconcile that decision and base first.' },
  ];
}

function comparedHeads(state, run) {
  return coordination(state, run.id).overlaps.map(({ runId, headCommit }) => ({ runId, headCommit })).sort((a, b) => a.runId.localeCompare(b.runId));
}

export function reviseTask(state, taskId, { expectedRevision, purpose, criteria, reason }) {
  const task = taskFor(state, taskId);
  const revision = task.revision ?? 1; // Durable version-1 workspaces predate task revisions.
  requireThat(expectedRevision === revision, 'stale_requirements', 'The task requirements changed. Read the current revision.');
  requireThat(!task.mergedCommit, 'task_merged', 'Create a new task for changes after merge.');
  requireThat(Array.isArray(criteria) && criteria.length > 0 && criteria.length <= 12, 'invalid_criteria', 'Provide 1 to 12 criteria.', 422);
  const nextPurpose = text(purpose, 'Purpose');
  const nextCriteria = criteria.map(value => text(value, 'Criterion', 500));
  const explanation = text(reason, 'Reason for revision', 2000);
  requireThat(nextPurpose !== task.purpose || JSON.stringify(nextCriteria) !== JSON.stringify(task.criteria), 'unchanged_requirements', 'The proposed requirements are unchanged.');
  task.revisions ??= [{ revision, purpose: task.purpose, criteria: [...task.criteria], reason: 'Original retained task', at: task.createdAt }];
  task.revision = revision + 1;
  task.purpose = nextPurpose;
  task.criteria = nextCriteria;
  task.revisions.push({ revision: task.revision, purpose: nextPurpose, criteria: [...nextCriteria], reason: explanation, at: now() });
  task.acceptedRunId = null;
  for (const run of state.runs.filter(item => item.taskId === taskId && item.status === 'accepted')) {
    run.reviewHistory ??= [];
    run.reviewHistory.push(run.review);
    run.review = null;
    run.status = 'awaiting_review';
  }
  refreshTask(state, task);
  event(state, 'task.revised', `Requirements advanced from revision ${revision} to ${task.revision}: ${explanation}. Prior commits and evidence are retained; acceptance requires current verification.`, taskId);
  return task;
}

export function assignRun(state, taskId, { agent, label, branch, repository = null }) {
  const task = taskFor(state, taskId);
  requireTaskDependencies(state, task);
  requireThat(!task.acceptedRunId && !task.mergedCommit, 'task_closed', 'This task already has an accepted result.');
  requireThat(task.owner, 'owner_required', 'Assign a task owner before assigning agent work.');
  requireThat(!task.repositoryKey || !state.tasks.some(other => other.id !== task.id && other.repositoryKey === task.repositoryKey
    && other.baseCommit === task.baseCommit && (other.acceptedRunId || other.mergedCommit)),
    'repository_reserved', 'Another task has an accepted or merged result for this repository base. Reconcile that decision before assigning new work.');
  const run = { id: uuid(), taskId, agent: text(agent, 'Agent', 100), label: text(label, 'Agent label', 160),
    branch: text(branch, 'Branch', 250), repository: repository === null ? null : text(repository, 'Repository', 1000),
    status: 'assigned', baseCommit: task.baseCommit, headCommit: null, ownerVersion: task.ownerVersion,
    startedAt: null, finishedAt: null, changedFiles: [], diff: '', summary: '', evidence: null, review: null, error: null };
  state.runs.push(run);
  run.assignedRevision = task.revision ?? 1;
  refreshTask(state, task);
  event(state, 'run.assigned', `${run.label} assigned an isolated repository.`, taskId, run.id);
  return run;
}

/** Advance unfinished work explicitly; older commits, reports and decisions remain evidence. */
export function updateTaskBase(state, taskId, { expectedBaseCommit, baseCommit, sourceRunId }) {
  const task = taskFor(state, taskId), source = runFor(state, sourceRunId);
  validateCommit(baseCommit);
  requireThat(task.baseCommit === expectedBaseCommit && baseCommit !== expectedBaseCommit, 'stale_base', 'Read the current task and project bases before updating.');
  requireThat(!task.mergedCommit && source.taskId === taskId && source.baseCommit === task.baseCommit && source.headCommit,
    'task_closed', 'Choose an unmerged candidate from the current task base.');
  requireThat(!state.runs.some(run => run.taskId === taskId && ['assigned', 'running'].includes(run.status)), 'work_in_progress', 'Finish assigned task work before updating its base.');
  task.baseHistory ??= [];
  task.baseHistory.push({ baseCommit: task.baseCommit, revision: task.revision, acceptedRunId: task.acceptedRunId, sourceRunId, at: now() });
  task.baseCommit = baseCommit; task.acceptedRunId = null; task.revision = (task.revision ?? 1) + 1;
  task.revisions.push({ revision: task.revision, purpose: task.purpose, criteria: [...task.criteria], reason: 'Updated to project main; new checks and review required', at: now() });
  for (const run of state.runs.filter(run => run.taskId === taskId && run.status !== 'superseded')) {
    if (run.review) { run.reviewHistory ??= []; run.reviewHistory.push(run.review); run.review = null; }
    run.status = 'superseded';
  }
  refreshTask(state, task);
  event(state, 'task.base_updated', `Task updated to project main ${baseCommit}. Previous candidates are retained; verification and acceptance must be renewed.`, taskId);
  return task;
}

export function startRun(state, runId) {
  const run = runFor(state, runId);
  requireThat(run.status === 'assigned', 'invalid_transition', 'Only an assigned run may start.');
  const task = taskFor(state, run.taskId);
  requireTaskDependencies(state, task);
  requireThat(task.owner && run.ownerVersion === task.ownerVersion, 'stale_owner', 'Assign work under the current task owner.');
  requireThat(run.assignedRevision === (task.revision ?? 1), 'stale_requirements', 'The queued requirements changed. Start a newly authorized assignment.');
  requireThat(state.runs.filter(item => item.status === 'running').length < MAX_ACTIVE_RUNS, 'capacity_full', 'All four execution slots are occupied. Retain this assignment until a slot is available.');
  run.status = 'running';
  run.startedAt = now();
  refreshTask(state, taskFor(state, run.taskId));
  event(state, 'run.started', `${run.label} started work from ${run.baseCommit.slice(0, 12)}.`, run.taskId, run.id);
  return run;
}

export function requireTaskDependencies(state, task) {
  const result = dependencyState(state, task);
  requireThat(!result.invalid, 'invalid_dependency_state', result.invalid ?? 'Invalid prerequisites.');
  requireThat(result.ready, 'dependency_waiting', 'Wait for prerequisite integration: ' + result.waiting.map(item => item.title).join(', ') + '. Acceptance alone does not unblock this task.');
  return result;
}

function candidateResult(baseCommit, { headCommit, changedFiles, diff, summary }) {
  const head = validateCommit(headCommit);
  requireThat(head !== baseCommit, 'empty_change', 'A result must contain a new commit.', 422);
  requireThat(Array.isArray(changedFiles) && changedFiles.length > 0 && changedFiles.length <= 100,
    'invalid_changes', 'Provide 1 to 100 changed file paths.', 422);
  const files = changedFiles.map(value => {
    const path = text(value, 'Changed file', 500);
    requireThat(path === value && !path.startsWith('/') && !path.includes('\\') && !path.split('/').includes('..'),
      'invalid_changes', 'Changed paths must be relative and stay inside the repository.', 422);
    return path;
  });
  requireThat(typeof diff === 'string' && diff.length <= 200000, 'invalid_diff', 'Diff exceeds the display limit.', 422);
  const resultSummary = text(summary, 'Summary', 2000);
  return { headCommit: head, changedFiles: [...new Set(files)], diff, summary: resultSummary };
}

/** Record existing committed work without inventing an agent execution or verification. */
export function recordGitCandidate(state, taskId, { id = uuid(), branch, ...result }) {
  const task = taskFor(state, taskId);
  requireThat(!task.acceptedRunId && !task.mergedCommit, 'task_closed', 'This task already has an accepted result.');
  requireThat(typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id) && !state.runs.some(run => run.id === id), 'invalid_run_id', 'Candidate ID must be a new UUID.', 422);
  const run = { id, taskId, origin: 'existing-git', agent: 'not-recorded', label: 'Existing Git change',
    branch: text(branch, 'Branch', 250), repository: null, baseCommit: task.baseCommit,
    ...candidateResult(task.baseCommit, result), status: 'awaiting_review', assignedRevision: task.revision ?? 1,
    startedAt: null, finishedAt: null, evidence: null, review: null, error: null };
  state.runs.push(run);
  refreshTask(state, task);
  event(state, 'run.imported', `Existing Git change recorded at ${run.headCommit.slice(0, 12)}; execution and checks were not performed.`, taskId, run.id);
  return run;
}

export function completeRun(state, runId, result) {
  const run = runFor(state, runId);
  requireThat(run.status === 'running', 'invalid_transition', 'Only a running agent may submit a result.');
  Object.assign(run, candidateResult(run.baseCommit, result));
  run.status = 'awaiting_review';
  run.finishedAt = now();
  refreshTask(state, taskFor(state, run.taskId));
  event(state, 'run.completed', `${run.label} submitted commit ${run.headCommit.slice(0, 12)} for verification.`, run.taskId, run.id);
  return run;
}

export function verifyRun(state, runId, evidence) {
  const run = runFor(state, runId);
  const task = taskFor(state, run.taskId);
  requireThat(run.status === 'awaiting_review', 'invalid_transition', 'Only submitted work may be verified.');
  requireThat(evidence && typeof evidence === 'object', 'invalid_evidence', 'Evidence is required.', 422);
  requireThat(validateCommit(evidence.commit) === run.headCommit, 'stale_evidence', 'Evidence must name the exact submitted commit.');
  requireThat(['independent-local-checks', 'independent-sandbox-checks', 'hosted-harness-report'].includes(evidence.source),
    'invalid_evidence', 'Evidence must identify its verification source.', 422);
  requireThat(Array.isArray(evidence.checks) && evidence.checks.length > 0 && evidence.checks.length <= 100,
    'invalid_evidence', 'Evidence must contain 1 to 100 checks.', 422);
  const checks = evidence.checks.map(check => {
    requireThat(check && typeof check.passed === 'boolean' && typeof check.detail === 'string' && check.detail.length <= 2000,
      'invalid_evidence', 'Each check must have a boolean result and bounded detail.', 422);
    return { name: text(check.name, 'Check name', 200), passed: check.passed, detail: check.detail };
  });
  const passed = checks.filter(check => check.passed).length;
  requireThat(evidence.total === checks.length && evidence.passed === passed,
    'denominator_mismatch', 'Evidence counts must match the individual check results.', 422);
  requireThat(Number.isInteger(evidence.exitCode) && evidence.exitCode >= 0 && evidence.exitCode <= 255,
    'invalid_evidence', 'Evidence must include a process exit code.', 422);
  requireThat(typeof evidence.verified === 'boolean', 'invalid_evidence', 'Specify whether evidence was independently verified.', 422);
  requireThat(!evidence.verified || ['independent-local-checks', 'independent-sandbox-checks'].includes(evidence.source),
    'untrusted_verifier', 'A hosted agent report alone cannot establish independent verification.', 422);
  requireThat(typeof evidence.output === 'string' && evidence.output.length <= 100000,
    'invalid_evidence', 'Check output exceeds the evidence limit.', 422);
  requireThat(typeof evidence.verifiedAt === 'string' && Number.isFinite(Date.parse(evidence.verifiedAt)),
    'invalid_evidence', 'Evidence must include its verification timestamp.', 422);
  const revision = evidence.taskRevision ?? run.assignedRevision ?? 1;
  requireThat(Number.isInteger(revision) && revision >= 1 && revision <= (task.revision ?? 1), 'invalid_revision', 'Evidence must identify an existing task revision.', 422);
  const command = text(evidence.command, 'Verification command', 1000);
  let verification;
  if (evidence.verification !== undefined) {
    const value = evidence.verification;
    requireThat(value?.kind === 'repository-command-checks/v1' && ['definitionSha256', 'verifierSha256', 'inputHandoffSha256', 'requirementsSha256'].every(key => /^[a-f0-9]{64}$/.test(value[key]))
      && /^sha256:[a-f0-9]{64}$/.test(value.image) && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.tree), 'invalid_evidence', 'Repository verification provenance is invalid.', 422);
    verification = Object.fromEntries(['kind', 'definitionSha256', 'verifierSha256', 'inputHandoffSha256', 'requirementsSha256', 'image', 'tree'].map(key => [key, value[key]]));
  }
  if (run.evidence) { run.evidenceHistory ??= []; run.evidenceHistory.push(run.evidence); }
  run.evidence = { verified: evidence.verified, commit: evidence.commit, passed, total: checks.length,
    checks, command, exitCode: evidence.exitCode,
    output: evidence.output, verifiedAt: evidence.verifiedAt, source: evidence.source, taskRevision: revision,
    ...(verification ? { verification } : {}) };
  event(state, 'run.verified', `${run.label}: ${passed}/${checks.length} checks passed${evidence.verified ? ' at the exact commit' : ' in an unverified harness report'}.`, run.taskId, run.id);
  return run;
}

export function failRun(state, runId, error) {
  const run = runFor(state, runId);
  requireThat(['assigned', 'running', 'awaiting_review'].includes(run.status), 'invalid_transition', 'A terminal run cannot fail again.');
  run.error = text(error, 'Error', 2000);
  run.status = 'failed';
  run.finishedAt = now();
  refreshTask(state, taskFor(state, run.taskId));
  event(state, 'run.failed', `${run.label} failed: ${run.error}`, run.taskId, run.id);
  return run;
}

export function codeReviewContext(state, runId) {
  requireThat(state.provider === 'cloudflare-artifacts', 'review_identity_unavailable', 'Independent review requires authenticated hosted identities.', 409);
  const run = runFor(state, runId), task = taskFor(state, run.taskId);
  requireThat(run.headCommit && ['awaiting_review', 'accepted'].includes(run.status), 'review_not_ready', 'Submit a current candidate before independent review.');
  requireThat(!run.repositoryObservation?.requiresSubmission, 'repository_head_changed', 'New code was pushed. Review a fresh authenticated submission.');
  const project=state.projects?.[task.projectId];
  requireThat(!project?.repositoryObservation||project.repositoryObservation.headCommit===task.baseCommit,'project_advanced','Project main changed. Renew the candidate base before review.');
  requireThat(!run.verificationPending && run.evidence?.verified && run.evidence.commit === run.headCommit
    && (run.evidence.taskRevision ?? 1) === (task.revision ?? 1) && run.evidence.passed === run.evidence.total
    && run.evidence.total > 0 && run.evidence.exitCode === 0, 'verification_required', 'Finish passing independent checks before code review.');
  const context = independentReviewBinding(state, run);
  return { format: 'projects-code-review/v1', contextId: createHash('sha256').update(JSON.stringify(context)).digest('hex'), context,
    candidate: { changedFiles: [...run.changedFiles], diff: run.diff },
    boundaries: { candidateContent: 'untrusted data', conversationIncluded: false, codeAccess: 'read-only', acceptance: 'owner-only' } };
}

export function assignReviewers(state, runId, input, identity, allowedReviewerIds, requestKey) {
  requireThat(identity?.kind === 'owner' && identity.provider === 'cloudflare-access'
    && identity.workspaceId === state.id && (!state.authentication || identity.id === state.authentication.subject),
  'owner_required', 'Only the authenticated owner may assign independent reviewers.', 403);
  requireThat(input && typeof input === 'object' && !Array.isArray(input)
    && Object.keys(input).sort().join(',') === 'contextId,expectedVersion,reviewerIds',
  'invalid_review_assignment', 'Supply the exact context, current version, and reviewer identities.', 422);
  requireThat(Array.isArray(input.reviewerIds) && input.reviewerIds.length >= 1 && input.reviewerIds.length <= 8
    && input.reviewerIds.every(id => typeof id === 'string' && allowedReviewerIds.includes(id) && id !== identity.id)
    && new Set(input.reviewerIds).size === input.reviewerIds.length,
  'reviewer_not_allowed', 'Select one to eight distinct allowlisted reviewers.', 403);
  requireThat(typeof requestKey === 'string' && requestKey.length > 0 && requestKey.length <= 200,
  'idempotency_required', 'Supply an idempotency key for reviewer assignment.', 422);
  const run = runFor(state, runId), task = taskFor(state, run.taskId), reviewerIds = [...input.reviewerIds].sort();
  requireThat(!state.runs.some(other => other.taskId === task.id && reviewerIds.some(id => other.agentIdentity?.id === id)),
  'self_review', 'A task contributor cannot be assigned to review its alternatives.', 403);
  const priorRun = state.runs.find(candidate => candidate.reviewAssignments?.some(item => item.requestKey === requestKey
    && item.identity.id === identity.id && item.identity.issuer === identity.issuer));
  const retained = priorRun?.reviewAssignments.find(item => item.requestKey === requestKey
    && item.identity.id === identity.id && item.identity.issuer === identity.issuer);
  if (retained) {
    requireThat(priorRun.id === runId && retained.sourceContextId === input.contextId
      && JSON.stringify(retained.reviewerIds) === JSON.stringify(reviewerIds),
    'idempotency_conflict', 'This key already identifies a different reviewer assignment.', 409);
    return retained;
  }
  requireThat(input.expectedVersion === state.version, 'stale_review_assignment', 'Refresh the current task before assigning reviewers.', 409);
  const packet=codeReviewContext(state,runId);
  requireThat(packet.contextId === input.contextId, 'stale_code_review', 'The candidate changed. Read its current review context.');
  requireThat((run.reviewAssignments?.length ?? 0) < 50, 'review_assignment_history_full', 'This candidate retains 50 review assignments.', 409);
  const assignment={id:uuid(),at:now(),requestKey,sourceContextId:input.contextId,reviewerIds,
    identity:Object.fromEntries(['provider','kind','issuer','id','workspaceId','displayName'].map(key=>[key,identity[key]]))};
  run.reviewAssignments ??= [];run.reviewAssignments.push(assignment);
  assignment.contextId=codeReviewContext(state,runId).contextId;
  if(run.status==='accepted'){
    run.reviewHistory ??=[];if(run.review)run.reviewHistory.push(run.review);
    run.review=null;run.status='awaiting_review';task.acceptedRunId=null;
  }
  refreshTask(state,task);
  event(state,'run.review_assigned',`Owner assigned ${reviewerIds.length} independent reviewer(s).`,task.id,run.id);
  return assignment;
}

function reviewFindings(input, changedFiles) {
  requireThat(Array.isArray(input) && input.length <= 50, 'invalid_code_review', 'Supply at most 50 structured findings.', 422);
  return input.map((item, index) => {
    requireThat(item && typeof item === 'object' && !Array.isArray(item)
      && Object.keys(item).sort().join(',') === 'body,evidence,location,priority,title',
    'invalid_code_review', `Finding ${index + 1} has unsupported fields.`, 422);
    const {location} = item;
    requireThat(location && typeof location === 'object' && !Array.isArray(location)
      && Object.keys(location).sort().join(',') === 'endLine,path,side,startLine'
      && typeof location.path === 'string' && changedFiles.includes(location.path)
      && ['head', 'base'].includes(location.side)
      && Number.isSafeInteger(location.startLine) && location.startLine > 0
      && Number.isSafeInteger(location.endLine) && location.endLine >= location.startLine
      && location.endLine - location.startLine < 20,
    'invalid_review_location', `Finding ${index + 1} must point to a short changed-file range.`, 422);
    requireThat(Number.isInteger(item.priority) && item.priority >= 0 && item.priority <= 3,
      'invalid_code_review', 'Finding priority must be 0, 1, 2, or 3.', 422);
    return {title: text(item.title, 'Finding title', 160), body: text(item.body, 'Finding explanation', 2000),
      priority: item.priority, location: {...location}, evidence: text(item.evidence, 'Finding evidence', 2000)};
  });
}

export function validateReviewAssessment(input, changedFiles) {
  requireThat(input && typeof input === 'object' && !Array.isArray(input)
    && Object.keys(input).sort().join(',') === 'contextId,findings,format,resolvedPriorFindingIds,summary,verdict',
  'invalid_code_review', 'Submit only the structured assessment fields.', 422);
  requireThat(input.format === 'projects-code-review-assessment/v2', 'invalid_code_review', 'Use the structured assessment contract.', 422);
  requireThat(['pass', 'changes_requested'].includes(input.verdict), 'invalid_code_review', 'Choose pass or changes_requested.', 422);
  const summary = text(input.summary, 'Review summary', 2000);
  const findings = reviewFindings(input.findings, changedFiles);
  requireThat(Array.isArray(input.resolvedPriorFindingIds) && input.resolvedPriorFindingIds.length <= 1000
    && input.resolvedPriorFindingIds.every(id => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id))
    && new Set(input.resolvedPriorFindingIds).size === input.resolvedPriorFindingIds.length,
  'invalid_code_review', 'Resolved prior finding IDs must be distinct retained IDs.', 422);
  requireThat(input.verdict !== 'changes_requested' || findings.length > 0, 'invalid_code_review', 'Requested changes need a finding.', 422);
  requireThat(input.verdict !== 'pass' || findings.every(finding => finding.priority > 1),
    'invalid_code_review', 'A passing assessment cannot contain a P0 or P1 finding.', 422);
  return {format: input.format, contextId: input.contextId, verdict: input.verdict, summary, findings,
    resolvedPriorFindingIds:[...input.resolvedPriorFindingIds].sort()};
}

export function recordCodeReview(state, runId, input, identity, requestKey) {
  requireThat(authenticatedReviewer(state,identity),
  'reviewer_required', 'A separately authenticated reviewer is required.', 403);
  requireThat(!input || !['identity', 'reviewer', 'context', 'principal'].some(key => Object.hasOwn(input, key)),
    'identity_forged', 'Reviewer identity and review context are supplied by the server.', 422);
  const run = runFor(state, runId), task = taskFor(state, run.taskId);
  requireThat(!state.runs.some(other => other.taskId === task.id && other.agentIdentity?.id === identity.id && other.agentIdentity?.issuer === identity.issuer),
    'self_review', 'A task contributor cannot independently review its candidates.', 403);
  const {summary, findings, resolvedPriorFindingIds} = validateReviewAssessment(input, run.changedFiles);
  requireThat(typeof requestKey === 'string' && requestKey.length > 0 && requestKey.length <= 200,
    'idempotency_required', 'Supply an idempotency key for this assessment.', 422);
  const priorRun = state.runs.find(candidate => [candidate.codeReview, ...(candidate.codeReviewHistory ?? [])].some(item => item?.requestKey === requestKey
    && item.identity.id === identity.id && item.identity.issuer === identity.issuer));
  const retained = priorRun && [priorRun.codeReview, ...(priorRun.codeReviewHistory ?? [])].find(item => item?.requestKey === requestKey
    && item.identity.id === identity.id && item.identity.issuer === identity.issuer);
  // A lost response can recover its own immutable receipt even after acceptance
  // or merge. This does not replace the current assessment or authorize anything.
  if (retained) {
    requireThat(priorRun.id === runId && retained.contextId === input.contextId && retained.verdict === input.verdict
      && retained.summary === summary && Array.isArray(retained.findings)
      && JSON.stringify(retained.resolvedPriorFindingIds??[]) === JSON.stringify(resolvedPriorFindingIds)
      && JSON.stringify(retained.findings.map(({id, oid, ...finding}) => finding)) === JSON.stringify(findings),
      'idempotency_conflict', 'This idempotency key already identifies a different assessment.', 409);
    return {...run, codeReview: retained};
  }
  const assignment = run.reviewAssignments?.at(-1);
  requireThat(assignment?.reviewerIds.includes(identity.id) && assignment.contextId === input.contextId,
    'review_assignment_required', 'This reviewer needs a current owner assignment.', 403);
  const outstanding=Array.isArray(run.codeReview?.unresolvedFindingIds) ? run.codeReview.unresolvedFindingIds
    : Array.isArray(run.codeReview?.findings) ? run.codeReview.findings.filter(finding=>finding.priority<=1).map(finding=>finding.id) : [];
  requireThat(resolvedPriorFindingIds.every(id=>outstanding.includes(id)),
    'unknown_prior_finding', 'A resolved finding must be an unresolved finding in the previous assessment.', 422);
  requireThat(input.verdict !== 'pass' || outstanding.every(id=>resolvedPriorFindingIds.includes(id)),
    'unresolved_prior_findings', 'A passing assessment must explicitly address every retained blocking finding.', 409);
  const packet = codeReviewContext(state, runId);
  requireThat(input.contextId === packet.contextId, 'stale_code_review', 'The candidate, requirements, ownership or verification policy changed. Read a fresh review context.');
  requireThat((run.codeReviewHistory?.length ?? 0) + (run.codeReview ? 1 : 0) < 100,
    'review_history_full', 'This candidate retains 100 independent assessments. Preserve them and create new assigned work.', 409);
  const assessment = { id: uuid(), at: now(), requestKey, assignmentId: assignment.id, format: input.format, contextId: packet.contextId, context: packet.context,
    verdict: input.verdict, summary, resolvedPriorFindingIds, findings: findings.map(finding => ({...finding, id: uuid()})),
    identity: Object.fromEntries(['provider', 'kind', 'issuer', 'id', 'workspaceId', 'displayName'].map(key => [key, identity[key]])) };
  assessment.unresolvedFindingIds=[...outstanding.filter(id=>!resolvedPriorFindingIds.includes(id)),
    ...assessment.findings.filter(finding=>finding.priority<=1).map(finding=>finding.id)];
  if (run.codeReview) { run.codeReviewHistory ??= []; run.codeReviewHistory.push(run.codeReview); }
  run.codeReview = assessment;
  // A replaced assessment always needs a new owner decision, including legacy acceptance.
  if (run.status === 'accepted') {
    run.reviewHistory ??= []; if (run.review) run.reviewHistory.push(run.review);
    run.review = null; run.status = 'awaiting_review'; task.acceptedRunId = null;
  }
  refreshTask(state, task);
  event(state, 'run.code_reviewed', `Independent reviewer recorded ${input.verdict} for ${run.headCommit}. Owner acceptance remains separate.`, task.id, run.id);
  return run;
}

export function recordFindingDecision(state, runId, findingId, input, identity, requestKey) {
  requireThat(identity?.provider === 'cloudflare-access' && identity.kind === 'owner'
    && identity.workspaceId === state.id && typeof identity.id === 'string' && identity.id.length > 0,
  'owner_required', 'Only the authenticated owner may record a finding decision.', 403);
  requireThat(!state.authentication || identity.issuer === state.authentication.issuer && identity.id === state.authentication.subject,
    'owner_required', 'Finding decisions require this workspace owner.', 403);
  requireThat(input && typeof input === 'object' && !Array.isArray(input)
    && Object.keys(input).sort().join(',') === 'assessmentId,decision,expectedVersion,note',
  'invalid_finding_decision', 'Send the assessment, decision, current version, and note.', 422);
  requireThat(['resolved', 'deferred', 'dismissed'].includes(input.decision),
    'invalid_finding_decision', 'Choose resolved, deferred, or dismissed.', 422);
  const note = text(input.note, 'Finding decision note', 2000);
  requireThat(typeof requestKey === 'string' && requestKey.length > 0 && requestKey.length <= 200,
    'idempotency_required', 'Supply an idempotency key for this decision.', 422);
  const run = runFor(state, runId);
  const priorRun = state.runs.find(candidate => candidate.findingDecisions?.some(item => item.requestKey === requestKey
    && item.identity.id === identity.id && item.identity.issuer === identity.issuer));
  const retained = priorRun?.findingDecisions.find(item => item.requestKey === requestKey
    && item.identity.id === identity.id && item.identity.issuer === identity.issuer);
  if (retained) {
    requireThat(priorRun.id === runId && retained.assessmentId === input.assessmentId && retained.findingId === findingId
      && retained.decision === input.decision && retained.note === note,
    'idempotency_conflict', 'This idempotency key already identifies a different finding decision.', 409);
    return retained;
  }
  requireThat(input.expectedVersion === state.version, 'stale_finding_decision', 'Refresh the current review and its decision history before recording a decision.', 409);
  const assessment = [run.codeReview, ...(run.codeReviewHistory ?? [])].find(item => item?.id === input.assessmentId);
  requireThat(assessment && Array.isArray(assessment.findings)
    && assessment.findings.some(finding => finding.id === findingId),
  'finding_not_found', 'The finding is not part of a retained structured assessment.', 404);
  requireThat((run.findingDecisions?.length ?? 0) < 200, 'finding_history_full', 'This candidate retains 200 finding decisions.', 409);
  const decision = {id: uuid(), at: now(), requestKey, assessmentId: assessment.id, findingId,
    decision: input.decision, note, identity: Object.fromEntries(['provider', 'kind', 'issuer', 'id', 'workspaceId', 'displayName'].map(key => [key, identity[key]]))};
  run.findingDecisions ??= []; run.findingDecisions.push(decision);
  event(state, 'run.finding_decided', `Owner recorded ${input.decision} for finding ${findingId}. Independent assessment and acceptance remain separate.`, run.taskId, run.id);
  return decision;
}

export function reviewRun(state, runId, { decision, note, reviewer, headCommit, taskRevision = 1, ownerVersion, comparisons = [] }, identity) {
  return recordDecision(state, runId, { decision, note, reviewer, headCommit, taskRevision, ownerVersion, comparisons }, identity);
}

export function automaticApprovalEligible(state, runId) {
  const run = runFor(state, runId), task = taskFor(state, run.taskId);
  if (!automaticMergePolicyCurrent(state, state.projects?.[task.projectId]) || run.status !== 'awaiting_review') return false;
  // Do not silently choose between alternatives or compare overlapping code on an owner's behalf.
  if (state.runs.some(other => other.id !== run.id && other.taskId === run.taskId
    && ['assigned', 'running', 'awaiting_review', 'accepted'].includes(other.status))) return false;
  const related = coordination(state, runId);
  return related.overlaps.length === 0 && related.acceptance.every(rule => rule.met);
}

export function approveRunByPolicy(state, runId) {
  requireThat(automaticApprovalEligible(state, runId), 'automatic_approval_ineligible', 'Current policy, checks, independent review and one unambiguous candidate are required.');
  const run = runFor(state, runId), task = taskFor(state, run.taskId);
  const policy = { ...structuredClone(state.projects[task.projectId].automaticMergePolicy), projectId: task.projectId, decisionId: uuid() };
  return recordDecision(state, runId, { decision: 'accept', note: 'Approved automatically under the owner-enabled project policy after current checks and independent review.',
    reviewer: 'Automatic merge policy', headCommit: run.headCommit, taskRevision: task.revision ?? 1, ownerVersion: task.ownerVersion, comparisons: [] }, undefined, policy);
}

function recordDecision(state, runId, { decision, note, reviewer, headCommit, taskRevision, ownerVersion, comparisons }, identity, policy) {
  const run = runFor(state, runId);
  const task = taskFor(state, run.taskId);
  requireThat(run.status === 'awaiting_review' || !policy && run.status === 'accepted' && run.review?.policy,
    'invalid_transition', 'Only work awaiting review or an unmerged policy decision may receive a human decision.');
  requireThat(['accept', 'reject'].includes(decision), 'invalid_decision', 'Choose accept or reject.', 422);
  requireThat(validateCommit(headCommit) === run.headCommit, 'stale_review', 'The candidate changed. Review the current commit.');
  requireThat(taskRevision === (task.revision ?? 1), 'stale_requirements', 'Review the current task requirements before deciding.');
  const review = { decision, note: text(note, 'Review note', 2000), reviewer: text(reviewer, 'Reviewer', identity ? 320 : 100), at: now(), headCommit, taskRevision };
  if (identity) {
    requireThat(identity.provider === 'cloudflare-access' && identity.kind === 'owner' && identity.workspaceId === state.id
      && typeof identity.issuer === 'string' && typeof identity.id === 'string' && identity.id.length > 0, 'invalid_identity', 'Review identity must name this authenticated workspace owner.', 403);
    review.identity = Object.fromEntries(['provider', 'kind', 'issuer', 'id', 'workspaceId', 'displayName'].map(key => [key, identity[key]]));
  }
  if (policy) review.policy = policy;
  if (decision === 'accept') {
    const coordinationState = coordination(state, runId);
    for (const rule of coordinationState.acceptance) requireThat(rule.met, rule.code, rule.message);
    requireThat(ownerVersion === task.ownerVersion, 'owner_required', 'Review under the current named task owner.');
    const expected = comparedHeads(state, run);
    requireThat(Array.isArray(comparisons) && comparisons.length === expected.length
      && expected.every(item => comparisons.filter(value => value?.runId === item.runId && value.headCommit === item.headCommit && Object.keys(value).length === 2).length === 1),
      'comparison_required', 'Explicitly review the current overlapping candidate heads before acceptance.');
    review.ownerVersion = task.ownerVersion;
    if (state.provider === 'cloudflare-artifacts') review.codeReviewId = run.codeReview.id;
    review.comparisons = expected;
    task.acceptedRunId = run.id;
    run.status = 'accepted';
  } else run.status = 'rejected';
  if (run.review?.policy) {
    run.reviewHistory ??= []; run.reviewHistory.push(run.review);
    if (decision === 'reject') task.acceptedRunId = null;
  }
  run.review = review;
  refreshTask(state, task);
  event(state, policy ? 'run.automatically_accepted' : `run.${run.status}`, `${review.reviewer} ${decision === 'accept' ? 'accepted' : 'rejected'} ${run.label}: ${review.note}`, task.id, run.id);
  return run;
}

export function mergeRun(state, runId, { headCommit, baseCommit, mergedCommit }) {
  const run = runFor(state, runId);
  const task = taskFor(state, run.taskId);
  requireThat(!run.repositoryObservation?.requiresSubmission, 'repository_head_changed', 'New code was pushed after submission. Renew the submitted candidate and review before merge.');
  const project=state.projects?.[task.projectId];
  requireThat(!project?.repositoryObservation||project.repositoryObservation.headCommit===task.baseCommit,'project_advanced','Project main changed after review. Renew the candidate base before merging.');
  requireThat(run.status === 'accepted' && task.acceptedRunId === run.id && run.review?.decision === 'accept',
    'acceptance_required', 'Owner acceptance or an explicit automatic policy decision is required before merge.');
  requireThat(validateCommit(headCommit) === run.headCommit && run.review.headCommit === headCommit,
    'stale_merge', 'The candidate changed after review.');
  requireThat((run.review.taskRevision ?? 1) === (task.revision ?? 1) && (run.evidence?.taskRevision ?? 1) === (task.revision ?? 1),
    'stale_requirements', 'The requirements changed after verification or review.');
  requireThat(validateCommit(baseCommit) === task.baseCommit, 'stale_base', 'The base changed. Rebase and review new evidence.');
  requireThat(validateCommit(mergedCommit) === headCommit, 'invalid_merge', 'This prototype requires an exact fast-forward merge.');
  requireThat(task.owner && run.review.ownerVersion === task.ownerVersion, 'stale_owner', 'Ownership changed after review. Record a current decision.');
  requireThat(state.provider !== 'cloudflare-artifacts' || independentReviewStatus(state, run).passed && run.review.codeReviewId === run.codeReview?.id,
    'independent_review_required', 'Independent code review must remain current and bound to the owner acceptance.');
  const coordinationState = coordination(state, runId);
  requireThat(!coordinationState.activeRunIds.length && !coordinationState.blockingRunIds.length, 'overlap_blocked', 'Related work changed after review. Reconcile it before merging.');
  // Reject new/changed overlaps; a reviewed alternative may subsequently be rejected.
  requireThat(comparedHeads(state, run).every(item => run.review.comparisons?.some(saved => saved.runId === item.runId && saved.headCommit === item.headCommit)),
    'stale_comparison', 'Overlapping candidates changed after review. Record a new decision.');
  task.mergedCommit = mergedCommit;
  run.status = 'merged';
  refreshTask(state, task);
  event(state, 'run.merged', `${run.label} merged at ${mergedCommit.slice(0, 12)} after acceptance.`, task.id, run.id);
  return run;
}

export {metrics} from '../../public/workspace-metrics.js';
