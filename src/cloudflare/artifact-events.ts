import {createHash} from 'node:crypto';
import {ApiError} from './security.ts';
import type {HostedSnapshot, SnapshotStore} from './controller.ts';
import type {RepositoryObservation} from '../core/workflow.mjs';

export interface ArtifactPush {
  accountId: string; subscriptionId: string; namespace: string; repositoryName: string;
  ref: string; before: string; after: string; timestamp: string;
}
export interface ArtifactEventPolicy {
  accountId: string; namespace: string; queue: string; workspaceId: string;
  subscriptions: {id: string; repositoryName: string}[];
  automatic?: boolean;
}
export interface ArtifactEventRepository {
  log(options:{ref:string;limit:number}):Promise<{hash:string}[]>;
  [Symbol.dispose]():void;
}
export interface ArtifactEventSource {get(name:string):Promise<ArtifactEventRepository>}
type EventConfiguration = Pick<Env,'ARTIFACTS_EVENTS_ACCOUNT_ID'|'ARTIFACTS_EVENTS_NAMESPACE'|'ARTIFACTS_EVENTS_QUEUE'|'ARTIFACTS_EVENTS_SUBSCRIPTIONS'|'WORKSPACE_ID'> & {ARTIFACTS_EVENTS_AUTOMATIC?:string};
const name=/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const id=/^[a-f0-9-]{16,64}$/;
const hash=/^[a-f0-9]{40}$/;
const object=(value: unknown): value is Record<string,unknown> => Boolean(value&&typeof value==='object'&&!Array.isArray(value));

export function artifactEventPolicy(env: EventConfiguration): ArtifactEventPolicy {
  const automatic=env.ARTIFACTS_EVENTS_AUTOMATIC==='true';
  let bindings: unknown;
  try { bindings=JSON.parse(env.ARTIFACTS_EVENTS_SUBSCRIPTIONS); } catch { throw new ApiError(503,'ARTIFACT_EVENTS_NOT_CONFIGURED','Configure the exact Artifacts event subscriptions.'); }
  if(!/^[a-f0-9]{32}$/.test(env.ARTIFACTS_EVENTS_ACCOUNT_ID)||!name.test(env.ARTIFACTS_EVENTS_NAMESPACE)
    ||!/^[a-z0-9][a-z0-9-]{0,99}$/.test(env.ARTIFACTS_EVENTS_QUEUE)||!name.test(env.WORKSPACE_ID)
    ||!Array.isArray(bindings)||(!automatic&&!bindings.length)||bindings.length>128
    ||bindings.some(b=>!object(b)||Object.keys(b).sort().join(',')!=='id,repositoryName'||typeof b.id!=='string'||!id.test(b.id)||typeof b.repositoryName!=='string'||!name.test(b.repositoryName))
    ||new Set(bindings.map(b=>b.id)).size!==bindings.length) {
    throw new ApiError(503,'ARTIFACT_EVENTS_NOT_CONFIGURED','Pin the event account, namespace, queue, workspace and repository subscriptions.');
  }
  return {accountId:env.ARTIFACTS_EVENTS_ACCOUNT_ID,namespace:env.ARTIFACTS_EVENTS_NAMESPACE,queue:env.ARTIFACTS_EVENTS_QUEUE,workspaceId:env.WORKSPACE_ID,
    subscriptions:bindings as ArtifactEventPolicy['subscriptions'],automatic};
}

/** Provider metadata scopes a notification. Git author fields grant no authority. */
export function parseArtifactPush(value: unknown, policy: ArtifactEventPolicy): ArtifactPush {
  const event=parseArtifactPushEnvelope(value,policy);
  if(!policy.subscriptions.some(s=>s.id===event.subscriptionId&&s.repositoryName===event.repositoryName))
    throw new ApiError(403,'ARTIFACT_EVENT_FORBIDDEN','The notification is outside the configured repository subscription.');
  return event;
}

/** Queue boundary checks account/namespace/schema. Automatic registrations are
 * pinned in SQLite and must still pass parseArtifactPush inside the coordinator. */
