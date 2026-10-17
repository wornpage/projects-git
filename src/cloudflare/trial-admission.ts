import {ApiError,digest,validateIdempotencyKey} from './security.ts';
import type {AccessPolicy,AccessPrincipal,HumanAccessIdentity} from './access.ts';
import {checkedTrialCleanup} from './trial-cleanup.ts';
import type {TrialCleanupResult} from './trial-cleanup.ts';
import {readTrialResources,TrialResourceStore,TRIAL_CLEANUP_ATTEMPTS} from './trial-controls.ts';
import type {TrialResourcePolicy} from './trial-controls.ts';

export interface TrialPolicy {revision:string;issuer:string;audience:string;durationMs:number;dailyAdmissions:number;activeTrials:number;totalAdmissions:number;resources:TrialResourcePolicy}
export interface TrialGrant {workspaceId:string;issuer:string;audience:string;ownerSubject:string;createdAt:number;expiresAt:number;closedAt:number|null;policyRevision:string}
type Storage=Pick<DurableObjectStorage,'sql'|'transactionSync'>;
type Row={subject_key:string;workspace_id:string;owner_subject:string;created_at:number;expires_at:number;closed_at:number|null;request_hash:string};
export interface TrialRegistry {
  admit(identity:HumanAccessIdentity,key:string,policy:TrialPolicy):Promise<TrialReply>;
  read(identity:HumanAccessIdentity,policy:TrialPolicy):Promise<TrialReply>;
  close(identity:HumanAccessIdentity,policy:TrialPolicy):Promise<TrialReply>;
  authorize(workspaceId:string,principal:AccessPrincipal,policy:TrialPolicy):Promise<TrialReply>;
  cleanupGrant(workspaceId:string,policy:TrialPolicy):Promise<TrialReply>;
  cleanupStatus(identity:HumanAccessIdentity,policy:TrialPolicy):Promise<TrialCleanupResult>;
  reserveResource(workspaceId:string,principal:AccessPrincipal,policy:TrialPolicy,kind:'setup'|'read'|'create'|'issue'|'push'):Promise<TrialReply>;
  controls(identity:HumanAccessIdentity,policy:TrialPolicy):Promise<TrialReply & {allowance?:ReturnType<TrialResourceStore['status']>}>;
}
const rpcErrors={
  TRIAL_CAPACITY_FULL:[429,'Trial capacity is full. The public read-only sample remains available.'],
  TRIAL_IDENTITY_FORBIDDEN:[403,'A current verified trial identity is required.'],
  TRIAL_NOT_ADMITTED:[404,'Start a trial before opening a workspace.'],
  TRIAL_CLOSED:[403,'This trial is closed. No new workspace access is permitted.'],
  TRIAL_EXPIRED:[403,'This trial has expired. No new workspace access is permitted.'],
  TRIAL_POLICY_CHANGED:[503,'Trial settings differ from retained admission terms. Review the policy migration before proceeding.'],
  WORKSPACE_FORBIDDEN:[403,'This identity does not own this trial workspace.'],
  IDEMPOTENCY_REQUIRED:[400,'Send an Idempotency-Key of 8-128 supported characters.'],
  TRIAL_UNAVAILABLE:[503,'Trial admission is unavailable. No default workspace will be opened.'],
  TRIAL_CLEANUP_NOT_DUE:[409,'Trial cleanup is not due yet.'],
  TRIAL_SPENDING_UNAPPROVED:[403,'Trial resource spending is unapproved.'],
  TRIAL_APPROVAL_EXPIRED:[403,'Trial resource approval has expired.'],
  TRIAL_SPENDING_PAUSED:[403,'New trial resource work is paused.'],
  TRIAL_RESOURCE_LIMIT:[429,'The retained trial resource allowance is used.'],
  TRIAL_RESOURCE_REQUIRED:[409,'Reserve trial setup before resource effects.'],
  TRIAL_CREATE_OUTCOME_UNKNOWN:[409,'Inspect the original creation outcome before any further write.'],
} as const;
type TrialFailure=keyof typeof rpcErrors;
export type TrialReply={ok:true;grant:TrialGrant}|{ok:false;code:TrialFailure};
// RPC transports do not preserve custom Error subclasses/properties. Keep a
// closed result contract; neither provider text nor custom error fields cross it.
export async function trialReply(work:()=>Promise<TrialGrant>):Promise<TrialReply> {
  try{return {ok:true,grant:await work()};}
  catch(error){return {ok:false,code:error instanceof ApiError&&Object.hasOwn(rpcErrors,error.code)?error.code as TrialFailure:'TRIAL_UNAVAILABLE'};}
}
export function trialGrant(reply:TrialReply):TrialGrant {
  if(!reply||typeof reply!=='object'||typeof reply.ok!=='boolean')throw new ApiError(503,'TRIAL_UNAVAILABLE',rpcErrors.TRIAL_UNAVAILABLE[1]);
  if(!reply.ok){
    const code=Object.hasOwn(rpcErrors,reply.code)?reply.code:'TRIAL_UNAVAILABLE';
    throw new ApiError(rpcErrors[code][0],code,rpcErrors[code][1]);
  }
  const grant=reply.grant;
  if(!grant||Object.keys(grant).sort().join(',')!=='audience,closedAt,createdAt,expiresAt,issuer,ownerSubject,policyRevision,workspaceId'
    ||typeof grant.workspaceId!=='string'||!/^trial-[a-f0-9]{64}$/.test(grant.workspaceId)
    ||typeof grant.issuer!=='string'||!/^https:\/\/[a-z0-9][a-z0-9-]*\.cloudflareaccess\.com$/.test(grant.issuer)
    ||typeof grant.audience!=='string'||!/^[a-f0-9]{64}$/.test(grant.audience)
    ||typeof grant.ownerSubject!=='string'||!/^[A-Za-z0-9_.:@-]{1,200}$/.test(grant.ownerSubject)
    ||!Number.isSafeInteger(grant.createdAt)||grant.createdAt<0||!Number.isSafeInteger(grant.expiresAt)||grant.expiresAt>8.64e15
    ||grant.expiresAt<=grant.createdAt||grant.expiresAt-grant.createdAt>7*86400_000
    ||grant.closedAt!==null&&(!Number.isSafeInteger(grant.closedAt)||grant.closedAt<grant.createdAt||grant.closedAt>8.64e15)
    ||typeof grant.policyRevision!=='string'||!/^[a-z0-9-]{1,64}$/.test(grant.policyRevision))
    throw new ApiError(503,'TRIAL_UNAVAILABLE',rpcErrors.TRIAL_UNAVAILABLE[1]);
  return grant;
}
export const TRIAL_REGISTRY_NAME='trial-admissions-v1';
export const trialCleanupDue=(grant:TrialGrant,policy:TrialPolicy)=>(grant.closedAt??grant.expiresAt)+policy.resources.cleanupDelayMs;

