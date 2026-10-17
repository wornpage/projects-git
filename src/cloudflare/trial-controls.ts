import {ApiError} from './security.ts';

export interface TrialResourcePolicy {
  approval:string|null;approvalExpiresAt:number|null;
  dailySetups:number;totalSetups:number;setupAttempts:number;providerCalls:number;cleanupDelayMs:number;
}
type Storage=Pick<DurableObjectStorage,'sql'|'transactionSync'>;
type Usage={workspace_id:string;started_at:number;attempts:number;calls:number;create_started:number};
export const TRIAL_CLEANUP_ATTEMPTS=6,TRIAL_CLEANUP_CALLS=32;
const invalid=()=>new ApiError(503,'TRIAL_NOT_CONFIGURED','Configure explicit trial resource approval, limits and retention.');
export function readTrialResources(value:unknown):TrialResourcePolicy {
  if(!value||typeof value!=='object'||Array.isArray(value))throw invalid();
  const v=value as TrialResourcePolicy;
  if(Object.keys(v).sort().join(',')!=='approval,approvalExpiresAt,cleanupDelayMs,dailySetups,providerCalls,setupAttempts,totalSetups'
    ||v.approval!==null&&(typeof v.approval!=='string'||!/^[A-Za-z0-9_.-]{8,100}$/.test(v.approval))
    ||v.approvalExpiresAt!==null&&(!Number.isSafeInteger(v.approvalExpiresAt)||v.approvalExpiresAt<0||v.approvalExpiresAt>8.64e15)
    ||(v.approval===null)!==(v.approvalExpiresAt===null)
    ||!Number.isSafeInteger(v.cleanupDelayMs)||v.cleanupDelayMs<300_000||v.cleanupDelayMs>7*86400_000)throw invalid();
  for(const [key,max] of [['dailySetups',100],['totalSetups',1000],['setupAttempts',10],['providerCalls',200]] as const)
    if(!Number.isSafeInteger(v[key])||v[key]<0||v[key]>max||(v.approval===null?v[key]!==0:v[key]<1))throw invalid();
  return {approval:v.approval,approvalExpiresAt:v.approvalExpiresAt,dailySetups:v.dailySetups,totalSetups:v.totalSetups,
    setupAttempts:v.setupAttempts,providerCalls:v.providerCalls,cleanupDelayMs:v.cleanupDelayMs};
}

