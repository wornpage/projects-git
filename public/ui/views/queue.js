import {el, panel} from '../dom.js';
import {taskOutcome, taskQueued, taskBriefing, projectContext, projectBrief} from '../../workbench-state.js';
import {projectCoordinationView,projectActivityDetails} from '../project-coordination.js';

export function createTaskViews({
  getContext,
  parts, disclosure, currentProject, currentTask, tasksInProject, taskRuns, taskNumber,
  switchView, selectProject, openTaskComposer, openRevision, openInspector, downloadHandoff, collections
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
    const merged = tasks.filter(task => task.mergedCommit);
    const brief=projectBrief(workspace,project.id);
    const counts = [['Queued', queued.length], ['Active tasks', brief.active], ['Needs decision', brief.decisions], ['Waiting',brief.waiting],['Ready to claim',brief.eligibleQueued], ['Merged', merged.length]];
    const summary = panel('Task totals', el('div', { class: 'panel-body project-home' },
      el('div', { class: 'project-counts' }, counts.map(([label, value]) => el('div', {}, el('strong', {}, value + ' / ' + tasks.length), el('span', {}, label)))),
      el('p', { class: 'small muted' }, brief.definition),
      !project.acceptingWork ? el('p', { class: 'capability-note' }, 'New checkouts and starts are paused. You can still queue work; running agents can finish.') : null));
    summary.classList.add('project-summary');
    return summary;
  }

  function focusedTask(task) {
    const {workspace, busy, demo} = getContext();
    const brief = taskBriefing(workspace, task), change = brief.change;
    const directionChanged = change && (change.purposeChanged || change.added.length || change.removed.length);
    const next = brief.outcome;
    const revisions=collections({id:'requirement-history-'+task.id,label:'Requirement revisions',items:task.revisions??[],text:item=>item.reason+' '+item.purpose,
      sorts:[['newest','Newest first'],['oldest','Oldest first']],sortKey:item=>item.revision,pageSize:10});
    const body = el('div', { class: 'panel-body focused-task-body' },
      el('p', { class: 'task-intent' }, task.purpose),
      demo ? null : el('button', { class:'button button-small', disabled:busy || !workspace.capabilities?.handoff,
        title:busy ? 'Wait for the current action.' : !workspace.capabilities?.handoff ? 'Task handoff export needs the updated server.' : 'Export this task, its requirements and all retained candidates.',
        onclick:()=>downloadHandoff(task) }, 'Download task handoff'),
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
          revisions.controls,...revisions.items.map(item => el('div', { class: 'requirement-record' }, el('strong', {}, 'r' + item.revision + ' · ' + item.reason), el('p', {}, item.purpose), el('ul', {}, item.criteria.map(text => el('li', {}, text))))),revisions.navigation) : null),
      brief.total ? el('section',{class:'task-result-summary','aria-label':'Candidate summary'},
        el('div',{},el('h3',{},brief.total+(brief.total===1?' candidate':' candidates')),
          el('p',{},brief.passing+' / '+brief.total+' have current passing checks. Browse results to compare changes and retained reports.')),
        el('button',{class:'button button-small',onclick:()=>switchView('work',task.id,null)},'Open candidates →')) : null);
    const card = panel('Task brief', body);
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
      project ? projectCoordinationView({workspace,projectId:project.id,collections,
        onOpenTask:id=>switchView('overview',id,null),
        onOpenCandidates:id=>switchView('work',id,null)}) : null,

      el('div',{class:'secondary-actions'},
        project && projectBrief(workspace,project.id).next ? el('button',{id:'shell-next-action',type:'button',class:'text-link',onclick:()=>{
          const next=projectBrief(getContext().workspace,project.id).next;if(next)switchView(next.view,next.taskId,next.runId??null);
        }},'Open next work') : null,
        project ? el('button',{type:'button',class:'text-link',onclick:()=>openInspector('Project activity and totals',projectHome(project),
          projectActivityDetails({workspace,projectId:project.id}),el('p',{class:'small'},'Latest '+Math.min(5,events.length)+' / '+events.length+' events'),timeline(events,5))},'Project activity') : null,
        el('button',{type:'button',class:'text-link',onclick:()=>openInspector(workspace.page?'Loaded project summary':'Workspace summary',workflow(),metrics(),
          el('p',{class:'definition-note'},(workspace.page?'These totals cover the loaded projects. The workspace has '+workspace.page.totalProjects+' projects; execution capacity remains workspace-wide. ':'Workspace totals include every project and retained candidate. ')+'Latest reported checks sums each candidate’s latest report; earlier history is separate.'))},workspace.page?'Loaded project summary':'Workspace summary')));
  }
  return {queue:overview,task:()=>{const task=currentTask();return task ? focusedTask(task) : panel('Task',el('p',{},'Select a task from its project queue.'));}};
}
