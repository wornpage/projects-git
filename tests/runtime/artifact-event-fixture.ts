import {WorkerEntrypoint} from 'cloudflare:workers';
import worker,{WorkspaceCoordinator as ProductionCoordinator} from '../../src/cloudflare/index.ts';
import {WorkspaceStore} from '../../src/cloudflare/workspace-store.ts';
import {ArtifactEventReceipts,artifactEventKey,artifactEventPolicy,parseArtifactPush} from '../../src/cloudflare/artifact-events.ts';
import type {ArtifactEventSource} from '../../src/cloudflare/artifact-events.ts';
import {initialSnapshot} from '../../src/cloudflare/controller.ts';
import {accessPolicy,ownerBinding} from '../../src/cloudflare/access.ts';
import {createTask,assignRun,startRun} from '../../src/core/workflow.mjs';
import {qualificationReady,validateQualificationBarrier} from './artifact-event-barrier.ts';
import type {QualificationBarrier} from './artifact-event-barrier.ts';

type QualificationEnv=Env&{EVENT_QUAL_LOCAL:string;EVENT_QUAL_PROJECT:string;EVENT_QUAL_CANDIDATE:string;EVENT_QUAL_INPUT:Queue};

/** Qualification-only namespace. No test control is exported by the application
 * entry point; this worker refuses every public HTTP request. */
