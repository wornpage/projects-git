import {el, panel, shortSha, dateTime, timeOnly} from './dom.js';
import {createReportList} from './report-list.js';
import {createDiffView} from './diff-view.js';
import {candidateOutcome, taskOutcome, dependencyState, mergeReports, mergeIntentSummary, completedVerification} from '../workbench-state.js';

export function mergeStatusNotice(workspace, redact = value => value) {
  const summary = mergeIntentSummary(workspace);
  const errors = Array.isArray(workspace.recovery?.errors) ? workspace.recovery.errors : [];
  if (!summary.total && !summary.running && !summary.recoveryRequired && !errors.length) return null;
  const needsRecovery = summary.recoveryRequired > 0 || errors.length > 0;
  return el('section', {class: needsRecovery ? 'recovery-alert' : 'action-notice action-pending',
    role: needsRecovery ? 'alert' : 'status'},
    el('h2', {}, needsRecovery ? 'Workspace recovery needs attention' : summary.running ? 'Merge in progress' : 'Pending merge intents'),
    el('p', {}, summary.total + ' pending merge intents total · ' + summary.running + ' running · '
      + summary.recoveryRequired + ' recovery required · ' + summary.unclassified + ' unclassified.'),
    el('p', {class:'small'}, needsRecovery ? 'Preserved intents remain locked until exact-head reconciliation. Refresh reads status without retrying a merge.'
      : 'Follow the recorded outcome. Refresh reads status without retrying a merge.'),
    errors.map(error => el('p', {class:'recovery-error'}, redact(typeof error === 'string' ? error : error?.message || 'Recovery could not be completed.'))));
}

export function mergeReportPanel(workspace, run, disclosure) {
  const completed=completedVerification(workspace,run), reports=mergeReports(workspace,run);
  if (!reports.length) return completed ? panel('Merge-attempt checks',el('div',{class:'panel-body'},
    el('p',{},completed.missingMergeReport),el('p',{class:'definition-note'},completed.definition))) : null;
  return createReportList({id:'merge-reports-'+run.id,title:completed?'Merge-attempt checks':'Fresh merge verification',
    entries:reports.map(({report,label})=>({report,label:label+' · attempt '+report.attemptId})),disclosure,
    definition:'These server-tagged reports record merge attempts. The acceptance-time report remains separate; older unmarked history is not merge proof.'});
}

export function earlierReportPanel(workspace, run, disclosure) {
  const merge=new Set(mergeReports(workspace,run).map(item=>item.report));
  const reports=(Array.isArray(run.evidenceHistory)?run.evidenceHistory:[]).filter(report=>!merge.has(report));
  return createReportList({id:'earlier-reports-'+run.id,title:'Earlier check reports · '+reports.length,
    entries:reports.map((report,index)=>({report,label:'Report '+(index+1)+' · '+(report?.passed??'Not retained')+' / '+(report?.total??'Not retained')+' checks'})),disclosure,
    definition:'These historical results are separate from this candidate’s latest report and the latest-report KPI. Tagged merge attempts are listed separately.'});
}

