// Pure presentation selectors. Workflow mutations and admission remain in core/workflow.mjs.
import { dependencyState } from './task-dependencies.js';
import { independentReviewStatus,repositoryObservationCurrent } from './review-boundary.js';
export { dependencyState } from './task-dependencies.js';

/** A successful connection stays steady during routine background reads. */
export function connectionLabel({loading, error, lastSyncedAt}) {
  if (error) return loading ? 'Reconnecting…' : error.auth ? 'Authentication required' : error.accessLost ? 'Workspace access required' : 'Connection interrupted';
  return lastSyncedAt ? 'Workspace connected' : 'Connecting…';
}

/** Transient operation state comes from the read-only workspace snapshot. */
export function mergeState(workspace, run) {
  const states = workspace.mergeStateByRun ?? {};
  const value = Object.hasOwn(states, run.id) ? states[run.id] : null;
  return ['running', 'recovery-required'].includes(value) ? value : null;
}

export function mergeIntentSummary(workspace) {
  // The state map covers the workspace even when candidate records are paged.
  const states = Object.values(workspace.mergeStateByRun ?? {});
  const running = states.filter(state => state === 'running').length;
  const recoveryRequired = states.filter(state => state === 'recovery-required').length;
  const total = workspace.recovery?.pendingMergeIntents ?? 0;
  return { total, running, recoveryRequired, unclassified: Math.max(0, total - running - recoveryRequired),
    definition: 'Pending merge intents across the workspace; running and recovery-required are breakdowns of the original total. Unclassified intents have no mapped state.' };
}

/** Version can stay unchanged while an operation moves from active to recovery. */
export function workspacePresentationKey(workspace) {
  return JSON.stringify([workspace.id, workspace.authentication?.principal ?? null, workspace.version, workspace.page ?? null, workspace.recovery ?? {},
    Object.entries(workspace.mergeStateByRun ?? {}).sort(([a], [b]) => a.localeCompare(b)),
    workspace.runs.map(run => [run.id, run.verificationPending ?? false, run.evidence, run.evidenceHistory ?? [], run.codeReview ?? null])]);
}

/** Tagged reports remain merge proof only; they never replace acceptance evidence. */
export function mergeReports(workspace, run) {
  const task = workspace.tasks.find(task => task.id === run.taskId);
  return (Array.isArray(run.evidenceHistory) ? run.evidenceHistory : [])
    .filter(report => report?.operation === 'merge' && typeof report.attemptId === 'string' && report.attemptId.trim())
    .map(report => {
      const wellFormed = Number.isSafeInteger(report.total) && report.total > 0
        && Number.isSafeInteger(report.passed) && Array.isArray(report.checks)
        && report.checks.length === report.total && report.checks.every(check => typeof check?.passed === 'boolean')
        && report.checks.filter(check => check.passed).length === report.passed
        && Number.isInteger(report.exitCode) && typeof report.command === 'string' && typeof report.output === 'string'
        && typeof report.verifiedAt === 'string' && Number.isFinite(Date.parse(report.verifiedAt));
      const current = Boolean(wellFormed && task && report.verified === true
        && ['independent-local-checks', 'independent-sandbox-checks'].includes(report.source)
        && report.commit === run.headCommit && report.taskRevision === (task.revision ?? 1));
      const passing = current && report.passed === report.total && report.exitCode === 0;
      const label = !wellFormed ? 'Malformed merge report' : !current ? 'Stale or unverified merge report'
        : passing ? 'Merge checks passed' : 'Merge checks failed';
      return { report, current, passing, label };
    });
}

/** Completed outcomes keep the two verification moments and denominators separate. */
export function completedVerification(workspace, run) {
  if (run.status !== 'merged') return null;
  const acceptance = run.evidence;
  const mergeAttempts = mergeReports(workspace, run).map(item => ({ ...item, label: 'Merge-attempt checks',
    status: item.label, passed: item.report.passed ?? null, total: item.report.total ?? null,
    verifiedAt: item.report.verifiedAt ?? null }));
  return { acceptance: { label: 'Acceptance-time checks', passed: acceptance?.passed ?? null,
    total: acceptance?.total ?? null, verifiedAt: acceptance?.verifiedAt ?? null, report: acceptance ?? null },
    mergeAttempts, missingMergeReport: mergeAttempts.length ? null : 'No tagged merge-time report was retained.',
    definition: 'Acceptance-time and merge-attempt checks have separate verification timestamps and passed/total denominators. Counts are not combined; unmarked historical reports do not establish merge provenance.' };
}