export class WorkspaceCoordinator extends ProductionCoordinator {
  private notices=new Set<()=>void>();
  constructor(ctx:DurableObjectState,env:QualificationEnv){
    super(ctx,env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS event_qualification_control (id INTEGER PRIMARY KEY, fault INTEGER NOT NULL, head TEXT, reads INTEGER NOT NULL)');
    ctx.storage.sql.exec('INSERT INTO event_qualification_control VALUES (1,0,NULL,0) ON CONFLICT DO NOTHING');
  }
  protected artifactEventSource():ArtifactEventSource {
    const native=super.artifactEventSource(),env=this.env as QualificationEnv;
    return {get:async name=>{
      const control=this.ctx.storage.sql.exec<{fault:number;head:string|null;reads:number}>('SELECT * FROM event_qualification_control WHERE id = 1').one();
      if(control.fault){this.ctx.storage.sql.exec('UPDATE event_qualification_control SET fault = 0 WHERE id = 1');await this.ctx.storage.sync();this.ctx.abort('QUALIFICATION_RESTART_AFTER_RESERVATION');}
      this.ctx.storage.sql.exec('UPDATE event_qualification_control SET reads = reads + 1 WHERE id = 1');
      if(env.EVENT_QUAL_LOCAL==='true')return {log:async()=>control.head?[{hash:control.head}]:[],[Symbol.dispose](){}};
      return native.get(name);
    }};
  }
  async seedFixture(input:{baseCommit:string;branch:string}):Promise<{runId:string;projectId:string}> {
    const env=this.env as QualificationEnv,store=new WorkspaceStore(this.ctx.storage,env.WORKSPACE_ID),before=store.read();
    if(before.workspace.runs.length)throw Error('FIXTURE_ALREADY_SEEDED');
    if(!/^[a-f0-9]{40}$/.test(input.baseCommit)||!/^newwork\/[a-z0-9-]+$/.test(input.branch))throw Error('INVALID_FIXTURE_SEED');
    const snapshot=initialSnapshot(env.WORKSPACE_ID);snapshot.workspace.authentication=ownerBinding(accessPolicy(env));
    const projectId=crypto.randomUUID();snapshot.workspace.projects![projectId]={id:projectId,name:'Scripted event qualification',repositoryName:env.EVENT_QUAL_PROJECT,
      mainCommit:input.baseCommit,defaultBranch:'main',kind:'artifacts',acceptingWork:true,policyVersion:1,owner:'Scripted fixture'};
    const task=createTask(snapshot.workspace,{title:'Observe Artifacts pushes',purpose:'Qualification-only seeded workflow; no human approval claim',criteria:['Provider pushes become visible with retained receipts'],baseCommit:input.baseCommit,owner:'Scripted fixture'});
    task.projectId=projectId;task.origin='artifacts';
    const run=assignRun(snapshot.workspace,task.id,{agent:'scripted-qualification',label:'Scripted qualification builder',branch:input.branch});run.origin='external-agent';
    startRun(snapshot.workspace,run.id);snapshot.forks[run.id]={name:env.EVENT_QUAL_CANDIDATE,remote:'https://example.invalid/qualification-context-only.git'};
    snapshot.revision=before.revision+1;store.write(snapshot,before.revision);return {runId:run.id,projectId};
  }
  fixtureHead(head:string){if(!/^[a-f0-9]{40}$/.test(head))throw Error('INVALID_FIXTURE_HEAD');this.ctx.storage.sql.exec('UPDATE event_qualification_control SET head = ? WHERE id = 1',head);}
  fixtureFault(){this.ctx.storage.sql.exec('UPDATE event_qualification_control SET fault = 1 WHERE id = 1');}
  fixtureRead(){const snapshot=new WorkspaceStore(this.ctx.storage,this.env.WORKSPACE_ID).read();return {workspace:snapshot.workspace,revision:snapshot.revision,
    receipts:new ArtifactEventReceipts(this.ctx.storage).summary(),
    deliveries:this.ctx.storage.sql.exec<{message_id:string;event_key:string}>('SELECT message_id,event_key FROM artifact_deliveries ORDER BY rowid').toArray(),
    events:this.ctx.storage.sql.exec<{event_key:string;event:string;status:string;result:string|null}>('SELECT event_key,event,status,result FROM artifact_events ORDER BY rowid').toArray().map(row=>({...row,event:JSON.parse(row.event),result:row.result?JSON.parse(row.result):null})),
    attempts:this.ctx.storage.sql.exec('SELECT * FROM artifact_event_attempts ORDER BY rowid').toArray(),
    control:this.ctx.storage.sql.exec('SELECT fault,head,reads FROM event_qualification_control WHERE id = 1').one(),
    fixtureIdentity:true,modelCalls:0,checkExecutions:0};}
  override async artifactPush(body:unknown,messageId:string){const result=await super.artifactPush(body,messageId);for(const notice of [...this.notices])notice();return result;}
  async fixtureWait(input:QualificationBarrier):Promise<ReturnType<WorkspaceCoordinator['fixtureRead']>>{
    validateQualificationBarrier(input);
    const read=()=>this.fixtureRead(),ready=(value:ReturnType<typeof read>)=>qualificationReady(value,input);
    const current=read();if(ready(current))return current;
    return new Promise((yes,no)=>{
      const timer=setTimeout(()=>{this.notices.delete(changed);no(Error('QUALIFICATION_EVENT_WAIT_EXPIRED'))},75000);
      const changed=()=>{const value=read();if(ready(value)){clearTimeout(timer);this.notices.delete(changed);yes(value)}};
      this.notices.add(changed);changed();
    });
  }
}

/** Reachable solely through the qualifier's private service binding. */
export class EventQualificationControl extends WorkerEntrypoint<QualificationEnv>{
  private coordinator(){return this.env.WORKSPACES.getByName(this.env.WORKSPACE_ID) as DurableObjectStub<WorkspaceCoordinator>;}
  seed(input:{baseCommit:string;branch:string}){return this.coordinator().seedFixture(input);}
  head(input:{head:string}){return this.coordinator().fixtureHead(input.head);}
  fault(){return this.coordinator().fixtureFault();}
  read(){return this.coordinator().fixtureRead();}
  wait(input:QualificationBarrier){return this.coordinator().fixtureWait(input);}
  async emit(input:{body:unknown}){const event=parseArtifactPush(input.body,artifactEventPolicy(this.env));await this.env.EVENT_QUAL_INPUT.send(input.body);return {eventKey:artifactEventKey(event,this.env.WORKSPACE_ID)};}
  direct(input:{body:unknown;messageId:string}){return this.coordinator().artifactPush(input.body,input.messageId);}
}
export default {queue:worker.queue,fetch(){return new Response('Unavailable',{status:404});}};
