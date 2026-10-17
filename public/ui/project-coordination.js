import {el,panel,shortSha} from './dom.js';
import {projectCoordination} from '../project-coordination.js';
import {taskQueued} from '../workbench-state.js';

// The project queue lists tasks. Candidate files, checks and review details
// belong to their candidate page, not to nested workbenches inside this list.
export function projectCoordinationView({workspace,projectId,onOpenTask,onOpenCandidates,collections,disclosure}) {
  const model=projectCoordination(workspace,projectId), cap=model.capacity;
  const rows=collections({id:'tasks-'+projectId,label:'Tasks',items:model.cards,text:card=>card.title,
    filters:[['all','All statuses'],['queued','Queued'],['active','Active'],['decision','Needs decision'],['integrated','Integrated']],
    matches:(card,filter)=>filter==='all'||filter==='integrated'&&Boolean(workspace.tasks.find(task=>task.id===card.id)?.mergedCommit)
      ||filter==='queued'&&taskQueued(workspace,workspace.tasks.find(task=>task.id===card.id))||filter==='active'&&workspace.runs.some(run=>run.taskId===card.id&&(['assigned','running'].includes(run.status)||run.verificationPending))
      ||filter==='decision'&&['Review changes','Continue to merge'].includes(card.outcome.action),
    sorts:[['order','Queue order'],['name','Task name'],['newest','Newest first']],sortKey:(card,sort)=>sort==='name'?card.title.toLowerCase():workspace.tasks.find(task=>task.id===card.id).createdAt});
  return el('section',{class:'queue-surface','aria-label':'Project task queue'},
    rows.controls,
    model.admissionPaused?el('p',{class:'capability-note'},'New assignments are paused. Existing work remains available.'):null,
    rows.items.length?el('ul',{class:'task-collection collection-list','aria-label':'Tasks in this project'},rows.items.map(card=>
      el('li',{class:'task-collection-row'},
        el('div',{},el('a',{href:'?view=overview&task='+encodeURIComponent(card.id),class:'task-collection-title',onclick:event=>{
          if(event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;event.preventDefault();onOpenTask(card.id);
        }},card.title),el('p',{class:'small muted'},'Requirements r'+card.revision+(card.dependencies.waiting.length?' · '+card.dependencies.waiting.length+' prerequisites waiting':''))),
        el('span',{class:'status'},card.outcome.label),
        el('a',{class:'queue-candidates-link text-link small',href:'?view=work&task='+encodeURIComponent(card.id),
          'aria-label':card.retainedCandidates+' candidate'+(card.retainedCandidates===1?'':'s')+' for '+card.title,onclick:event=>{
            if(event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;event.preventDefault();onOpenCandidates(card.id);
          }},card.retainedCandidates+' candidate'+(card.retainedCandidates===1?'':'s'),el('span',{'aria-hidden':'true'},' →')))))
      : el('p',{},model.totalTasks?'No matching tasks. Clear the filters to browse the full queue.':'No tasks yet. Add a task to this project.'),
    rows.navigation,
    el('p',{class:'definition-note'},model.totalCandidates+' retained candidate'+(model.totalCandidates===1?'':'s')
      +(cap&&Number.isInteger(cap.occupied)?' · Workspace execution: '+cap.occupied+' / '+cap.limit+' slots':'')),
    disclosure('task-count-help-'+projectId,'About task counts',
      el('p',{},'Task totals include every status. Filters change only the visible rows. A candidate is one proposed result for a task. Execution capacity covers all projects.')));
}

// Operational detail remains available without becoming a nested task list.
export function projectActivityDetails({workspace,projectId}) {
  const model=projectCoordination(workspace,projectId), cap=model.capacity;
  return el('section',{class:'project-operation-details','aria-label':'Project operation details'},
    cap ? el('div',{class:'inspector-section'},el('h3',{},'Workspace capacity'),
      Number.isInteger(cap.occupied) ? el('p',{},cap.occupied+' / '+cap.limit+' execution slots · '+cap.running+' running · '+cap.reserved+' reserved · '+cap.queued+' waiting') : null,
      cap.verification ? el('p',{},cap.verification.occupied+' / '+cap.verification.limit+' verification attempts · '+cap.verification.waiting+' waiting for verification') : null,
      el('p',{class:'definition-note'},'Capacity covers all projects in this workspace. Task totals cover the selected project.')) : null,
    workspace.provider==='cloudflare-artifacts' ? el('div',{class:'inspector-section'},el('h3',{},'Repository observations'),
      model.lastObservation ? el('p',{},'Last observed push in this project: ',el('code',{},shortSha(model.lastObservation.headCommit)),' · '+model.lastObservation.observedAt) : el('p',{},'No repository push observation is recorded for this project.'),
      model.eventCounts ? el('p',{},'Workspace events: '+model.eventCounts.completed+' / '+model.eventCounts.events+' reconciled · '+model.eventCounts.pending+' pending · '+model.eventCounts.failed+' failed · '+model.eventCounts.attempts+' retained attempts.') : null,
      model.subscriptionCounts ? el('p',{},'Workspace automatic registrations: '+model.subscriptionCounts.ready+' / '+model.subscriptionCounts.repositories+' ready · '+model.subscriptionCounts.awaitingRecovery+' awaiting recovery. Operator-configured subscriptions are outside this count.') : null,
      el('p',{class:'definition-note'},'Push observations are separate from agent submissions, independent checks and merges. Event and registration counts cover the whole workspace.')) : null);
}
