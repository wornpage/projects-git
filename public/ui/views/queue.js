import {el, panel} from '../dom.js';
import {taskOutcome, taskQueued, taskBriefing, projectContext} from '../../workbench-state.js';
import {projectCoordinationView} from '../project-coordination.js';

export function createQueueView({
  getContext,
  parts, disclosure, currentProject, currentTask, tasksInProject, taskRuns, taskNumber,
  switchView, selectProject, openTaskComposer, openRevision, openInspector
}) {
  const {prerequisitesPanel, timeline} = parts;
  function metric(label, value, denominator, note, icon) {
    return el("div", { class: "metric-card" }, el("div", { class: "metric-label" }, el("span", {}, label), el("span", { "aria-hidden": "true" }, icon)), el("div", { class: "metric-value" }, value, denominator !== null ? el("span", { class: "denominator" }, `/ ${denominator}`) : null), el("div", { class: "metric-note" }, note));
  }

  function metrics() {
    const {workspace} = getContext();
    const runs = workspace.runs;
    const evidence = runs.filter((run) => run.evidence);
    const passed = evidence.reduce((sum, run) => sum + run.evidence.passed, 0);
    const total = evidence.reduce((sum, run) => sum + run.evidence.total, 0);
    const accepted = runs.filter((run) => ["accepted", "merged"].includes(run.status)).length;
    const active = runs.filter((run) => run.status === "running").length;
    const waiting = runs.filter((run) => run.status === "assigned").length;
    const merged = workspace.tasks.filter((task) => task.status === "merged").length;
    const capacity=workspace.capacity;
    const execution=capacity&&Number.isInteger(capacity.occupied)
      ? metric('Workspace execution slots',capacity.occupied,capacity.limit,`${capacity.running} running · ${capacity.reserved} reserved · ${capacity.queued} waiting across all projects`,'⇄')
      : metric(workspace.page?'Running agents in loaded projects':'Running agents',active,null,`${waiting} assigned and waiting · ${runs.length} candidates in this view`,'⇄');
    return el("div", { class: "metrics-grid" }, execution, metric("Latest reported checks", passed, total, `${evidence.length} of ${runs.length} candidates have latest reports; earlier reports remain in Evidence`, "✓"), metric("Current acceptance", accepted, runs.length, "Current decisions; previous reviews stay in history", "↗"), metric("Merged tasks", merged, workspace.tasks.length, "Explicit merges into the task base", "⤴"));
  }

  function workflow() {
    return panel('How this works', el('div', { class: 'panel-body' },
      el('ol', { class: 'journey-steps' },
        el('li', {}, 'Create a project and queue its tasks. Agents claim work and make isolated changes.'),
        el('li', {}, 'Inspect each result: the changes, current requirements and independently run checks.'),
        el('li', {}, 'Review the change and record your decision. Compare approaches when you have requested alternatives.'),
        el('li', {}, 'Merge the accepted change into the project. Unstarted tasks pick up its new baseline.')),
      el('p', { class: 'definition-note' }, 'A project owns the code and task queue. A task keeps its requirements, changes, checks and decisions. Start with one agent; prepare another candidate when a different approach is useful. Agent clients pull queued tasks; this local workspace does not launch an external model for them.')));
  }

  function projectHome(project) {
    const {workspace} = getContext();
    const tasks = tasksInProject(project);
    const queued = tasks.filter(task => taskQueued(workspace, task));
    const active = tasks.filter(task => taskRuns(task.id).some(run => ['assigned', 'running'].includes(run.status)));
    const decisions = tasks.filter(task => !task.mergedCommit && (task.acceptedRunId || taskRuns(task.id).some(run => run.status === 'awaiting_review')));
    const merged = tasks.filter(task => task.mergedCommit);
    const counts = [['Queued', queued.length], ['Active tasks', active.length], ['Review tasks', decisions.length], ['Merged', merged.length]];
    const summary = panel('Task totals', el('div', { class: 'panel-body project-home' },
      el('div', { class: 'project-counts' }, counts.map(([label, value]) => el('div', {}, el('strong', {}, value + ' / ' + tasks.length), el('span', {}, label)))),
      el('p', { class: 'small muted' }, 'Counts are tasks / ' + tasks.length + ' total. Active and review tasks can overlap.'),
      !project.acceptingWork ? el('p', { class: 'capability-note' }, 'New checkouts and starts are paused. You can still queue work; running agents can finish.') : null));
    summary.classList.add('project-summary');
    return summary;
  }

  function focusedTask(task) {
    const {workspace, busy} = getContext();
    const brief = taskBriefing(workspace, task), change = brief.change;
    const directionChanged = change && (change.purposeChanged || change.added.length || change.removed.length);
    const next = brief.outcome;
    const body = el('div', { class: 'panel-body focused-task-body' },
      el('p', { class: 'task-intent' }, task.purpose),
      prerequisitesPanel(task),
      el('div', { class: 'task-next-step' }, el('strong', {}, next.label), el('p', {}, next.detail),
        el('button', { class: 'button button-primary button-small', onclick: () => switchView(next.view, task.id, next.runId ?? null) }, next.action + ' →')),
      el('section', {class:'task-brief-section','aria-label':'Current requirements'}, el('h3',{},(directionChanged ? 'Requirements changed' : 'Requirements')+' · r'+brief.revision),
        directionChanged ? el('div', { class: 'direction-change' }, el('strong', {}, 'Latest change'), el('p', {}, change.reason),
          change.purposeChanged ? el('p', {}, 'Previous purpose: ' + change.previousPurpose) : null,
          change.added.length ? el('div', {}, el('strong', {}, 'Added'), el('ul', {}, change.added.map(text => el('li', {}, text)))) : null,
          change.removed.length ? el('div', {}, el('strong', {}, 'Removed'), el('ul', {}, change.removed.map(text => el('li', {}, text)))) : null) : null,
        el('ol', { class: 'brief-criteria' }, task.criteria.map(text => el('li', {}, text))),
        !task.mergedCommit ? el('button', { class: 'button button-small', disabled: busy || !workspace.capabilities?.revise,
          title: busy ? 'Wait for the current action.' : !workspace.capabilities?.revise ? 'Requirement revisions need the updated server.' : 'Update the purpose and requirements while retaining earlier work.', onclick: () => openRevision(task) }, 'Revise direction') : null,
        task.revisions?.length > 1 ? disclosure('task-history-' + task.id, 'Requirement history · ' + task.revisions.length + ' revisions',
          ...[...task.revisions].reverse().map(item => el('div', { class: 'requirement-record' }, el('strong', {}, 'r' + item.revision + ' · ' + item.reason), el('p', {}, item.purpose), el('ul', {}, item.criteria.map(text => el('li', {}, text)))))) : null),
      brief.total ? el('section',{class:'task-result-section'},el('h3',{},'Results and evidence · '+brief.total+(brief.total===1?' candidate':' candidates')),
        el('p', { class: 'head-hint' }, brief.passing + ' / ' + brief.total + ' candidates with current passing checks. Acceptance and merge are separate decisions.'),
        el('div', { class: 'task-results' }, brief.candidates.map(item => {
        const run = item.run;
        return el('article', { class: 'task-result' },
          el('div', { class: 'task-result-title' }, el('strong', {}, run.label), el('span', { class: 'small' }, item.outcome.label)),
          item.earlierReport ? el('p', { class: 'direction-note' }, 'Commit retained; its report covers r' + (run.evidence.taskRevision ?? 1) + '. Current requirements are r' + brief.revision + '.') : null,
          item.earlierAssignment ? el('p', { class: 'direction-note' }, 'Assigned under r' + run.assignedRevision + '. ' + (run.status === 'running' ? 'Send the updated requirements through your agent conversation.' : 'This assignment cannot start under revised requirements. Resolve it in Agent work before preparing a current assignment.')) : null,
          item.overlaps.length ? disclosure('task-overlaps-' + run.id, 'Shared files · compare changes', el('p', {}, [...new Set(item.overlaps.flatMap(other => other.paths))].join(', ')), el('p', { class: 'small' }, 'Shared files alone do not prove a merge conflict.')) : null,
          item.blockers.length ? el('div',{class:'candidate-blockers'},el('strong',{},'Before acceptance · '+item.blockers.length+' unmet'),el('ul',{},item.blockers.map(text=>el('li',{},text)))) : null,
          el('button', { class: 'button button-small', onclick: () => switchView(item.active ? 'work' : 'review', task.id, run.id), 'aria-label': (item.active ? 'Follow ' : 'Inspect ') + run.label }, item.active ? 'Follow agent →' : 'Inspect result →'));
      }))) : null);
    const card = panel(task.title, body, el('span', { class: 'section-kicker' }, 'TASK ' + taskNumber(task) + ' · r' + brief.revision));
    card.id = 'focused-task'; card.classList.add('focused-task');
    card.querySelector('h2').id = 'focused-task-title'; card.querySelector('h2').tabIndex = -1;
    card.setAttribute('aria-labelledby', 'focused-task-title');
    return card;
  }

  function overview() {
    const {workspace, pendingTaskStart} = getContext();
    const project = currentProject();
    const tasks = project ? tasksInProject(project) : [...workspace.tasks];
    const task = currentTask();
    const events = project ? projectContext(workspace, project.id).events : workspace.events;
    const pendingProject = pendingTaskStart?.source === 'project' && pendingTaskStart.projectId !== project?.id
      ? workspace.projects[pendingTaskStart.projectId] : null;
    return el('div', { class: 'project-overview' },
      !project ? el('p', { class: 'capability-note' }, 'Open Projects to connect code and create the work you want to do.') : null,
      el('div', {}, pendingProject ? el('div', { class: 'capability-note' },
        el('p', {}, 'A task request for ' + pendingProject.name + ' is awaiting confirmation. Its destination and request ID are preserved.'),
        el('button', { class: 'button button-small', onclick: () => { selectProject(pendingProject.id); openTaskComposer('project:' + pendingProject.id); } }, 'Return to saved request')) : null),
      project ? projectCoordinationView({workspace,projectId:project.id,
        onOpenTask:id=>{const selected=workspace.tasks.find(item=>item.id===id);if(selected){const outcome=taskOutcome(workspace,selected);switchView(outcome.view,id,outcome.runId);}},
        onOpenRun:id=>{const run=workspace.runs.find(item=>item.id===id);if(run)switchView(['assigned','running'].includes(run.status)?'work':'review',run.taskId,run.id);}}) : null,
      task ? disclosure('queue-task-brief-'+task.id,'Selected task brief · '+task.title,focusedTask(task)) : null,
      el('div',{class:'secondary-actions'},
        project ? el('button',{type:'button',class:'text-link',onclick:()=>openInspector('Project activity and totals',projectHome(project),
          el('p',{class:'small'},'Latest '+Math.min(5,events.length)+' / '+events.length+' events'),timeline(events,5))},'Project activity') : null,
        el('button',{type:'button',class:'text-link',onclick:()=>openInspector(workspace.page?'Loaded project summary':'Workspace summary',workflow(),metrics(),
          el('p',{class:'definition-note'},(workspace.page?'These totals cover the loaded projects. The workspace has '+workspace.page.totalProjects+' projects; execution capacity remains workspace-wide. ':'Workspace totals include every project and retained candidate. ')+'Latest reported checks sums each candidate’s latest report; earlier history is separate.'))},workspace.page?'Loaded project summary':'Workspace summary')));
  }
  return overview;
}
