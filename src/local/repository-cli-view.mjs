import { candidateOutcome, taskOutcome, taskQueued, independentlyVerified, mergeState, mergeIntentSummary, mergeReports, completedVerification, locationSearch, projectBrief } from '../../public/workbench-state.js';
import { requirementsDigest } from '../core/check-definition.mjs';
import { dependencyState } from '../../public/task-dependencies.js';

const active = run => ['assigned', 'running'].includes(run.status);
const reportedChecksPassing = run => Boolean(run.evidence && run.evidence.total > 0
  && run.evidence.passed === run.evidence.total && run.evidence.exitCode === 0);
export const browserLink = (url, view, taskId, runId) => new URL(locationSearch(view, taskId, runId), url).href;
const counter = (numerator, denominator, definition) => ({ numerator, denominator, definition });

export function projectSummary(workspace, projectId, url) {
  const project = Object.hasOwn(workspace.projects ?? {}, projectId) ? workspace.projects[projectId] : null;
  if (!project) throw new Error('Project not found. Run projects --url ' + url.origin + ' to discover current IDs.');
  return { ...project, admission: project.acceptingWork ? 'on' : 'off',
    browserUrl: browserLink(url, 'overview', workspace.tasks.find(task => task.projectId === projectId)?.id) };
}

export function candidateSummary(workspace, runId, url) {
  const run = workspace.runs.find(run => run.id === runId);
  if (!run) throw new Error('Candidate not found in the current workspace. Run status for its project.');
  const task = workspace.tasks.find(task => task.id === run.taskId);
  const prerequisites = workspace.coordination?.[run.id]?.acceptance;
  if (!task || !Array.isArray(prerequisites)) throw new Error('Workspace snapshot is missing task or acceptance prerequisites. Refresh the local controller before continuing.');
  const outcome = candidateOutcome(workspace, run), verified = independentlyVerified(workspace, run);
  const blockers = prerequisites.filter(rule => !rule.met).map(({ code, label, message }) => ({ code, label, message }));
  if (run.status !== 'awaiting_review') blockers.unshift({ code: 'candidate_not_reviewable',
    message: 'Acceptance requires a submitted candidate awaiting review; this candidate is ' + run.status + '.' });
  if (!verified && !blockers.some(rule => ['verification_required', 'stale_evidence'].includes(rule.code))) {
    blockers.push({ code: 'independent_verification_required', message: 'The report is not independent verification of the current head and requirements.' });
  }
  return { runId: run.id, taskId: task.id, label: run.label, origin: run.origin, status: run.status,
    headCommit: run.headCommit, baseCommit: run.baseCommit, revision: task.revision, branch: run.branch, checkout: run.repository,
    checks: run.evidence ? { verified: run.evidence.verified, passed: run.evidence.passed, total: run.evidence.total } : null,
    verification: { independentlyVerified: verified, pending: Boolean(run.verificationPending),
      reportCommit: run.evidence?.commit ?? null, reportRevision: run.evidence ? (run.evidence.taskRevision ?? 1) : null,
      taskRevision: task.revision, reportedChecksPassing: reportedChecksPassing(run), currentChecksPassing: verified && reportedChecksPassing(run) },
    outcome, blockerScope: 'acceptance', blockers,
    merge: { state: mergeState(workspace, run), reports: mergeReports(workspace, run),
      definition: 'Merge reports are retained attempt evidence; acceptance uses the separate run.evidence report.' },
    completedVerification: completedVerification(workspace, run),
    nextActions: [outcome.next, ...(run.status === 'awaiting_review' && !task.acceptedRunId && !task.mergedCommit
      ? [...blockers.map(rule => rule.message), 'Review checks and record a decision in the browser.'] : [])],
    decision: run.review ?? null, decisionHistory: run.reviewHistory ?? [],
    browserUrl: browserLink(url, run.status === 'merged' ? 'evidence' : active(run) ? 'work' : 'review', task.id, run.id) };
}

export function taskSummary(workspace, task, url) {
  const outcome = taskOutcome(workspace, task);
  return { taskId: task.id, title: task.title, revision: task.revision, status: task.status,
    baseCommit: task.baseCommit, queued: taskQueued(workspace, task), acceptedRunId: task.acceptedRunId,
    mergedCommit: task.mergedCommit, dependencies: dependencyState(workspace, task), outcome, nextActions: [outcome.action, outcome.detail],
    browserUrl: browserLink(url, outcome.view, task.id, outcome.runId) };
}

