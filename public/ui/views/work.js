import {el, panel, timeOnly} from '../dom.js';
import {taskOutcome,dependencyState} from '../../workbench-state.js';
import {taskLifecycle} from '../task-lifecycle.js';

export function createWorkView({
  getContext,
  parts, disclosure, currentTask, currentRun, taskRuns, repositoryAgents, taskSettings, externalHandoff,
  switchView, openContinuation, checksFailed, independentlyVerified, openInspector
}) {
  const {emptyState, taskHeader, timeline, commitValue, runStatus} = parts;
  function agentCard(run, index) {
    const {workspace, selectedRun, demo} = getContext();
    const evidence = run.evidence;
    const failed = checksFailed(run);
    const agentKind = run.origin === 'reconciled-git' ? 'BASE UPDATE · NEW VERIFICATION REQUIRED'
      : run.origin === 'external-agent' ? 'EXTERNAL AGENT · REPORTED ACTIVITY'
      : run.agent === 'model' ? 'MODEL AGENT'
      : workspace.provider === 'local-git' ? 'LOCAL SCRIPTED AGENT' : run.agent;
    const heading = el('div', {class: failed ? 'agent-top checks-failed-heading' : 'agent-top'},
      el('div', {class: 'agent-ident'},
        el('div', {class: 'agent-avatar', 'aria-hidden': 'true'}, String(index + 1).padStart(2, '0')),
        el('div', {}, el('h3', {}, run.label), el('p', {}, agentKind))),
      runStatus(run));
    const details = el('dl', {class: 'detail-list'},
      el('div', {}, el('dt', {}, 'Branch'), el('dd', {}, run.branch)),
      el('div', {}, el('dt', {}, 'Head'), el('dd', {}, commitValue(run.headCommit))),
      el('div', {}, el('dt', {}, 'Files'), el('dd', {}, run.changedFiles.length ? run.changedFiles.join(', ') : 'Awaiting changes')));
    const checks = el('div', {class: 'agent-checks'},
      el('span', {class: 'check-count ' + (failed ? 'failed' : evidence ? '' : 'pending')},
        evidence ? evidence.passed + ' / ' + evidence.total + ' checks passing' : 'Checks pending'),
      el('span', {class: 'section-kicker'}, independentlyVerified(run) ? 'VERIFIED AT HEAD' : evidence ? 'REPORTED' : 'NO REPORT YET'));
    const activity = run.origin === 'reconciled-git' ? 'Reapplied · verify and review next'
      : run.finishedAt ? 'Finished ' + timeOnly(run.finishedAt)
      : run.startedAt ? 'Started ' + timeOnly(run.startedAt) : 'Awaiting execution';
    const footer = el('div', {class: 'agent-bottom'}, el('span', {}, activity),
      el('button', {class: 'button button-small', onclick: () => switchView('review', run.taskId, run.id)}, 'Inspect candidate ↗'),
      demo ? null : el('button', {id: 'continue-agent-card-' + run.id, class: 'button button-small', onclick: () => openContinuation(run.id)}, 'Continue in your agent ↗'));
    const summary = run.summary || (run.status === 'running'
      ? 'Working in an isolated branch. The result will appear after the agent commits its changes.'
      : 'An isolated candidate with its own branch, commit, and evidence record.');
    return el('article', {class: 'agent-card ' + (run.id === selectedRun ? 'selected' : '')},
      heading, el('div',{class:'agent-code-line'},commitValue(run.headCommit),el('span',{class:'small'},run.changedFiles.length+' changed file'+(run.changedFiles.length===1?'':'s'))),
      checks, el('p', {class: 'agent-summary'}, summary),
      executionSummary(run),
      demo ? null : el('button',{type:'button',class:'text-link',onclick:()=>openInspector('Checkout · '+run.label,details,externalHandoff(run))},'Checkout and handoff'),
      run.error ? el('p', {class: 'inline-error'}, run.error) : null, footer);
  }

  function executionSummary(run) {
    const execution = run.execution;
    if (!execution) return null;
    return el("div", { class: "execution-summary" },
      el("strong", {}, `Model execution · ${execution.status}`),
      el("p", {}, `Requests started: ${execution.requests.length} / ${execution.limits.maxRequests}. Time allowance: ${execution.limits.timeoutMs / 1000}s. Output limit per request: ${execution.limits.maxOutputTokens} tokens.`),
      el("p", {}, `Recorded input: ${execution.inputTokens} tokens, including ${execution.cachedInputTokens === null ? "unknown" : execution.cachedInputTokens} cached. Recorded output: ${execution.outputTokens} tokens.`),
      execution.usageComplete ? null : el("p", { class: "inline-error" }, "Usage is incomplete; the in-flight request may incur additional usage. No automatic provider retry."));
  }

  function taskProgress(task, runs) {
    const {workspace} = getContext();
    const state = taskOutcome(workspace, task);
    const active = runs.filter(run => ['running', 'assigned'].includes(run.status));
    return el('section', { class: 'task-progress' },
      el('h2', {}, state.label),
      el('p', {}, active.length ? active.filter(run => run.status === 'running').length + ' running · ' + active.filter(run => run.status === 'assigned').length + ' waiting' : state.detail),
      el('p', {}, runs.filter(run => run.headCommit).length + ' / ' + runs.length + ' commits · ' + runs.filter(independentlyVerified).length + ' / ' + runs.length + ' current independent reports'),
      taskLifecycle(workspace, currentRun(), switchView),
      state.view !== 'work' ? el('worn-button', {label: state.action, variant: 'primary', onclick: () => switchView(state.view, task.id, state.runId ?? null)}) : null);
  }

  function workView() {
    const {workspace, demo} = getContext();
    const task = currentTask();
    if (!task) return panel('Agent work', emptyState('No task yet', 'Open Projects to connect code and queue a task.'));
    const runs = taskRuns(task.id);
    const prerequisites = dependencyState(workspace,task);
    const assignment = repositoryAgents(task);
    return el('div', {}, taskHeader(task), taskProgress(task, runs), runs.length ? null : assignment,
      el('div', { class: 'section-heading' }, el('h2', {}, runs.length > 1 ? 'Retained candidates' : 'Task change'), el('span', { class: 'section-kicker' }, runs.length + ' CANDIDATE' + (runs.length === 1 ? '' : 'S') + ' · THIS TASK')),
      runs.length ? el('div', { class: 'run-grid' }, runs.map(agentCard)) : panel(prerequisites.ready?'Ready for work':'Waiting for integration',
        el('p', { class: 'no-candidate' }, prerequisites.ready?'No agent has been assigned. Start with one checkout for this task.':'This task becomes eligible after its prerequisites are integrated. Other eligible work can proceed.')),
      el('div',{class:'work-task-actions'},
        runs.length && assignment ? el('button',{type:'button',class:'button button-small',onclick:()=>openInspector('Prepare another candidate',assignment)},'Prepare another candidate') : null,
        demo ? null : taskSettings(task),
        el('button',{type:'button',class:'text-link',onclick:()=>openInspector('Task activity',timeline(workspace.events.filter(event=>event.taskId===task.id),10))},'View task activity')));
  }
  return workView;
}