export function independentlyVerified(workspace, run) {
  const task = workspace.tasks.find(task => task.id === run.taskId);
  const report = run.evidence;
  return Boolean(!run.verificationPending && repositoryObservationCurrent(workspace,run) && report?.verified && ['independent-local-checks', 'independent-sandbox-checks'].includes(report.source)
    && report.commit === run.headCommit && (report.taskRevision ?? 1) === (task?.revision ?? 1));
}

export function projectMergeBlocker(workspace, run) {
  const projectId = workspace.tasks.find(task => task.id === run.taskId)?.projectId;
  if (!projectId) return null;
  return workspace.runs.find(other => other.id !== run.id && mergeState(workspace, other)
    && workspace.tasks.find(task => task.id === other.taskId)?.projectId === projectId) ?? null;
}

export function candidateOutcome(workspace, run) {
  const task = workspace.tasks.find(task => task.id === run.taskId);
  const merging = mergeState(workspace, run);
  if (merging === 'running') return { label: 'Merge running', action: 'Follow merge', section: 'review-decision', tone: 'running', next: 'Fresh checks and integration are in progress. Refresh reads status; wait for the recorded outcome.' };
  if (merging === 'recovery-required') return { label: 'Merge recovery required', action: 'Inspect merge recovery', section: 'review-decision', tone: 'fail', next: 'Inspect the retained checks, then choose Reconcile or retry merge in Review. The server reads the target first; fresh checks and another guarded merge may run. Refresh only reads status.' };
  if (run.verificationPending) return { label: 'Verification running', action: 'Follow checks', section: 'verification', tone: 'running', next: 'Wait for independent checks. The previous report remains visible; acceptance is blocked.' };
  if (run.status === 'merged') return { label: 'Merged', action: 'View merged record', section: 'evidence', tone: 'merged', next: 'View the retained result.' };
  if (run.repositoryObservation?.requiresSubmission) return {label:'New push observed', action: 'Inspect new push', section: 'candidate-changes',tone:'awaiting_review',next:run.headCommit ? 'The Artifacts branch changed after submission. Prepare and submit a fresh assigned candidate; earlier reports and decisions remain history.' : 'Artifacts has received changed code. The assigned agent must submit its current commit through the authenticated workflow.'};
  const project=workspace.projects?.[task?.projectId];
  if(run.headCommit&&!['rejected','failed','superseded'].includes(run.status)&&project&&(project.mainCommit!==task?.baseCommit||project.repositoryObservation&&project.repositoryObservation.headCommit!==task?.baseCommit))
    return {label:'Update base needed', action: 'Inspect base update', section: 'candidate-changes',tone:'awaiting_review',next:'Project main changed. Update this candidate’s base, then renew its checks and review.'};
  if (run.status === 'superseded') return { label: 'Previous base · retained', action: 'Inspect retained changes', section: 'candidate-changes', tone: 'retained', next: 'This candidate was preserved when the task moved to a new base. Review its replacement.' };
  if (task?.acceptedRunId && task.acceptedRunId !== run.id) return { label: 'Retained alternative', action: 'Compare retained changes', section: 'candidate-changes', tone: 'retained', next: 'Another candidate was chosen. This result remains available for comparison.' };
  const projectBlocker = run.status === 'accepted' ? projectMergeBlocker(workspace, run) : null;
  if (projectBlocker) return {label:'Waiting for project merge', action: 'View merge status', section: 'review-decision',tone:'awaiting_review',next:'Another merge owns this project. Wait for its outcome or reconcile its retained intent before this merge can start.'};
  if (run.status === 'accepted' && run.review?.policy) {
    const active = project?.automaticMergePolicy?.enabled && project.automaticMergePolicy.version === run.review.policy.version;
    const stop = run.automaticMergeStop?.decisionId === run.review.policy.decisionId ? run.automaticMergeStop : null;
    const stopped = !active || Boolean(stop);
    return {action:'Inspect integration status',section:'review-decision',label:stopped ? 'Automatic merge stopped' : 'Policy approved · merge queued', tone:stopped ? 'fail' : 'accepted',
      next:stop?.phase === 'before-write' ? 'Stopped before Git write. Inspect the retained checks and decision before a new owner decision or explicit retry.'
        : stopped ? 'The policy decision no longer authorizes automatic merge. Inspect the retained record before a new owner decision.'
          : 'The owner-enabled policy approved this change. Fresh merge checks run before Git is updated.'};
  }
  if (run.status === 'accepted') return workspace.provider === 'cloudflare-artifacts' && (!independentReviewStatus(workspace, run).passed || run.review?.codeReviewId !== run.codeReview?.id)
    ? { label: 'Independent review required', action: 'Open independent review', section: 'code-review', tone: 'awaiting_review', next: 'Obtain independent code review, then renew owner acceptance. The earlier decision remains history.' }
    : { label: 'Accepted · merge next', action: 'Review merge', section: 'review-decision', tone: 'accepted', next: 'Merge separately to update the task repository.' };
  if (run.status === 'rejected') return { label: 'Rejected', action: 'Read rejection', section: 'review-decision', tone: 'rejected', next: 'Inspect another candidate. The rejection and its evidence are retained.' };
  if (run.status === 'failed') return { label: 'Execution failed', action: 'Inspect error', section: 'candidate-changes', tone: 'failed', next: 'Inspect the retained error. This run produced no reviewable result.' };
  if (['assigned', 'running'].includes(run.status)) return { action:'Follow agent work',section:'candidate-changes',label: run.origin === 'external-agent' ? run.status === 'running' ? 'Agent reported start' : run.checkoutState === 'preparing' ? 'Preparing code access' : workspace.provider === 'cloudflare-artifacts' ? 'Fork ready' : 'Checkout ready' : run.status === 'running' ? 'Running' : 'Waiting', tone: run.status, next: run.origin === 'external-agent' ? run.status === 'running' ? 'Continue directing this agent in its chat. Its submitted commit will appear here.' : 'Give the checkout and handoff instructions to your agent. Its submitted commit will appear here.' : 'The result will appear when execution finishes.' };
  if (!run.evidence) return { label: 'Checks needed', action: run.checksConfigured || task?.checkProfile === 'checkout' ? 'Run checks' : 'Configure checks', section: 'verification', tone: 'awaiting_review', next: task?.checkProfile === 'checkout' ? 'Run the supplied checkout checks for this commit, then inspect the result.' : run.checksConfigured ? 'Run the preserved check definition for this new commit, then inspect the result.' : 'Configure and run independent checks for this submitted commit before accepting it.' };
  if (!independentlyVerified(workspace, run)) return { label: 'Recheck needed', action: 'Review current checks', section: 'verification', tone: 'fail', next: 'Check this commit against the current requirements before accepting.' };
  if (run.evidence.passed !== run.evidence.total || run.evidence.total === 0 || run.evidence.exitCode !== 0) return { label: 'Checks failed', action: 'Inspect failed checks', section: 'verification', tone: 'fail', next: 'Inspect the failures or record a rejection. Acceptance is unavailable.' };
  const codeReview = independentReviewStatus(workspace, run);
  if (workspace.provider === 'cloudflare-artifacts' && !codeReview.passed) return { action:'Open independent review',section:'code-review',label: codeReview.label, tone: 'awaiting_review', next: 'A separate read-only reviewer must assess this exact candidate and its evidence before owner acceptance.' };
  const alternatives = workspace.runs.some(other => other.taskId === run.taskId && other.id !== run.id && other.headCommit && other.status !== 'superseded');
  return { label: 'Checks pass · review next', action: 'Review decision', section: 'review-decision', tone: 'awaiting_review', next: alternatives ? 'Compare the candidates and record your decision.' : 'Inspect the changes and record your decision.' };
}