export function taskDetail(workspace, taskId, url) {
  const task = workspace.tasks.find(task => task.id === taskId);
  if (!task) throw new Error('Task not found in this workspace. Run status for its project to discover current task IDs.');
  return { task, requirementsSha256: requirementsDigest(task), ...taskSummary(workspace, task, url),
    candidates: workspace.runs.filter(run => run.taskId === taskId).map(run => ({ ...run, ...candidateSummary(workspace, run.id, url) })) };
}

export function projectStatus(workspace, projectId, url) {
  const project = projectSummary(workspace, projectId, url);
  const tasks = workspace.tasks.filter(task => task.projectId === projectId), taskIds = new Set(tasks.map(task => task.id));
  const runs = workspace.runs.filter(run => taskIds.has(run.taskId));
  const summaries = tasks.map(task => taskSummary(workspace, task, url));
  const queue = summaries.filter(task => task.queued).map(task => task.taskId);
  const candidates = runs.map(run => candidateSummary(workspace, run.id, url));
  const activeCandidates = candidates.filter(active);
  const decisions = summaries.filter(task => !task.mergedCommit && (task.acceptedRunId || runs.some(run => run.taskId === task.taskId && run.status === 'awaiting_review')));
  const reports = runs.filter(run => run.evidence);
  const eligibleQueue = queue.filter(id => dependencyState(workspace, tasks.find(task => task.id === id)).ready);
  const waitingQueue = queue.filter(id => !eligibleQueue.includes(id));
  return { project, workspaceVersion: workspace.version, mergeIntents: { scope: 'workspace', ...mergeIntentSummary(workspace) },
    commandBrief: projectBrief(workspace, projectId), tasks: summaries, queue, eligibleQueue, waitingQueue, candidates, activeCandidates, decisions,
    counters: {
      queuedTasks: counter(queue.length, tasks.length, 'Unassigned tasks / all project tasks, including merged tasks.'),
      eligibleQueuedTasks: counter(eligibleQueue.length, tasks.length, 'Unassigned tasks with every prerequisite integrated / all project tasks. Project admission and capacity still apply.'),
      waitingQueuedTasks: counter(waitingQueue.length, tasks.length, 'Unassigned tasks waiting on prerequisite integration / all project tasks.'),
      activeTasks: counter(tasks.filter(task => runs.some(run => run.taskId === task.id && active(run))).length, tasks.length, 'Tasks with assigned or running agents / all project tasks. Active and decision tasks can overlap.'),
      decisionTasks: counter(decisions.length, tasks.length, 'Unmerged tasks with a chosen or reviewable candidate / all project tasks; checks may still block acceptance.'),
      mergedTasks: counter(tasks.filter(task => task.mergedCommit).length, tasks.length, 'Explicitly merged tasks / all project tasks.'),
      activeCandidates: counter(activeCandidates.length, runs.length, 'Assigned or running candidates / all retained project candidates.'),
      reportedChecks: counter(reports.reduce((sum, run) => sum + run.evidence.passed, 0), reports.reduce((sum, run) => sum + run.evidence.total, 0), 'Passing reported checks / all reported checks, including stale reports and superseded candidates.'),
      candidatesWithReports: counter(reports.length, runs.length, 'Candidates with a retained check report / all retained project candidates.'),
      currentIndependentReports: counter(candidates.filter(run => run.verification.independentlyVerified).length, runs.length, 'Reports independently verified at the current head and requirements / all retained project candidates. Checks may fail.'),
      currentPassingCandidates: counter(candidates.filter(run => run.verification.currentChecksPassing).length, runs.length, 'Candidates with current independent verification and every reported check passing / all retained project candidates. Human review remains separate.'),
      acceptedCandidates: counter(runs.filter(run => ['accepted', 'merged'].includes(run.status)).length, runs.length, 'Currently accepted or merged candidates / all retained project candidates, including superseded alternatives.'),
    },
    capacity: { scope: 'workspace', ...workspace.capacity },
    browserUrl: project.browserUrl };
}