export function parseArtifactPushEnvelope(value: unknown, policy: ArtifactEventPolicy): ArtifactPush {
  if(!object(value)||value.type!=='cf.artifacts.repo.pushed'||!object(value.source)||!object(value.payload)||!object(value.metadata))
    throw new ApiError(422,'INVALID_ARTIFACT_EVENT','Expected an Artifacts repository push event.');
  const {source,payload,metadata}=value;
  if(source.type!=='artifacts.repo'||source.namespace!==policy.namespace||metadata.accountId!==policy.accountId
    ||typeof source.repoName!=='string'||!name.test(source.repoName)||typeof metadata.eventSubscriptionId!=='string'||!id.test(metadata.eventSubscriptionId))
    throw new ApiError(403,'ARTIFACT_EVENT_FORBIDDEN','The notification is outside the configured account and namespace.');
  if(metadata.eventSchemaVersion!==1||typeof metadata.eventTimestamp!=='string'||metadata.eventTimestamp.length>32||!Number.isFinite(Date.parse(metadata.eventTimestamp))
    ||typeof payload.ref!=='string'||!/^refs\/heads\/[A-Za-z0-9._/-]{1,250}$/.test(payload.ref)||payload.ref.includes('..')||payload.ref.includes('//')||/[/.]$/.test(payload.ref)
    ||typeof payload.before!=='string'||!hash.test(payload.before)||typeof payload.after!=='string'||!hash.test(payload.after))
    throw new ApiError(422,'INVALID_ARTIFACT_EVENT','The push needs a supported schema, branch, timestamp and exact Git hashes.');
  return {accountId:policy.accountId,subscriptionId:metadata.eventSubscriptionId,namespace:policy.namespace,repositoryName:source.repoName,
    ref:payload.ref,before:payload.before,after:payload.after,timestamp:metadata.eventTimestamp};
}

export function artifactEventKey(event: ArtifactPush, workspaceId: string): string {
  return createHash('sha256').update(JSON.stringify([workspaceId,event.accountId,event.namespace,event.repositoryName,event.ref,event.before,event.after,event.timestamp])).digest('hex');
}

