import {el,panel,shortSha} from './dom.js';
import {projectCoordination} from '../project-coordination.js';

// The project queue lists tasks. Candidate files, checks and review details
// belong to their candidate page, not to nested workbenches inside this list.
export function projectCoordinationView({workspace,projectId,onOpenTask,onOpenCandidates}) {
  const model=projectCoordination(workspace,projectId), cap=model.capacity;
  return panel('Tasks · '+model.totalTasks,el('div',{class:'panel-body'},
    el('p',{class:'collection-scope'},'Showing all '+model.totalTasks+' task'+(model.totalTasks===1?'':'s')+' in '+model.projectName+'. '+model.totalCandidates+' candidate'+(model.totalCandidates===1?' belongs':'s belong')+' to '+(model.totalTasks===1?'this task.':'these tasks.')),
    model.admissionPaused?el('p',{class:'capability-note'},'New assignments are paused. Existing work remains available.'):null,
    model.cards.length?el('ul',{class:'task-collection collection-list','aria-label':'Tasks in this project'},model.cards.map(card=>
      el('li',{class:'task-collection-row'},
        el('div',{},el('a',{href:'?view=overview&task='+encodeURIComponent(card.id),class:'task-collection-title',onclick:event=>{
          if(event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;event.preventDefault();onOpenTask(card.id);
        }},card.title),el('p',{class:'small muted'},'Requirements r'+card.revision+(card.dependencies.waiting.length?' · '+card.dependencies.waiting.length+' prerequisites waiting':''))),
        el('span',{class:'status'},card.outcome.label),
        el('a',{class:'text-link small',href:'?view=work&task='+encodeURIComponent(card.id),
          'aria-label':card.retainedCandidates+' candidate'+(card.retainedCandidates===1?'':'s')+' for '+card.title,onclick:event=>{
            if(event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;event.preventDefault();onOpenCandidates(card.id);
          }},card.retainedCandidates+' candidate'+(card.retainedCandidates===1?'':'s')))))
      : el('p',{},'No tasks yet. Add a task to this project.'),
    cap&&Number.isInteger(cap.occupied)?el('p',{class:'definition-note'},'Workspace capacity: '+cap.occupied+' / '+cap.limit+' execution slots across all projects. Task and candidate totals above cover this project only.'):null,
    el('p',{class:'definition-note'},'All statuses are included. A task is one piece of work; a candidate is one proposed result for that task.')));
}

// Operational detail remains available without becoming a nested task list.
export function projectActivityDetails({workspace,projectId}) {
  const model=projectCoordination(workspace,projectId), cap=model.capacity;
  return el('section',{'aria-label':'Project operation details'},
    cap ? el('div',{},el('h3',{},'Workspace capacity'),
      Number.isInteger(cap.occupied) ? el('p',{},cap.occupied+' / '+cap.limit+' execution slots · '+cap.running+' running · '+cap.reserved+' reserved · '+cap.queued+' waiting') : null,
      cap.verification ? el('p',{},cap.verification.occupied+' / '+cap.verification.limit+' verification attempts · '+cap.verification.waiting+' waiting for verification') : null,
      el('p',{class:'definition-note'},'Capacity covers all projects in this workspace. Task totals cover the selected project.')) : null,
    workspace.provider==='cloudflare-artifacts' ? el('div',{},el('h3',{},'Repository observations'),
      model.lastObservation ? el('p',{},'Last observed push in this project: ',el('code',{},shortSha(model.lastObservation.headCommit)),' · '+model.lastObservation.observedAt) : el('p',{},'No repository push observation is recorded for this project.'),
      model.eventCounts ? el('p',{},'Workspace events: '+model.eventCounts.completed+' / '+model.eventCounts.events+' reconciled · '+model.eventCounts.pending+' pending · '+model.eventCounts.failed+' failed · '+model.eventCounts.attempts+' retained attempts.') : null,
      model.subscriptionCounts ? el('p',{},'Workspace automatic registrations: '+model.subscriptionCounts.ready+' / '+model.subscriptionCounts.repositories+' ready · '+model.subscriptionCounts.awaitingRecovery+' awaiting recovery. Operator-configured subscriptions are outside this count.') : null,
      el('p',{class:'definition-note'},'Push observations are separate from agent submissions, independent checks and merges. Event and registration counts cover the whole workspace.')) : null);
}
