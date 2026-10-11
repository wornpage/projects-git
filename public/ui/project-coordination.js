import {el,panel,shortSha} from './dom.js';
import {projectCoordination} from '../project-coordination.js';

export function projectCoordinationView({workspace,projectId,onOpenTask,onOpenRun}) {
  const model=projectCoordination(workspace,projectId), cap=model.capacity;
  const detail=(label,...body)=>el('details',{class:'coordination-detail'},el('summary',{},label),...body);
  const cards=model.cards.map(card=>el('article',{class:'coordination-card','aria-labelledby':'coordination-title-'+card.id},
    el('div',{class:'coordination-card-heading'},el('h3',{id:'coordination-title-'+card.id},card.title),
      el('span',{class:'coordination-status'},card.outcome.label)),
    el('p',{class:'small muted'},'Requirements r'+card.revision+' · '+card.retainedCandidates+' retained candidate'+(card.retainedCandidates===1?'':'s')),
    card.dependencies.invalid?el('p',{class:'capability-note'},card.dependencies.invalid):null,
    card.dependencies.waiting.length||card.dependencies.integrated.length?el('ul',{class:'coordination-dependencies','aria-label':'Task prerequisites'},
      [...card.dependencies.waiting.map(item=>({...item,integrated:false})),...card.dependencies.integrated.map(item=>({...item,integrated:true}))].map(item=>
        el('li',{},el('span',{},item.integrated?'Integrated · ':'Waiting for integration · '),
          el('button',{type:'button',class:'text-link',onclick:()=>onOpenTask(item.id)},item.title)))):null,
    el('p',{class:'coordination-next'},card.outcome.detail),
    card.candidates.length?el('ul',{class:'coordination-candidates','aria-label':'Retained candidates'},card.candidates.map(candidate=>el('li',{},
      el('div',{class:'coordination-candidate-heading'},el('strong',{},candidate.label),el('span',{class:'small'},candidate.outcome.label)),
      candidate.headCommit?el('p',{class:'small'},el('code',{},shortSha(candidate.headCommit)),' · '+candidate.files.length+' changed file'+(candidate.files.length===1?'':'s')):el('p',{class:'small muted'},'No submitted commit yet'),
      candidate.review?el('p',{class:'small'},candidate.review.label):null,
      candidate.observation?.requiresSubmission?el('p',{class:'capability-note'},'New push observed; authenticated submission is required before this change can be reviewed.'):null,
      candidate.blockers.length?detail(candidate.blockers.length+' unmet acceptance requirement'+(candidate.blockers.length===1?'':'s'),
        el('ul',{},candidate.blockers.map(message=>el('li',{},message)))):null,
      candidate.files.length?detail('Changed files · '+candidate.files.length,el('ul',{class:'coordination-files'},candidate.files.map(file=>el('li',{},el('code',{},file))))):null,
      candidate.overlaps.length?detail('Shared files with '+candidate.overlaps.length+' candidate'+(candidate.overlaps.length===1?'':'s'),
        el('p',{class:'small'},'File overlap signals related work; it does not prove a Git merge conflict.'),
        el('ul',{},candidate.overlaps.map(other=>el('li',{},
          el('button',{type:'button',class:'text-link',onclick:()=>onOpenRun(other.runId)},'Inspect '+shortSha(other.headCommit)),
          el('p',{class:'small'},other.paths.join(', ')))))):null,
      el('button',{type:'button',class:'text-link',onclick:()=>onOpenRun(candidate.id)},candidate.active?'Follow agent':'Inspect candidate')))):null,
    el('div',{class:'coordination-card-actions'},el('button',{type:'button',class:'button button-small',onclick:()=>onOpenTask(card.id)},'Open task'))));
  return panel('Project coordination',el('div',{class:'panel-body coordination-board'},
    el('p',{class:'small'},model.totalTasks+' tasks · '+model.totalCandidates+' retained candidates · Snapshot v'+model.version),
    el('div',{class:'coordination-capacity'},
      cap&&Number.isInteger(cap.occupied)?el('div',{},el('strong',{},cap.occupied+' / '+cap.limit+' execution slots'),
        el('span',{class:'small'},cap.running+' running · '+cap.reserved+' reserved'+(workspace.provider==='cloudflare-artifacts'?' · '+cap.queued+' model jobs waiting':''))):null,
      cap?.verification?el('div',{},el('strong',{},cap.verification.occupied+' / '+cap.verification.limit+' verification attempts'),
        el('span',{class:'small'},cap.verification.waiting+' waiting for verification')):null),
    cap?el('p',{class:'small muted'},'Capacity covers the whole workspace. Task and candidate counts above cover this project; historical and failed candidates stay in the total.'):null,
    el('p',{class:'small'},model.automaticPolicyEnabled?'Automatic approval and merge: On. The server admits only eligible changes; current checks and independent review remain required.':'Automatic approval and merge: Off. Decisions remain with the owner.'),
    model.admissionPaused?el('p',{class:'capability-note'},'New assignments and starts are paused. Retained work can still be inspected.'):null,
    cards.length?el('div',{class:'coordination-grid'},cards):el('p',{},'Queue the first agreed task to begin.'),
    workspace.provider==='cloudflare-artifacts'?detail('Repository observations',
      model.lastObservation?el('p',{},'Last observed push in this project: ',el('code',{},shortSha(model.lastObservation.headCommit)),' · '+model.lastObservation.observedAt):el('p',{},'No repository push observation is recorded for this project.'),
      model.eventCounts?el('p',{class:'small'},'Workspace events: '+model.eventCounts.completed+' / '+model.eventCounts.events+' reconciled · '+model.eventCounts.pending+' pending · '+model.eventCounts.failed+' failed. '+model.eventCounts.attempts+' retained attempts.'):null,
      model.subscriptionCounts?el('p',{class:'small'},'Workspace automatic registrations: '+model.subscriptionCounts.ready+' / '+model.subscriptionCounts.repositories+' ready · '+model.subscriptionCounts.awaitingRecovery+' awaiting recovery. Operator-configured subscriptions are outside this count.'):null,
      el('p',{class:'small muted'},'A push observation is separate from agent submission, independent checks and a merge. The board follows saved workspace snapshots.')):null));
}