type Storage=Pick<DurableObjectStorage,'sql'|'transactionSync'|'sync'>;
type ReceiptRow={event_key:string;status:string;attempt_id:string;result:string|null};
export class ArtifactEventReceipts {
  private storage: Storage;
  constructor(storage: Storage) {
    this.storage=storage;
    storage.transactionSync(()=>{
      storage.sql.exec('CREATE TABLE IF NOT EXISTS artifact_deliveries (message_id TEXT PRIMARY KEY, event_key TEXT NOT NULL)');
      storage.sql.exec('CREATE TABLE IF NOT EXISTS artifact_events (event_key TEXT PRIMARY KEY, event TEXT NOT NULL, status TEXT NOT NULL, attempt_id TEXT NOT NULL, result TEXT)');
      storage.sql.exec('CREATE TABLE IF NOT EXISTS artifact_event_attempts (attempt_id TEXT PRIMARY KEY, event_key TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL, error_code TEXT)');
    });
  }
  confirm():Promise<void>{return this.storage.sync();}
  reserve(messageId: string,eventKey: string,event: ArtifactPush): {attemptId:string;result:Record<string,unknown>|null} {
    if(!/^[A-Za-z0-9_.:-]{1,128}$/.test(messageId))throw new ApiError(422,'INVALID_EVENT_DELIVERY','Queue delivery identity is invalid.');
    return this.storage.transactionSync(()=>{
      const delivery=this.storage.sql.exec<{event_key:string}>('SELECT event_key FROM artifact_deliveries WHERE message_id = ?',messageId).toArray()[0];
      if(delivery&&delivery.event_key!==eventKey)throw new ApiError(409,'ARTIFACT_DELIVERY_CONFLICT','This delivery ID already identifies a different event.');
      const previous=this.storage.sql.exec<ReceiptRow>('SELECT * FROM artifact_events WHERE event_key = ?',eventKey).toArray()[0];
      if(!delivery){
        const total=this.storage.sql.exec<{n:number}>('SELECT count(*) AS n FROM artifact_deliveries').one().n;
        if(total>=4096)throw new ApiError(409,'ARTIFACT_RECEIPT_CAPACITY','Retain and archive this workspace event history before admitting more deliveries.');
        this.storage.sql.exec('INSERT INTO artifact_deliveries(message_id,event_key) VALUES (?,?)',messageId,eventKey);
      }
      if(previous?.status==='complete')return {attemptId:previous.attempt_id,result:JSON.parse(previous.result!)};
      const attemptCount=this.storage.sql.exec<{n:number}>('SELECT count(*) AS n FROM artifact_event_attempts').one().n;
      if(attemptCount>=16384)throw new ApiError(409,'ARTIFACT_RECEIPT_CAPACITY','Retain and archive this workspace reconciliation attempts before admitting more reads.');
      if(previous?.status==='pending')this.storage.sql.exec("UPDATE artifact_event_attempts SET status = 'superseded', finished_at = ? WHERE attempt_id = ? AND status = 'pending'",new Date().toISOString(),previous.attempt_id);
      const attemptId=crypto.randomUUID();
      this.storage.sql.exec("INSERT INTO artifact_events(event_key,event,status,attempt_id) VALUES (?,?,'pending',?) ON CONFLICT(event_key) DO UPDATE SET status = 'pending', attempt_id = excluded.attempt_id",eventKey,JSON.stringify(event),attemptId);
      this.storage.sql.exec("INSERT INTO artifact_event_attempts(attempt_id,event_key,started_at,status) VALUES (?,?,?,'pending')",attemptId,eventKey,new Date().toISOString());
      return {attemptId,result:null};
    });
  }
  current(eventKey:string,attemptId:string):boolean {
    return Boolean(this.storage.sql.exec('SELECT event_key FROM artifact_events WHERE event_key = ? AND attempt_id = ? AND status = ?',eventKey,attemptId,'pending').toArray().length);
  }
  finish(eventKey:string,attemptId:string,result:Record<string,unknown>):void {
    this.storage.transactionSync(()=>{
      if(!this.current(eventKey,attemptId))throw new ApiError(409,'ARTIFACT_ATTEMPT_SUPERSEDED','A newer read attempt owns this event.');
      this.storage.sql.exec("UPDATE artifact_events SET status = 'complete', result = ? WHERE event_key = ?",JSON.stringify(result),eventKey);
      this.storage.sql.exec("UPDATE artifact_event_attempts SET status = 'complete', finished_at = ? WHERE attempt_id = ?",new Date().toISOString(),attemptId);
    });
  }
  failed(eventKey:string,attemptId:string,code:string):void {
    if(!/^[A-Z_]{1,80}$/.test(code))code='ARTIFACT_RECONCILIATION_FAILED';
    this.storage.transactionSync(()=>{
      if(!this.current(eventKey,attemptId))return;
      this.storage.sql.exec("UPDATE artifact_events SET status = 'failed' WHERE event_key = ?",eventKey);
      this.storage.sql.exec("UPDATE artifact_event_attempts SET status = 'failed', finished_at = ?, error_code = ? WHERE attempt_id = ?",new Date().toISOString(),code,attemptId);
    });
  }
  summary() {
    const rows=this.storage.sql.exec<{status:string;n:number}>('SELECT status,count(*) AS n FROM artifact_events GROUP BY status').toArray();
    const attempts=this.storage.sql.exec<{n:number}>('SELECT count(*) AS n FROM artifact_event_attempts').one().n;
    const deliveries=this.storage.sql.exec<{n:number}>('SELECT count(*) AS n FROM artifact_deliveries').one().n;
    return {events:rows.reduce((sum,row)=>sum+row.n,0),completed:rows.find(row=>row.status==='complete')?.n??0,pending:rows.find(row=>row.status==='pending')?.n??0,
      failed:rows.find(row=>row.status==='failed')?.n??0,attempts,deliveries,deliveryLimit:4096,attemptLimit:16384,
      definition:'Distinct admitted provider events, retained reconciliation attempts and queue delivery IDs are separate counts. Failed and superseded attempts remain retained.'};
  }
}

function targets(snapshot:HostedSnapshot,event:ArtifactPush) {
  const branch=event.ref.slice('refs/heads/'.length);
  const runIds=Object.entries(snapshot.forks).filter(([runId,repo])=>repo.name===event.repositoryName&&snapshot.workspace.runs.some(run=>run.id===runId&&run.branch===branch)).map(([id])=>id);
  const projectIds=Object.values(snapshot.workspace.projects??{}).filter(project=>project.repositoryName===event.repositoryName&&project.defaultBranch===branch).map(p=>p.id);
  return {runIds,projectIds,branch};
}
function busy(snapshot:HostedSnapshot,runIds:string[],projectIds:string[]):boolean {
  return Object.values(snapshot.operations).some(op=>op.state==='pending'&&(
    Boolean(op.itemId&&runIds.includes(op.itemId))||Boolean(op.projectId&&projectIds.includes(op.projectId))
    ||snapshot.workspace.tasks.some(task=>projectIds.includes(task.projectId??'')&&(task.id===op.taskId||snapshot.workspace.runs.some(run=>run.taskId===task.id&&run.id===op.itemId)))));
}

/** Every external effect here is a read. Delivery replay never infers identity,
 * creates a fork/token, executes a check/model, accepts work or writes Git. */
