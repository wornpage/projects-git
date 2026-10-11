import {createHash} from 'node:crypto';
import {ApiError} from './security.ts';

export interface SubscriptionPlan {
  accountId:string; namespace:string; queueId:string; workspaceId:string;
  ownerKey:string; repositoryName:string; name:string;
}
export interface RegisteredSubscription {id:string; enabled:boolean}
export interface SubscriptionProvider {
  find(plan:SubscriptionPlan):Promise<RegisteredSubscription[]>;
  create(plan:SubscriptionPlan):Promise<RegisteredSubscription>;
  enable(plan:SubscriptionPlan,id:string):Promise<RegisteredSubscription>;
}
export const subscriptionDigest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function subscriptionPlan(input:Omit<SubscriptionPlan,'name'>):SubscriptionPlan {
  if(!/^[a-f0-9]{32}$/.test(input.accountId)||!/^[a-f0-9]{32}$/.test(input.queueId)||!/^[a-f0-9]{64}$/.test(input.ownerKey)
    ||[input.namespace,input.workspaceId,input.repositoryName].some(v=>typeof v!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(v)))
    throw new ApiError(503,'SUBSCRIPTIONS_NOT_CONFIGURED','Pin the event account, namespace, queue, workspace and owner before automatic registration.');
  const value={accountId:input.accountId,namespace:input.namespace,queueId:input.queueId,workspaceId:input.workspaceId,ownerKey:input.ownerKey,repositoryName:input.repositoryName};
  return {...value,name:'projects-git-'+subscriptionDigest(value)};
}
type Storage=Pick<DurableObjectStorage,'sql'|'transactionSync'|'sync'>;
type Row={repository:string;fingerprint:string;plan:string;phase:'reserved'|'creating'|'bound'|'ready';subscription_id:string|null;attempt_id:string};

/** One ledger per owned workspace. Provider POST is never repeated after an
 * uncertain outcome; recovery locates the exact deterministic subscription. */