export function taskOutcome(workspace, task) {
  const runs = workspace.runs.filter(run => run.taskId === task.id);
  const chosen = runs.find(run => run.id === task.acceptedRunId);
  const merging = runs.find(run => mergeState(workspace, run));
  if (merging) {
    const outcome = candidateOutcome(workspace, merging);
    return { label: outcome.label, action: mergeState(workspace, merging) === 'running' ? 'Follow merge' : 'Inspect merge recovery',
      view: 'review', runId: merging.id, detail: outcome.next };
  }
  if (task.mergedCommit) return { label: 'Merged', action: 'View merged result', view: 'evidence', runId: chosen?.id, detail: 'The chosen commit is in this task’s repository. Alternatives remain in the record.' };
  const project = workspace.projects?.[task.projectId];
  if (!task.mergedCommit && taskQueued(workspace, task)) {
    const dependencies = dependencyState(workspace, task);
    if (!dependencies.ready) return { label: 'Waiting for integration', action: 'Inspect prerequisites', view: 'work', detail: dependencies.invalid ?? 'Waiting for integration: ' + dependencies.waiting.map(item => item.title).join(', ') + '. Accepted candidates do not unblock this task until merged.' };
  }
  if (project && (task.baseCommit !== project.mainCommit || project.repositoryObservation&&project.repositoryObservation.headCommit!==task.baseCommit) && !runs.some(run => ['assigned', 'running'].includes(run.status)) && runs.some(run => run.headCommit && run.status !== 'superseded')) return { label: 'Update base needed', action: 'Update candidate base', view: 'review', runId: chosen?.id ?? runs.find(run => run.headCommit && run.status !== 'superseded')?.id, detail: 'Project main advanced. Carry these changes forward, then verify and review the new result.' };
  if (['connected-git', 'artifacts'].includes(task.origin) && taskQueued(workspace, task)) return project?.acceptingWork === false
    ? { label: 'Queued · admission paused', action: 'View queued task', view: 'work', detail: 'New assignments are paused. Enable agent work in the project when you want agents to claim queued tasks.' }
    : { label: 'Queued', action: 'View queued task', view: 'work', detail: 'Waiting for an agent to claim this task. Its checkout will use the latest project main.' };
  if (chosen) {
    const outcome=candidateOutcome(workspace,chosen);
    return {label:outcome.label,action:outcome.label==='Independent review required'?'Independent review':'Continue to merge',view:'review',runId:chosen.id,detail:outcome.next};
  }
  if (runs.some(run => ['assigned', 'running'].includes(run.status))) return { label: ['connected-git', 'artifacts'].includes(task.origin) && !runs.some(run => run.status === 'running') ? 'Waiting for agent start' : 'Work in progress', action: 'Follow agent work', view: 'work', detail: runs.length > 1 ? 'Follow the active work. Each retained candidate keeps its own commit and evidence.' : 'The agent works in an isolated checkout and submits a commit for checks and review.' };
  const reviewable = runs.filter(run => run.status === 'awaiting_review');
  if (reviewable.length) {
    const candidate = reviewable.find(run => independentlyVerified(workspace, run) && run.evidence.passed === run.evidence.total && run.evidence.total > 0 && run.evidence.exitCode === 0) ?? reviewable[0];
    const outcome = candidateOutcome(workspace, candidate);
    let action = 'Review changes';
    if (candidate.verificationPending) action = 'Follow checks';
    else if (!candidate.evidence) action = candidate.checksConfigured || task.checkProfile === 'checkout' ? 'Run checks' : 'Configure checks';
    else if (!independentlyVerified(workspace, candidate)) action = (candidate.evidence.taskRevision ?? 1) !== (task.revision ?? 1)
      && (task.origin === 'connected-git' || task.verificationProfile === 'commands') ? 'Update checks' : 'Recheck result';
    else if (candidate.evidence.passed !== candidate.evidence.total || !candidate.evidence.total || candidate.evidence.exitCode !== 0) action = 'Inspect failures';
    return { label: outcome.label, action, view: 'review', runId: candidate.id, detail: outcome.next };
  }
  const rejected = runs.filter(run => run.status === 'rejected').at(-1);
  if (rejected) return { label: 'Review feedback retained', action: 'Review feedback', view: 'review', runId: rejected.id, detail: 'Continue the discussion in your existing agent with this retained candidate and the reviewer’s note. Agree any repair before preparing another isolated assignment.' };
  return { label: runs.length ? 'No candidate chosen' : 'Ready for work', action: ['connected-git', 'artifacts'].includes(task.origin) ? 'Prepare agent checkout' : 'Inspect task', view: 'work', detail: runs.length ? 'Inspect the retained results. Connected repository tasks can receive a new agent assignment.' : 'Prepare one checkout for an agent to work on this task.' };
}