export function readTrialPolicy(raw:string):TrialPolicy {
  let value:TrialPolicy;
  try {value=JSON.parse(raw);}catch{throw new ApiError(503,'TRIAL_NOT_CONFIGURED','Configure an explicit trial admission policy.');}
  const keys=['revision','issuer','audience','durationMs','dailyAdmissions','activeTrials','totalAdmissions','resources'];
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==keys.sort().join(',')
    ||typeof value.revision!=='string'||!/^[a-z0-9-]{1,64}$/.test(value.revision)
    ||typeof value.issuer!=='string'||!/^https:\/\/[a-z0-9][a-z0-9-]*\.cloudflareaccess\.com$/.test(value.issuer)
    ||typeof value.audience!=='string'||!/^[a-f0-9]{64}$/.test(value.audience)
    ||!Number.isSafeInteger(value.durationMs)||value.durationMs<60_000||value.durationMs>7*86400_000
    ||!Number.isSafeInteger(value.dailyAdmissions)||value.dailyAdmissions<1||value.dailyAdmissions>100
    ||!Number.isSafeInteger(value.activeTrials)||value.activeTrials<1||value.activeTrials>100
    ||!Number.isSafeInteger(value.totalAdmissions)||value.totalAdmissions<1||value.totalAdmissions>10_000)
    throw new ApiError(503,'TRIAL_NOT_CONFIGURED','Trial policy contains missing, invalid or unsupported values.');
  return {revision:value.revision,issuer:value.issuer,audience:value.audience,durationMs:value.durationMs,
    dailyAdmissions:value.dailyAdmissions,activeTrials:value.activeTrials,totalAdmissions:value.totalAdmissions,resources:readTrialResources(value.resources)};
}

function assertHuman(identity:HumanAccessIdentity,policy:TrialPolicy,now:number):void {
  if(!identity||identity.issuer!==policy.issuer||identity.audience!==policy.audience
    ||typeof identity.subject!=='string'||!/^[A-Za-z0-9_.:@-]{1,200}$/.test(identity.subject)
    ||!Number.isSafeInteger(identity.issuedAt)||!Number.isSafeInteger(identity.expiresAt)
    ||identity.issuedAt>Math.floor(now/1000)||identity.expiresAt<=Math.floor(now/1000))
    throw new ApiError(403,'TRIAL_IDENTITY_FORBIDDEN','A current verified trial identity is required.');
}

