import {createExampleWorkspace,exampleIds} from '../../public/demo/workspace.js';
import {initialSnapshot} from '../../src/cloudflare/controller.ts';
import {ownerBinding} from '../../src/cloudflare/access.ts';
import {testAuthority} from './hosted-authority.mjs';

export const scaleId = number => '00000000-0000-4000-8000-'+number.toString(16).padStart(12,'0');

// Deterministic synthetic histories, not provider executions or real identities.
export function scaleSnapshot(projectCount=100) {
  const snapshot=initialSnapshot('workspace-scale'), workspace=snapshot.workspace;
  workspace.authentication=ownerBinding(testAuthority(workspace.id).policy);
  workspace.name='100-project scale fixture';workspace.version=1;snapshot.revision=1;
  for(let projectIndex=0;projectIndex<projectCount;projectIndex++){
    const projectId=scaleId(projectIndex*100+1),repositoryName='scale-project-'+projectIndex;
    for(let group=0;group<4;group++){
      const start=projectIndex*100+group*10+2;
      const replacements={...Object.fromEntries(Object.entries(exampleIds).map(([key,value])=>[value,key==='project'?projectId:scaleId(start+['task','nextTask','fast','safe'].indexOf(key))])), 'read-only-example':workspace.id};
      const example=JSON.parse(JSON.stringify(createExampleWorkspace()),(_key,value)=>typeof value==='string'&&replacements[value]?replacements[value]:value);
      const project=example.projects[exampleIds.project];
      // JSON object keys also name projects; use the rewritten value explicitly.
      workspace.projects[projectId]={...project,id:projectId,name:'Project '+String(projectIndex+1).padStart(3,'0')+' · checkout service',repositoryName};
      const [task,followup]=example.tasks,[fast,safe]=example.runs;
      for(const entry of example.tasks){entry.repositoryName=repositoryName;entry.repositoryKey=projectId;snapshot.repositories[entry.id]=repositoryName;}
      task.revisions=Array.from({length:3},(_,index)=>({revision:index+1,reason:'Scripted scale fixture: clarify validation and retained outcomes.',purpose:task.purpose,criteria:task.criteria,at:`2026-10-0${index+1}T10:00:00Z`}));
      task.ownerHistory=[{owner:task.owner,ownerVersion:0,at:'2026-10-01T09:00:00Z'}];
      for(const run of [fast,safe]){
        run.label='Scripted scale fixture · '+run.label;
        run.evidenceHistory=Array.from({length:4},(_,index)=>({...structuredClone(run.evidence),taskRevision:index<2?1:2,verifiedAt:`2026-10-0${index+1}T10:10:00Z`,output:'Scripted check trace; no command executed. '+('validated integer inputs; retained prior failure; '.repeat(12))}));
        run.reviewHistory=[{...structuredClone(run.review),note:'Earlier scripted review retained after a requirements change.'}];
      }
      if(group===1){task.status='review';task.revision=2;task.acceptedRunId=null;task.mergedCommit=null;safe.status='awaiting_review';safe.review=null;fast.status='failed';}
      if(group===2){task.status='accepted';task.mergedCommit=null;safe.status='accepted';fast.status='superseded';}
      workspace.tasks.push(task,followup);workspace.runs.push(fast,safe);
      workspace.events.push(...example.events.map((event,index)=>({...event,id:scaleId(100_000+projectIndex*100+group*10+index),projectId})));
      for(let attempt=0;attempt<8;attempt++)snapshot.operations[`fixture-${projectIndex}-${group}-${attempt}`]={kind:'checks',fingerprint:'retained-'+projectIndex+'-'+group+'-'+attempt,state:attempt%3?'complete':'failed',itemId:safe.id,taskId:task.id,projectId,attemptId:scaleId(1_000_000+projectIndex*100+group*10+attempt)};
    }
  }
  // Activity outside the first page must still consume workspace-wide slots.
  const active=workspace.runs.slice(-3);
  active.forEach((run,index)=>{run.status=index===2?'assigned':'running';run.agent='external';const task=workspace.tasks.find(item=>item.id===run.taskId);task.status='running';task.acceptedRunId=null;task.mergedCommit=null;run.review=null;});
  snapshot.operations['pending-review']={kind:'review-inference',fingerprint:'reserved',state:'pending',reservesExecution:true,itemId:active[0].id};
  for(let index=0;index<2;index++)snapshot.operations['pending-check-'+index]={kind:'checks',fingerprint:'checking-'+index,state:'pending',itemId:active[index].id,attemptId:scaleId(2_000_000+index),leaseUntil:1};
  return snapshot;
}