export function taskQueued(workspace, task) {
  return !task.acceptedRunId && !task.mergedCommit && workspace.runs.filter(run => run.taskId === task.id).every(run => run.status === 'failed' && run.checkoutState === 'failed');
}

/** A steering brief grounded in retained requirements, checks and coordination. */
export function taskBriefing(workspace, task) {
  const runs = workspace.runs.filter(run => run.taskId === task.id);
  const revision = task.revision ?? 1;
  const latest = task.revisions?.find(item => item.revision === revision);
  const previous = task.revisions?.find(item => item.revision === revision - 1);
  const change = previous && latest ? {
    reason: latest.reason,
    purposeChanged: previous.purpose !== task.purpose,
    previousPurpose: previous.purpose,
    added: task.criteria.filter(item => !previous.criteria.includes(item)),
    removed: previous.criteria.filter(item => !task.criteria.includes(item)),
  } : null;
  const candidates = runs.map(run => {
    const related = workspace.coordination?.[run.id];
    const active = ['assigned', 'running'].includes(run.status);
    const current = independentlyVerified(workspace, run);
    const passing = current && run.evidence.total > 0 && run.evidence.passed === run.evidence.total && run.evidence.exitCode === 0;
    return { run, outcome: candidateOutcome(workspace, run), active,
      currentPassing: passing && ['awaiting_review', 'accepted', 'merged'].includes(run.status),
      earlierAssignment: active && Number.isInteger(run.assignedRevision) && run.assignedRevision < revision,
      earlierReport: Boolean(run.evidence && (run.evidence.taskRevision ?? 1) < revision),
      overlaps: related?.overlaps ?? [],
      blockers: run.status === 'awaiting_review' ? (related?.acceptance ?? []).filter(rule => !rule.met).map(rule => rule.message) : [] };
  });
  return { revision, change, candidates, outcome: taskOutcome(workspace, task),
    retained: runs.filter(run => run.headCommit).length,
    passing: candidates.filter(item => item.currentPassing).length,
    total: runs.length };
}