export function trialAccessPolicy(grant:TrialGrant):AccessPolicy {
  return {issuer:grant.issuer,audience:grant.audience,workspaceId:grant.workspaceId,ownerSubject:grant.ownerSubject,
    agentClientIds:[],reviewerClientIds:[],reviewerSubjects:[],memberSubjects:[]};
}
export function assertTrialActive(grant:TrialGrant,now=Date.now()):void {
  if(grant.closedAt!==null)throw new ApiError(403,'TRIAL_CLOSED','This trial is closed. No new workspace access is permitted.');
  if(now>=grant.expiresAt)throw new ApiError(403,'TRIAL_EXPIRED','This trial has expired. No new workspace access is permitted.');
}
export function trialStatus(grant:TrialGrant,now=Date.now()) {
  return {workspaceId:grant.workspaceId,status:grant.closedAt!==null?'closed':now>=grant.expiresAt?'expired':'admitted',
    createdAt:new Date(grant.createdAt).toISOString(),expiresAt:new Date(grant.expiresAt).toISOString(),
    remainingMs:grant.closedAt===null?Math.max(0,grant.expiresAt-now):0,policyRevision:grant.policyRevision,
    workflowReady:false,capabilities:{workspaceReads:grant.closedAt===null&&now<grant.expiresAt,repositoryCreation:false,agents:false,checks:false,modelCredits:false},
    cleanup:grant.closedAt!==null||now>=grant.expiresAt?'pending':'not-due'};
}