export function createWorkbenchParts({
  getContext,
  disclosure, currentRun, taskRuns, tasksInProject, taskLabel,
  switchView, showError, announce, independentlyVerified, checksFailed, openInspector
}) {
  const diffPanel = createDiffView({getContext});
  function runStatus(run) {
    const {workspace} = getContext();
    const state = candidateOutcome(workspace, run);
    return el('span', { class: `status status-${state.tone}` }, state.label);
  }

  function emptyState(title, text) {
    return el("div", { class: "empty-state" }, el("div", { class: "empty-mark", "aria-hidden": "true" }, "↗"), el("h2", {}, title), el("p", {}, text));
  }

  function timeline(events, limit = 8) {
    const shown = [...events].reverse().slice(0, limit);
    return shown.length ? el("div", { class: "timeline" }, shown.map((event) => el("div", { class: "timeline-item" }, el("span", { class: `timeline-dot ${/accept|merge|verif/.test(event.type) ? "good" : /start|assign|creat/.test(event.type) ? "accent" : ""}`, "aria-hidden": "true" }), el("div", { class: "timeline-message" }, event.message), el("time", { class: "timeline-time", datetime: event.at, title: dateTime(event.at) }, timeOnly(event.at))))) : el("div", { class: "timeline-empty" }, "Your workspace history starts when you create a task. Every transition is retained.");
  }

  function taskSwitcher(task) {
    const {workspace} = getContext();
    const project = workspace.projects?.[task.projectId];
    const select = el('select', { id: 'task-selection', onchange: event => switchView(getContext().view, event.target.value, null, {preservePosition:true}) },
      (project ? tasksInProject(project) : workspace.tasks).map(entry => el('option', { value: entry.id, selected: entry.id === task.id }, taskLabel(entry))));
    return el('div',{class:'task-selector mobile-task-selector'},el('label',{for:'task-selection'},'Task'),select);
  }
  function taskHeader(task) {
    const {workspace}=getContext();
    const outcome=taskOutcome(workspace,task);
    return el('section', { class: 'task-context', 'aria-label': 'Selected task context' },
      el('div',{class:'task-context-meta'},el('span',{class:'status status-'+outcome.tone},outcome.label),
        el('span',{},'Requirements r'+(task.revision??1)),el('span',{},'Coordinator · '+(task.owner??'Not assigned')),
        el('span',{},taskRuns(task.id).length+' retained candidate'+(taskRuns(task.id).length===1?'':'s'))),
      el('p',{class:'task-purpose-summary'},task.purpose),
      prerequisitesPanel(task),
      el('button',{class:'text-link',type:'button',onclick:()=>openInspector('Task brief · '+task.title,
        el('p',{},task.purpose),el('h3',{},'Requirements r'+(task.revision??1)),
        el('ol',{class:'brief-criteria'},task.criteria.map(text=>el('li',{},text))),
        el('p',{class:'head-hint'},'Base commit · '+task.baseCommit))},
        task.criteria.length+' requirement'+(task.criteria.length===1?'':'s')+' · Read task brief'));
  }


  function taskList(task) {
    const {workspace,view}=getContext();
    const tasks=workspace.tasks.filter(entry=>entry.projectId===task.projectId);
    const groups=[['Ongoing',tasks.filter(entry=>!entry.mergedCommit)],['Integrated',tasks.filter(entry=>entry.mergedCommit)]];
    return el('aside',{id:'project-queue',class:'project-task-rail','aria-label':'Tasks in this project','data-project-key':workspace.id+':'+task.projectId},
      el('div',{class:'task-rail-heading'},el('h2',{},'Tasks'),el('span',{class:'small'},tasks.length+' total')),
      groups.filter(([,items])=>items.length).map(([title,items])=>el('section',{'aria-label':title},
        el('h3',{class:'queue-group-title'},title,el('span',{},items.length+' / '+tasks.length)),
        items.map(entry=>el('button',{id:'queue-task-'+entry.id,type:'button',
          class:'queue-task '+(entry.id===task.id?'selected':''),'aria-pressed':entry.id===task.id,
          onclick:()=>switchView(view,entry.id,null,{preservePosition:true})},el('strong',{},entry.title),
          el('span',{class:'small'},taskOutcome(workspace,entry).label))))));
  }

  function prerequisitesPanel(task) {
    const {workspace} = getContext();
    if (!task.dependsOn?.length) return null;
    const state = dependencyState(workspace, task);
    return el('section', { class:'task-prerequisites', 'aria-label':'Task prerequisites' },
      el('strong', {}, state.ready ? 'Prerequisites integrated' : 'Waiting for integration'),
      state.invalid ? el('p', {class:'inline-error'},state.invalid) : null,
      [...state.waiting, ...state.integrated].map(item => el('div', {},
        el('button', {class:'text-link',type:'button',onclick:()=>switchView('work',item.id,null)},item.title),
        el('span', {class:'small'},item.mergedCommit ? 'Integrated · ' + shortSha(item.mergedCommit) : 'Not integrated'))),
      state.ready ? null : el('p', {class:'small muted'},'Acceptance alone does not unblock this task. Other eligible work can proceed.'));
  }


  function commitValue(commit) {
    if (!commit) return el("span", { class: "muted" }, "Awaiting commit");
    return el("div", { class: "commit-text" }, el("span", { class: "commit-short", title: commit }, shortSha(commit)), el("button", { class: "copy-button", title: "Copy full commit", "aria-label": `Copy commit ${shortSha(commit)}`, onclick: async () => { try { await navigator.clipboard.writeText(commit); announce("Full commit copied."); } catch { showError("Clipboard is unavailable. The full commit is shown in the evidence view."); } } }, "⧉"));
  }

  function candidateNav(task, action = null) {
    const run = currentRun();
    const candidates=taskRuns(task.id);
    if (candidates.length === 1) return el('section',{class:'candidate-surface single-candidate','aria-label':'Task change'},
      el('div',{class:'candidate-surface-header'},el('span',{class:'section-kicker'},'TASK CHANGE · 1 CANDIDATE'),action),
      el('div',{class:'candidate-identity'},el('strong',{},candidates[0].label),runStatus(candidates[0])));
    return el('section',{class:'candidate-surface','aria-label':'Retained candidates'},
      el('div',{class:'candidate-surface-header'},el('span',{class:'section-kicker'},'RETAINED CANDIDATES · '+candidates.length),action),
      el('div', { class: 'candidate-nav', role:'group', 'aria-label': 'Select candidate' }, candidates.map(candidate => el('button', {
      id: 'candidate-select-' + candidate.id, class: 'candidate-button ' + (candidate.id === run?.id ? 'selected' : ''),
      'aria-pressed': candidate.id === run?.id,
      onclick: () => { const {view, selectedRun} = getContext(); if (candidate.id === selectedRun) return; switchView(view, task.id, candidate.id, {preservePosition:true}); }
    }, el('span', {}, candidate.label), runStatus(candidate)))));
  }

  function evidenceChecks(run) {
    const {workspace} = getContext();
    const completed = completedVerification(workspace, run);
    const title = completed?.acceptance.label ?? 'Independent verification';
    const evidence = run.evidence;
    const pending=run.verificationPending ? el('div',{class:'action-notice action-pending',role:'status'},el('strong',{},'Independent checks are running'),el('p',{},'This view follows the saved result. Acceptance remains unavailable until current checks finish and pass.')) : null;
    if (!evidence) return panel(title, el("div", { class: "panel-body" }, pending,el("p", { class: "small muted" }, completed ? 'No acceptance-time check report was retained.' : "No evidence has been recorded for this candidate. Acceptance stays unavailable until all independent checks pass against its exact head commit.")));
    const valid = independentlyVerified(run);
    const failed = evidence.checks.filter(check => !check.passed);
    const passed = evidence.checks.filter(check => check.passed);
    const checkList = checks => el("ul", { class: "check-list" }, checks.map(check => el("li", { class: "check-item" },
      el("span", { class: `check-icon ${check.passed ? "" : "fail"}`, "aria-label": check.passed ? "Passed" : "Failed" }, check.passed ? "✓" : "×"),
      el("div", {}, el("div", { class: "check-name" }, check.name), el("p", { class: "check-detail" }, check.detail)))));
    return panel(title, el("div", { class: "panel-body" },
      pending,
      completed ? el('p', {class:'small'}, 'Verified at · ' + (completed.acceptance.verifiedAt ?? 'Not retained')) : null,
      el("p", { class: `verification-label ${valid && !checksFailed(run) ? "" : "unverified"}` }, valid ? `${evidence.passed} / ${evidence.total} CHECKS PASSING · INDEPENDENT` : `${evidence.passed} / ${evidence.total} CHECKS REPORTED PASSING · UNVERIFIED`),
      el("p", { class: "head-hint" }, `Checked head · ${shortSha(evidence.commit)}`),
      failed.length ? checkList(failed) : null,
      passed.length ? disclosure(`checks-${run.id}-${evidence.taskRevision ?? 1}-${evidence.commit}`, `Show ${passed.length} passed check${passed.length === 1 ? "" : "s"}`, checkList(passed)) : null,
      disclosure(`report-${run.id}-${evidence.taskRevision ?? 1}-${evidence.commit}`, "Verification record", el("p", { class: "head-hint" }, `Source · ${evidence.source}`, el("br"), `Checked commit · ${evidence.commit}`, el("br"), `Verified · ${dateTime(evidence.verifiedAt)}`)),
      evidence.commit !== run.headCommit ? el("p", { class: "inline-error" }, "The report belongs to a different commit. It cannot authorize acceptance.") : null,
      evidence.source === "hosted-harness-report" ? el("p", { class: "inline-error" }, "This hosted report has not been independently verified. Acceptance remains unavailable.") : null));
  }
  return {runStatus, emptyState, timeline, taskHeader, taskList, taskSwitcher, prerequisitesPanel, commitValue, candidateNav, diffPanel, evidenceChecks};
}