export function reviewTaskCount(workspace) {
  return workspace.tasks.filter(task => !task.mergedCommit && (task.acceptedRunId
    || workspace.runs.some(run => run.taskId === task.id && run.status === 'awaiting_review'))).length;
}

/** Keep project navigation, activity and retained evidence within one scope. */
export function projectContext(workspace, projectId) {
  if (!Object.hasOwn(workspace.projects ?? {}, projectId)) throw new Error('Project is not in this workspace.');
  const project = workspace.projects[projectId];
  const tasks = workspace.tasks.filter(task => task.projectId === projectId);
  const taskIds = new Set(tasks.map(task => task.id));
  const runs = workspace.runs.filter(run => taskIds.has(run.taskId));
  return { project, tasks, runs,
    events: workspace.events.filter(event => taskIds.has(event.taskId) || event.projectId === projectId),
    activeCandidates: runs.filter(run => ['assigned', 'running'].includes(run.status)),
    reviewTasks: tasks.filter(task => !task.mergedCommit && (task.acceptedRunId || runs.some(run => run.taskId === task.id && run.status === 'awaiting_review'))),
    queuedTasks: tasks.filter(task => taskQueued(workspace, task)) };
}

export function reviewContext(workspace, run) {
  const task = workspace.tasks.find(task => task.id === run.taskId);
  const overlaps = (workspace.coordination?.[run.id]?.overlaps ?? []).map(({ runId, headCommit }) => ({ runId, headCommit })).sort((a, b) => a.runId.localeCompare(b.runId));
  return JSON.stringify([workspace.id, workspace.authentication?.principal ?? null, task.id, run.id, run.headCommit, task.baseCommit, task.revision ?? 1, task.ownerVersion ?? 0, run.evidence?.verifiedAt ?? null, run.codeReview?.id ?? null, overlaps]);
}