// The registry coordinates bounded admission capacity only. Workflow state stays
// in separate workspace DOs. All transitions are synchronous SQLite transactions;
// hashing happens before entering them, and identity freshness is checked again.
export class TrialAdmissionStore {
  private storage:Storage;
  private policy:TrialPolicy;
  private now:()=>number;
  readonly resources:TrialResourceStore;
  constructor(storage:Storage,policy:TrialPolicy,now:()=>number=Date.now) {
    this.storage=storage;this.policy=readTrialPolicy(JSON.stringify(policy));this.now=now;
    storage.transactionSync(()=>{
      storage.sql.exec('CREATE TABLE IF NOT EXISTS trial_policy(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL)');
      const retained=storage.sql.exec<{data:string}>('SELECT data FROM trial_policy WHERE id=1').toArray()[0];
      const data=JSON.stringify(this.policy);
      if(retained&&retained.data!==data)throw new ApiError(503,'TRIAL_POLICY_CHANGED','Retained trial policy differs. Review a migration before changing admission terms.');
      if(!retained)storage.sql.exec('INSERT INTO trial_policy(id,data) VALUES(1,?)',data);
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS trial_admissions(
        subject_key TEXT PRIMARY KEY,workspace_id TEXT NOT NULL UNIQUE,owner_subject TEXT NOT NULL,
        created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,closed_at INTEGER,request_hash TEXT NOT NULL)`);
      storage.sql.exec('CREATE INDEX IF NOT EXISTS trial_admission_created ON trial_admissions(created_at)');
      storage.sql.exec('CREATE TABLE IF NOT EXISTS trial_cleanup(workspace_id TEXT PRIMARY KEY,attempts INTEGER NOT NULL,next_at INTEGER,result TEXT NOT NULL,attempt_id TEXT)');
    });
    this.resources=new TrialResourceStore(storage,this.policy.resources,now);
  }
  assertPolicy(expected:TrialPolicy):void {
    if(JSON.stringify(readTrialPolicy(JSON.stringify(expected)))!==JSON.stringify(this.policy))
      throw new ApiError(503,'TRIAL_POLICY_CHANGED','The current Worker and retained registry disagree about admission policy.');
  }
  private grant(row:Row):TrialGrant {
    if(row.workspace_id!=='trial-'+row.subject_key)throw new ApiError(503,'TRIAL_UNAVAILABLE','Retained trial routing is inconsistent.');
    return trialGrant({ok:true,grant:{workspaceId:row.workspace_id,ownerSubject:row.owner_subject,issuer:this.policy.issuer,audience:this.policy.audience,
      createdAt:row.created_at,expiresAt:row.expires_at,closedAt:row.closed_at,policyRevision:this.policy.revision}});
  }
  private async subjectKey(identity:HumanAccessIdentity):Promise<string> {
    assertHuman(identity,this.policy,this.now());
    return digest(JSON.stringify([identity.issuer,identity.subject]));
  }
  async admit(identity:HumanAccessIdentity,key:string):Promise<TrialGrant> {
    validateIdempotencyKey(key);
    const subjectKey=await this.subjectKey(identity),requestHash=await digest(key);
    return this.storage.transactionSync(()=>{
      const now=this.now();assertHuman(identity,this.policy,now);
      const prior=this.storage.sql.exec<Row>('SELECT * FROM trial_admissions WHERE subject_key=?',subjectKey).toArray()[0];
      // A different request key never creates another trial or extends its time.
      if(prior)return this.grant(prior);
      const counts=this.storage.sql.exec<{total:number;active:number;today:number}>(`SELECT count(*) total,
        coalesce(sum(CASE WHEN closed_at IS NULL AND expires_at>? THEN 1 ELSE 0 END),0) active,
        coalesce(sum(CASE WHEN created_at>=? THEN 1 ELSE 0 END),0) today FROM trial_admissions`,now,Math.floor(now/86400_000)*86400_000).one();
      if(counts.total>=this.policy.totalAdmissions||counts.active>=this.policy.activeTrials||counts.today>=this.policy.dailyAdmissions)
        throw new ApiError(429,'TRIAL_CAPACITY_FULL','Trial capacity is full. The public read-only sample remains available.');
      const workspaceId='trial-'+subjectKey;
      this.storage.sql.exec('INSERT INTO trial_admissions(subject_key,workspace_id,owner_subject,created_at,expires_at,closed_at,request_hash) VALUES(?,?,?,?,?,NULL,?)',
        subjectKey,workspaceId,identity.subject,now,now+this.policy.durationMs,requestHash);
      return this.grant(this.storage.sql.exec<Row>('SELECT * FROM trial_admissions WHERE subject_key=?',subjectKey).one());
    });
  }
  async read(identity:HumanAccessIdentity):Promise<TrialGrant> {
    const key=await this.subjectKey(identity);assertHuman(identity,this.policy,this.now());
    const row=this.storage.sql.exec<Row>('SELECT * FROM trial_admissions WHERE subject_key=?',key).toArray()[0];
    if(!row)throw new ApiError(404,'TRIAL_NOT_ADMITTED','Start a trial before opening a workspace.');
    return this.grant(row);
  }
  async close(identity:HumanAccessIdentity):Promise<TrialGrant> {
    const key=await this.subjectKey(identity);
    return this.storage.transactionSync(()=>{
      const now=this.now();assertHuman(identity,this.policy,now);
      const row=this.storage.sql.exec<Row>('SELECT * FROM trial_admissions WHERE subject_key=?',key).toArray()[0];
      if(!row)throw new ApiError(404,'TRIAL_NOT_ADMITTED','There is no trial to close.');
      this.storage.sql.exec('UPDATE trial_admissions SET closed_at=coalesce(closed_at,?) WHERE subject_key=?',now,key);
      return this.grant(this.storage.sql.exec<Row>('SELECT * FROM trial_admissions WHERE subject_key=?',key).one());
    });
  }
  async authorize(workspaceId:string,principal:AccessPrincipal):Promise<TrialGrant> {
    if(!principal||principal.provider!=='cloudflare-access'||principal.kind!=='owner'||principal.workspaceId!==workspaceId)
      throw new ApiError(403,'WORKSPACE_FORBIDDEN','This identity does not own this trial workspace.');
    const grant=await this.read({issuer:principal.issuer,audience:this.policy.audience,subject:principal.id,
      displayName:principal.displayName,issuedAt:principal.issuedAt,expiresAt:principal.expiresAt});
    if(grant.workspaceId!==workspaceId)throw new ApiError(403,'WORKSPACE_FORBIDDEN','This identity does not own this trial workspace.');
    assertTrialActive(grant,this.now());return grant;
  }
  async reserveResource(workspaceId:string,principal:AccessPrincipal,kind:'setup'|'read'|'create'|'issue'|'push'):Promise<TrialGrant> {
    await this.authorize(workspaceId,principal);
    // Refresh synchronously after the awaited identity check, then reserve in
    // the same event-loop turn. Closure cannot slip between this read and write.
    const row=this.storage.sql.exec<Row>('SELECT * FROM trial_admissions WHERE workspace_id=?',workspaceId).one(),grant=this.grant(row);
    const now=this.now();
    assertHuman({issuer:principal.issuer,audience:this.policy.audience,subject:principal.id,displayName:principal.displayName,
      issuedAt:principal.issuedAt,expiresAt:principal.expiresAt},this.policy,now);
    assertTrialActive(grant,now);
    if(kind==='setup')this.resources.reserveSetup(workspaceId);else this.resources.reserveEffect(workspaceId,kind);
    return grant;
  }
  cleanupGrant(workspaceId:string):TrialGrant {
    const row=this.storage.sql.exec<Row>('SELECT * FROM trial_admissions WHERE workspace_id=?',workspaceId).toArray()[0];
    if(!row)throw new ApiError(404,'TRIAL_NOT_ADMITTED','No admitted trial owns this workspace.');
    const grant=this.grant(row);
    if(this.now()<trialCleanupDue(grant,this.policy))throw new ApiError(409,'TRIAL_CLEANUP_NOT_DUE','Cleanup is not due.');
    return grant;
  }
  cleanupStatus(grant:TrialGrant):TrialCleanupResult {
    const row=this.storage.sql.exec<{result:string}>('SELECT result FROM trial_cleanup WHERE workspace_id=?',grant.workspaceId).toArray()[0];
    return row?checkedTrialCleanup(JSON.parse(row.result)):{state:'pending',resources:null,deleted:null,reason:this.now()<trialCleanupDue(grant,this.policy)?'NOT_DUE':'SCHEDULED'};
  }
  cleanupSchedule():{workspaceId:string;at:number}[] {
    return this.storage.sql.exec<Row&{next_at:number|null;result:string|null}>(`SELECT a.*,c.next_at,c.result FROM trial_admissions a
      LEFT JOIN trial_cleanup c ON a.workspace_id=c.workspace_id
      WHERE c.workspace_id IS NULL OR c.next_at IS NOT NULL`).toArray().map(row=>({workspaceId:row.workspace_id,at:Math.max(trialCleanupDue(this.grant(row),this.policy),row.next_at??0)})).sort((a,b)=>a.at-b.at);
  }
  claimCleanup(workspaceId:string):string|null {
    this.cleanupGrant(workspaceId);
    return this.storage.transactionSync(()=>{
      const previous=this.storage.sql.exec<{attempts:number;next_at:number|null;result:string}>('SELECT attempts,next_at,result FROM trial_cleanup WHERE workspace_id=?',workspaceId).toArray()[0];
      if(previous&&(previous.next_at===null||previous.next_at>this.now()))return null;
      if(previous&&previous.attempts>=TRIAL_CLEANUP_ATTEMPTS){
        this.storage.sql.exec('UPDATE trial_cleanup SET next_at=NULL,result=? WHERE workspace_id=?',JSON.stringify({...JSON.parse(previous.result),state:'blocked',reason:'RETRY_LIMIT'}),workspaceId);return null;
      }
      const attempts=(previous?.attempts??0)+1,attemptId=crypto.randomUUID(),next=this.now()+Math.min(3600_000,300_000*2**(attempts-1));
      this.storage.sql.exec('INSERT INTO trial_cleanup(workspace_id,attempts,next_at,result,attempt_id) VALUES(?,?,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET attempts=excluded.attempts,next_at=excluded.next_at,result=excluded.result,attempt_id=excluded.attempt_id',
        workspaceId,attempts,next,JSON.stringify({...(previous?JSON.parse(previous.result):{resources:null,deleted:null}),state:'pending',reason:'CLEANUP_IN_PROGRESS'}),attemptId);
      return attemptId;
    });
  }
  recordCleanup(workspaceId:string,attemptId:string,result:TrialCleanupResult):void {
    this.cleanupGrant(workspaceId);
    checkedTrialCleanup(result);
    this.storage.transactionSync(()=>{
      const previous=this.storage.sql.exec<{attempts:number;attempt_id:string;result:string}>('SELECT attempts,attempt_id,result FROM trial_cleanup WHERE workspace_id=?',workspaceId).toArray()[0];
      if(!previous||previous.attempt_id!==attemptId||JSON.parse(previous.result).state==='complete')return;
      const attempts=previous.attempts,next=result.state==='pending'&&attempts<TRIAL_CLEANUP_ATTEMPTS?this.now()+Math.min(60*60*1000,300_000*2**(attempts-1)):null;
      const retained=next===null&&result.state==='pending'?{...result,state:'blocked' as const}:result;
      this.storage.sql.exec('UPDATE trial_cleanup SET next_at=?,result=? WHERE workspace_id=? AND attempt_id=?',next,JSON.stringify(retained),workspaceId,attemptId);
    });
  }
}