export class ArtifactSubscriptions {
  private storage:Storage;
  private work=new Map<string,Promise<void>>();
  constructor(storage:Storage){
    this.storage=storage;
    storage.transactionSync(()=>{
      storage.sql.exec('CREATE TABLE IF NOT EXISTS artifact_subscriptions (repository TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, plan TEXT NOT NULL, phase TEXT NOT NULL, subscription_id TEXT UNIQUE, attempt_id TEXT NOT NULL)');
      storage.sql.exec('CREATE TABLE IF NOT EXISTS artifact_subscription_attempts (id TEXT PRIMARY KEY, repository TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL, error_code TEXT)');
    });
  }
  bindings(planScope:Omit<SubscriptionPlan,'name'|'repositoryName'>):{id:string;repositoryName:string}[]{
    return this.storage.sql.exec<Row>('SELECT * FROM artifact_subscriptions WHERE subscription_id IS NOT NULL').toArray().filter(row=>{
      const plan=subscriptionPlan({...planScope,repositoryName:row.repository});return row.fingerprint===subscriptionDigest(plan);
    }).map(row=>({id:row.subscription_id!,repositoryName:row.repository}));
  }
  summary(){
    const rows=this.storage.sql.exec<{phase:string;n:number}>('SELECT phase,count(*) n FROM artifact_subscriptions GROUP BY phase').toArray();
    const attempts=this.storage.sql.exec<{n:number}>('SELECT count(*) n FROM artifact_subscription_attempts').one().n;
    return {repositories:rows.reduce((n,row)=>n+row.n,0),ready:rows.find(row=>row.phase==='ready')?.n??0,
      awaitingRecovery:rows.filter(row=>row.phase!=='ready').reduce((n,row)=>n+row.n,0),attempts,
      definition:'Owned repositories, enabled subscriptions and retained registration attempts are separate counts.'};
  }
  async ensure(plan:SubscriptionPlan,provider:SubscriptionProvider,validate:()=>void):Promise<void>{
    validate();
    const normalized=subscriptionPlan(plan);
    if(JSON.stringify(normalized)!==JSON.stringify(plan))throw new ApiError(403,'SUBSCRIPTION_PLAN_INVALID','Use the canonical subscription plan.');
    const previous=this.work.get(plan.repositoryName)??Promise.resolve();
    const pending=previous.catch(()=>{}).then(()=>this.register(plan,provider,validate));
    this.work.set(plan.repositoryName,pending);
    try{await pending;}finally{if(this.work.get(plan.repositoryName)===pending)this.work.delete(plan.repositoryName);}
  }
  private row(repository:string):Row|undefined{return this.storage.sql.exec<Row>('SELECT * FROM artifact_subscriptions WHERE repository = ?',repository).toArray()[0];}
  private async register(plan:SubscriptionPlan,provider:SubscriptionProvider,validate:()=>void){
    validate();
    const fingerprint=subscriptionDigest(plan),repository=plan.repositoryName,previous=this.row(repository);
    if(previous&&previous.fingerprint!==fingerprint)throw new ApiError(409,'SUBSCRIPTION_CONFIG_CHANGED','Reconcile the retained subscription before changing its owner, account, namespace or queue.');
    if(previous?.phase==='ready')return;
    const attempt=crypto.randomUUID(),at=new Date().toISOString();
    this.storage.transactionSync(()=>{
      if(!previous&&this.storage.sql.exec<{n:number}>('SELECT count(*) n FROM artifact_subscriptions').one().n>=128)
        throw new ApiError(409,'SUBSCRIPTION_CAPACITY','The workspace has reached its 128-subscription limit.');
      if(this.storage.sql.exec<{n:number}>('SELECT count(*) n FROM artifact_subscription_attempts').one().n>=4096)
        throw new ApiError(409,'SUBSCRIPTION_CAPACITY','Retain registration history before admitting further attempts.');
      if(previous)this.storage.sql.exec("UPDATE artifact_subscription_attempts SET status='superseded',finished_at=? WHERE id=? AND status='pending'",at,previous.attempt_id);
      this.storage.sql.exec("INSERT INTO artifact_subscriptions(repository,fingerprint,plan,phase,attempt_id) VALUES (?,?,?,'reserved',?) ON CONFLICT(repository) DO UPDATE SET attempt_id=excluded.attempt_id",repository,fingerprint,JSON.stringify(plan),attempt);
      this.storage.sql.exec("INSERT INTO artifact_subscription_attempts(id,repository,started_at,status) VALUES (?,?,?,'pending')",attempt,repository,at);
    });
    const current=()=>{validate();const row=this.row(repository);if(!row||row.attempt_id!==attempt)throw new ApiError(409,'SUBSCRIPTION_ATTEMPT_SUPERSEDED','A newer registration attempt owns this repository.');return row;};
    try{
      await this.storage.sync();
      let row=current();
      if(!row.subscription_id){
        // Search before creation as well as after interrupted creation. List and
        // exact provider-shape validation live in the isolated registration service.
        const matches=await provider.find(plan);row=current();
        if(matches.length>1)throw new ApiError(409,'SUBSCRIPTION_AMBIGUOUS','Multiple subscriptions match this reserved identity; reconcile them explicitly.');
        let found=matches[0];
        if(!found){
          if(row.phase==='creating')throw new ApiError(409,'SUBSCRIPTION_OUTCOME_UNKNOWN','The earlier creation has no confirmed outcome. Retry reconciliation; a second subscription will not be created.');
          this.storage.sql.exec("UPDATE artifact_subscriptions SET phase='creating' WHERE repository=?",repository);
          await this.storage.sync();current();
          found=await provider.create(plan);current();
        }
        if(!/^[a-f0-9-]{16,64}$/.test(found.id)||found.enabled!==false)
          throw new ApiError(409,'SUBSCRIPTION_UNSAFE_STATE','A new subscription must be confirmed disabled before binding its identity.');
        this.storage.sql.exec("UPDATE artifact_subscriptions SET phase='bound',subscription_id=? WHERE repository=?",found.id,repository);
        await this.storage.sync();row=current();
      }
      // The Queue consumer can now validate this durable ID even if enabling it
      // succeeds and the response is lost. PATCH of the same ID is repeatable.
      const enabled=await provider.enable(plan,row.subscription_id!);current();
      if(enabled.id!==row.subscription_id||enabled.enabled!==true)throw new ApiError(502,'SUBSCRIPTION_ENABLE_UNCONFIRMED','Enabling the registered subscription was not confirmed.');
      this.storage.transactionSync(()=>{
        this.storage.sql.exec("UPDATE artifact_subscriptions SET phase='ready' WHERE repository=?",repository);
        this.storage.sql.exec("UPDATE artifact_subscription_attempts SET status='complete',finished_at=? WHERE id=?",new Date().toISOString(),attempt);
      });
      await this.storage.sync();current();
    }catch(error){
      // Never retain provider messages: they can contain credentials or payloads.
      const code=error instanceof ApiError?error.code:'SUBSCRIPTION_REQUEST_FAILED';
      this.storage.transactionSync(()=>{
        if(this.row(repository)?.attempt_id!==attempt)return;
        if(code==='SUBSCRIPTION_CREATE_REJECTED')this.storage.sql.exec("UPDATE artifact_subscriptions SET phase='reserved' WHERE repository=? AND phase='creating'",repository);
        this.storage.sql.exec("UPDATE artifact_subscription_attempts SET status='failed',finished_at=?,error_code=? WHERE id=?",new Date().toISOString(),code,attempt);
      });
      await this.storage.sync();throw error;
    }
  }
}