export function readLocation(search) {
  const params = new URLSearchParams(search);
  const view = params.get('view') ?? (params.has('task') ? 'overview' : 'projects');
  const selected = ['projects', 'queue', 'overview', 'work', 'review', 'evidence', 'history'].includes(view) ? view : 'projects';
  const collection = ['projects','queue','history'].includes(selected);
  return { view: selected, projectId: selected==='projects' ? null : params.get('project'), taskId: collection ? null : params.get('task'), runId: ['review','evidence'].includes(selected) ? params.get('candidate') : null };
}

export function locationSearch(view, taskId, runId, projectId = null) {
  const params = new URLSearchParams({ view });
  if (['queue','history'].includes(view) && projectId) params.set('project', projectId);
  if (!['projects','queue','history'].includes(view) && taskId) params.set('task', taskId);
  if (['review','evidence'].includes(view) && runId) params.set('candidate', runId);
  return `?${params}`;
}

/** The command brief and CLI use the same project population and next actions. */
export function projectBrief(workspace, projectId) {
  const context = projectContext(workspace, projectId);
  if (!context) throw new Error('Select a current project.');
  const tasks = context.tasks;
  const active = tasks.filter(task => context.runs.some(run => run.taskId === task.id && (['assigned', 'running'].includes(run.status) || run.verificationPending)));
  const queued = context.queuedTasks;
  const waiting = queued.filter(task => !dependencyState(workspace, task).ready || context.project.acceptingWork === false || context.project.codeConnected === false);
  const nextQueued = queued.find(task => !waiting.includes(task)) ?? queued[0];
  const actions = tasks.filter(task => !task.mergedCommit && !active.includes(task) && !queued.includes(task)).map(task => ({ task, outcome: taskOutcome(workspace, task) }));
  const decisions = actions.filter(item => item.outcome.action === 'Review changes' || item.outcome.action === 'Continue to merge');
  const next = decisions.find(item => item.task.acceptedRunId) ?? decisions[0] ?? actions[0]
    ?? (active[0] ? { task: active[0], outcome: taskOutcome(workspace, active[0]) } : null)
    ?? (nextQueued ? { task: nextQueued, outcome: taskOutcome(workspace, nextQueued) } : null);
  return { total: tasks.length, decisions: decisions.length, active: active.length, waiting: waiting.length, eligibleQueued: queued.length - waiting.length,
    next: next ? { taskId: next.task.id, title: next.task.title, ...next.outcome } : null,
    definition: 'Each count uses all project tasks, including merged tasks, as its denominator. Active includes assigned/running agents and pending checks. Waiting means unresolved prerequisites, paused admission or unavailable code. Eligible queued tasks still require capacity. Checks and acceptance remain separate.' };
}