// This ledger bounds admitted application work, not the Cloudflare invoice.
// Reservations survive failures, retries, cleanup and UTC-day changes.
export class TrialResourceStore {
  private storage:Storage;private policy:TrialResourcePolicy;private now:()=>number;
  constructor(storage:Storage,policy:TrialResourcePolicy,now:()=>number=Date.now) {
    this.storage=storage;this.policy=readTrialResources(policy);this.now=now;
    storage.sql.exec('CREATE TABLE IF NOT EXISTS trial_resource_stop(id INTEGER PRIMARY KEY CHECK(id=1),reason TEXT NOT NULL)');
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS trial_resource_usage(workspace_id TEXT PRIMARY KEY,started_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL,calls INTEGER NOT NULL,create_started INTEGER NOT NULL)`);
  }
  private usage(workspaceId:string) {return this.storage.sql.exec<Usage>('SELECT * FROM trial_resource_usage WHERE workspace_id=?',workspaceId).toArray()[0];}
  private reason(now=this.now()):string|null {
    if(this.policy.approval===null)return 'TRIAL_SPENDING_UNAPPROVED';
    if(now>=this.policy.approvalExpiresAt!)return 'TRIAL_APPROVAL_EXPIRED';
    if(this.storage.sql.exec('SELECT 1 FROM trial_resource_stop WHERE id=1').toArray().length)return 'TRIAL_SPENDING_PAUSED';
    return null;
  }
  private assertEnabled(now=this.now()) {const code=this.reason(now);if(code)throw new ApiError(403,code,'New trial resource work is paused. Existing status and cleanup remain available.');}
  pause(reason:string):void {
    if(typeof reason!=='string'||!/^[A-Z_]{1,64}$/.test(reason))throw new ApiError(400,'INVALID_TRIAL_STOP','Use a bounded stop reason.');
    this.storage.sql.exec('INSERT INTO trial_resource_stop(id,reason) VALUES(1,?) ON CONFLICT(id) DO NOTHING',reason);
  }
  status(workspaceId:string) {
    const usage=this.usage(workspaceId),now=this.now(),stop=this.reason(now);
    const counts=this.storage.sql.exec<{total:number;today:number}>(`SELECT count(*) total,
      coalesce(sum(CASE WHEN started_at>=? THEN 1 ELSE 0 END),0) today FROM trial_resource_usage`,Math.floor(now/86400_000)*86400_000).one();
    const reason=stop??((usage?usage.attempts>=this.policy.setupAttempts||usage.calls>=this.policy.providerCalls
      :counts.total>=this.policy.totalSetups||counts.today>=this.policy.dailySetups)?'TRIAL_RESOURCE_LIMIT':null);
    return {spending:stop??'approved',setupAvailable:reason===null,reason,setupAttempts:{used:usage?.attempts??0,limit:this.policy.setupAttempts},
      providerCalls:{used:usage?.calls??0,limit:this.policy.providerCalls},billingCapGuaranteed:false};
  }
  reserveSetup(workspaceId:string):void {
    this.storage.transactionSync(()=>{
      const now=this.now();this.assertEnabled(now);const prior=this.usage(workspaceId);
      if(prior&&(prior.attempts>=this.policy.setupAttempts||prior.calls>=this.policy.providerCalls))
        throw new ApiError(429,'TRIAL_RESOURCE_LIMIT','The retained trial setup allowance is used. Cleanup remains available.');
      if(!prior){
        const count=this.storage.sql.exec<{total:number;today:number}>(`SELECT count(*) total,
          coalesce(sum(CASE WHEN started_at>=? THEN 1 ELSE 0 END),0) today FROM trial_resource_usage`,Math.floor(now/86400_000)*86400_000).one();
        if(count.total>=this.policy.totalSetups||count.today>=this.policy.dailySetups)
          throw new ApiError(429,'TRIAL_RESOURCE_LIMIT','The retained trial setup allowance is used. Cleanup remains available.');
        this.storage.sql.exec('INSERT INTO trial_resource_usage(workspace_id,started_at,attempts,calls,create_started) VALUES(?,?,1,0,0)',workspaceId,now);
      }else this.storage.sql.exec('UPDATE trial_resource_usage SET attempts=attempts+1 WHERE workspace_id=?',workspaceId);
    });
  }
  reserveEffect(workspaceId:string,kind:'read'|'create'|'issue'|'push'):void {
    if(!['read','create','issue','push'].includes(kind))throw new ApiError(400,'INVALID_TRIAL_EFFECT','Unsupported resource effect.');
    this.storage.transactionSync(()=>{
      this.assertEnabled();const prior=this.usage(workspaceId);
      if(!prior)throw new ApiError(409,'TRIAL_RESOURCE_REQUIRED','Reserve this trial setup before provider work.');
      if(prior.calls>=this.policy.providerCalls)throw new ApiError(429,'TRIAL_RESOURCE_LIMIT','The retained provider allowance is used. Cleanup remains available.');
      // A lost create acknowledgement is inspected by name and marker. Never
      // send a second create while its first outcome could still be in flight.
      if(kind==='create'&&prior.create_started)throw new ApiError(409,'TRIAL_CREATE_OUTCOME_UNKNOWN','The original creation outcome needs inspection. No replacement will be created.');
      this.storage.sql.exec('UPDATE trial_resource_usage SET calls=calls+1,create_started=max(create_started,?) WHERE workspace_id=?',kind==='create'?1:0,workspaceId);
    });
  }
}