export async function reconcileArtifactPush(store:SnapshotStore,receipts:ArtifactEventReceipts,artifacts:ArtifactEventSource,event:ArtifactPush,messageId:string,workspaceId:string,
  validateOwner:()=>void):Promise<Record<string,unknown>> {
  validateOwner();
  const key=artifactEventKey(event,workspaceId);
  const {attemptId,result}=receipts.reserve(messageId,key,event);
  try {
    // Await disk confirmation explicitly before entering any provider method.
    // A reset before outbound I/O must retain the reservation independently of
    // the runtime's implicit outgoing-message gate.
    await receipts.confirm();
    if(result)return {...result,replayed:true};
    let snapshot=store.read();
    const retained=snapshot.workspace.events.find(item=>item.repositoryEvent?.key===key);
    if(retained){receipts.finish(key,attemptId,retained.repositoryEvent!);await receipts.confirm();return {...retained.repositoryEvent,replayed:true};}
    const selected=targets(snapshot,event);
    if(!selected.runIds.length&&!selected.projectIds.length){const ignored={key,state:'unowned-ref'};receipts.finish(key,attemptId,ignored);await receipts.confirm();return ignored;}
    if(busy(snapshot,selected.runIds,selected.projectIds))throw new ApiError(409,'ARTIFACT_RECONCILIATION_BUSY','Reconcile retained operations before observing this ref.');
    const revision=snapshot.revision;
    using repo=await artifacts.get(event.repositoryName);
    const log=await repo.log({ref:selected.branch,limit:1});
    const head=log[0]?.hash??null;
    if(head!==null&&!hash.test(head))throw new ApiError(502,'INVALID_ARTIFACT_REF','Provider returned an invalid Git head.');
    validateOwner();
    snapshot=store.read();
    if(snapshot.revision!==revision||!receipts.current(key,attemptId))throw new ApiError(409,'ARTIFACT_OBSERVATION_CHANGED','Workspace or read attempt changed during provider I/O. Retry the retained delivery.');
    const observation:RepositoryObservation={eventKey:key,ref:event.ref,headCommit:head,observedAt:new Date().toISOString(),eventTimestamp:event.timestamp,requiresSubmission:false};
    for(const runId of selected.runIds){
      const run=snapshot.workspace.runs.find(r=>r.id===runId)!;
      const terminal=['merged','failed','rejected','superseded'].includes(run.status);
      const changed=head!==(run.headCommit??run.baseCommit);
      run.repositoryObservation={...observation,requiresSubmission:!terminal&&Boolean(changed||run.repositoryObservation?.requiresSubmission)};
      if(changed&&run.status==='accepted'){
        run.reviewHistory??=[];if(run.review)run.reviewHistory.push(run.review);
        run.review=null;run.status='awaiting_review';
        const task=snapshot.workspace.tasks.find(t=>t.id===run.taskId)!;task.acceptedRunId=null;task.status='review';
      }
    }
    for(const projectId of selected.projectIds){
      snapshot.workspace.projects![projectId].repositoryObservation={...observation,requiresSubmission:false};
      for(const task of snapshot.workspace.tasks.filter(t=>t.projectId===projectId&&!t.mergedCommit&&t.acceptedRunId&&t.baseCommit!==head)){
        const run=snapshot.workspace.runs.find(r=>r.id===task.acceptedRunId)!;
        run.reviewHistory??=[];if(run.review)run.reviewHistory.push(run.review);
        run.review=null;run.status='awaiting_review';task.acceptedRunId=null;task.status='review';
      }
    }
    const outcome={key,state:head===event.after?'observed':'superseded-notification',headCommit:head,repositoryName:event.repositoryName,ref:event.ref,
      runIds:selected.runIds,projectIds:selected.projectIds};
    snapshot.workspace.events.push({id:crypto.randomUUID(),at:observation.observedAt,type:'repository.push_observed',taskId:null,runId:selected.runIds[0]??null,
      projectId:selected.projectIds[0]??snapshot.workspace.tasks.find(t=>t.id===snapshot.workspace.runs.find(r=>r.id===selected.runIds[0])?.taskId)?.projectId,
      message:'Artifacts push observed for '+event.repositoryName+'. The live ref is '+(head??'absent')+'. Submission and owner decisions remain authenticated actions.',repositoryEvent:outcome});
    snapshot.workspace.version++;snapshot.revision++;
    store.write(snapshot,revision,{automaticIndex:false});
    // If interrupted between workflow commit and receipt completion, the retained
    // timeline key above completes replay without another observation or read.
    receipts.finish(key,attemptId,outcome);
    await receipts.confirm();
    return outcome;
  }catch(error){receipts.failed(key,attemptId,error instanceof ApiError?error.code:'ARTIFACT_RECONCILIATION_FAILED');throw error;}
}