/** Attention is a navigation projection; existing task selectors own the gates. */
export function projectAttentionBrief(workspace, projectId) {
  const brief = projectBrief(workspace, projectId), context = projectContext(workspace, projectId);
  const entries = context.tasks.filter(task => !task.mergedCommit).map(task => ({task, outcome: taskOutcome(workspace, task)}));
  const blockedActions = new Set(['Update candidate base', 'Inspect merge recovery', 'Inspect failures', 'Update checks', 'Recheck result', 'Configure checks', 'Run checks']);
  const reviewActions = new Set(['Review changes', 'Independent review', 'Continue to merge']);
  const blocked = entries.filter(({task, outcome}) => {
    const run = context.runs.find(run => run.id === outcome.runId);
    const assessment = run?.codeReview && !run.verificationPending && outcome.view === 'review'
      ? independentReviewStatus(workspace, run) : null;
    return context.project.codeConnected === false || Boolean(dependencyState(workspace, task).invalid)
      || blockedActions.has(outcome.action) || outcome.label === 'Automatic merge stopped'
      || ['invalid', 'stale', 'changes-requested'].includes(assessment?.state);
  });
  const review = entries.filter(({outcome}) => reviewActions.has(outcome.action) && outcome.label !== 'Policy approved · merge queued');
  const attention = entries.filter(entry => blocked.includes(entry) || review.includes(entry)
    || entry.outcome.view === 'review' && !['Follow checks', 'Follow merge'].includes(entry.outcome.action)
      && entry.outcome.label !== 'Policy approved · merge queued');
  const next = blocked[0] ?? review.find(entry => entry.task.acceptedRunId) ?? review[0] ?? attention[0];
  const needsAttention = context.project.codeConnected === false || attention.length > 0;
  return {...brief, review: review.length, blocked: blocked.length, attention: attention.length, needsAttention,
    priority: context.project.codeConnected === false || blocked.length ? 0 : review.length ? 1 : needsAttention ? 2 : brief.active ? 3 : 4,
    next: next ? {taskId: next.task.id, title: next.task.title, ...next.outcome} : brief.next};
}

/** Search only visible navigation labels; hidden requirements and notes are excluded. */
export function commandEntries(workspace, query = '') {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const entries = [];
  for (const project of Object.values(workspace.projects ?? {})) {
    const tasks = workspace.tasks.filter(task => task.projectId === project.id);
    entries.push({ id: 'project-' + project.id, group: 'Projects', label: project.name, detail: tasks.length ? `${tasks.length} tasks` : 'Add the first task', projectId: project.id, taskId: tasks[0]?.id, view: 'overview' });
  }
  for (const task of workspace.tasks) {
    const outcome = taskOutcome(workspace, task);
    entries.push({ id: 'task-' + task.id, group: 'Tasks', label: task.title, detail: (workspace.projects?.[task.projectId]?.name ?? 'Workspace') + ' · ' + outcome.label, projectId: task.projectId, taskId: task.id, view: 'overview' });
  }
  for (const run of workspace.runs) {
    const task = workspace.tasks.find(task => task.id === run.taskId);
    if (!task) continue;
    entries.push({ id: 'candidate-' + run.id, group: 'Candidates', label: run.label, detail: task.title + ' · ' + candidateOutcome(workspace, run).label + (run.headCommit ? ' · ' + run.headCommit.slice(0, 10) : ''), projectId: task.projectId, taskId: task.id, runId: run.id, view: ['assigned', 'running'].includes(run.status) ? 'work' : 'review' });
  }
  return entries.filter(entry => words.every(word => (entry.label + ' ' + entry.detail).toLocaleLowerCase().includes(word)));
}

/** Requirement edits are proposals; this selector never changes saved state. */
export function requirementChangePreview(workspace, draft, proposed) {
  const task = workspace.id === draft.workspaceId && workspace.tasks.find(item => item.id === draft.taskId);
  if (!task) return { unavailable:true, stale:true, changed:false, fields:[], retained:0, reports:0, currentReports:0, accepted:0, active:0 };
  const fields = [
    {label:'Purpose',before:task.purpose,after:proposed.purpose},
    {label:'Acceptance criteria',before:task.criteria.join('\n'),after:proposed.criteria.join('\n')},
  ].filter(field => field.before !== field.after);
  const runs = workspace.runs.filter(run => run.taskId === task.id);
  const retained = runs.filter(run => run.headCommit);
  return { unavailable:false, merged:Boolean(task.mergedCommit), revision:task.revision ?? 1,
    stale:(task.revision ?? 1) !== draft.expectedRevision, changed:fields.length > 0, fields,
    retained:retained.length, reports:retained.filter(run=>run.evidence).length,
    currentReports:retained.filter(run=>independentlyVerified(workspace,run)).length,
    accepted:runs.filter(run=>run.status === 'accepted').length,
    active:runs.filter(run=>['assigned','running'].includes(run.status)).length };
}
