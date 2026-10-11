import {DurableObject,WorkerEntrypoint} from 'cloudflare:workers';
import production,{WorkspaceCoordinator as ProductionCoordinator} from '../../src/cloudflare/index.ts';
import {WorkspaceStore} from '../../src/cloudflare/workspace-store.ts';
import {ArtifactSubscriptions,subscriptionPlan} from '../../src/cloudflare/artifact-subscriptions.ts';
import type {SubscriptionPlan,SubscriptionProvider,RegisteredSubscription} from '../../src/cloudflare/artifact-subscriptions.ts';
import {ArtifactEventReceipts} from '../../src/cloudflare/artifact-events.ts';
import {accessPolicy} from '../../src/cloudflare/access.ts';
import {ArtifactsFixture,ArtifactsFixtureStore} from './artifacts-fixture.ts';
export {ArtifactsFixture,ArtifactsFixtureStore};
type FixtureEnv=Env&{SUBSCRIPTION_FIXTURE:DurableObjectNamespace<SubscriptionFixture>;PUSHES:Queue;ARTIFACTS:Service<ArtifactsFixture>};

/** Local provider simulation persists independently of the coordinator, so a
 * real coordinator abort can lose a response while retaining provider effects. */
export class SubscriptionFixture extends DurableObject {
  constructor(ctx:DurableObjectState,env:unknown){super(ctx,env);ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS subscriptions (name TEXT PRIMARY KEY, plan TEXT NOT NULL,id TEXT NOT NULL,enabled INTEGER NOT NULL)');}
  find(plan:SubscriptionPlan){return this.ctx.storage.sql.exec<{id:string;enabled:number}>('SELECT id,enabled FROM subscriptions WHERE name=?',plan.name).toArray().map(row=>({id:row.id,enabled:row.enabled===1}));}
  create(plan:SubscriptionPlan):RegisteredSubscription{
    if(JSON.stringify(subscriptionPlan(plan))!==JSON.stringify(plan))throw Error('INVALID_PLAN');
    const id=crypto.randomUUID().replaceAll('-','');
    this.ctx.storage.sql.exec('INSERT INTO subscriptions(name,plan,id,enabled) VALUES (?,?,?,0)',plan.name,JSON.stringify(plan),id);
    return {id,enabled:false};
  }
  enable(plan:SubscriptionPlan,id:string){
    const row=this.ctx.storage.sql.exec<{plan:string}>('SELECT plan FROM subscriptions WHERE id=?',id).one();
    if(row.plan!==JSON.stringify(plan))throw Error('MISMATCH');
    this.ctx.storage.sql.exec('UPDATE subscriptions SET enabled=1 WHERE id=?',id);return {id,enabled:true};
  }
  read(){return this.ctx.storage.sql.exec<{plan:string;id:string;enabled:number}>('SELECT plan,id,enabled FROM subscriptions ORDER BY rowid').toArray().map(row=>({...row,plan:JSON.parse(row.plan)}));}
}

export class WorkspaceCoordinator extends ProductionCoordinator{
  private notices=new Set<()=>void>();
  protected artifacts():Artifacts{return this.env.ARTIFACTS;}
  protected subscriptionProvider():SubscriptionProvider{
    const fixture=(this.env as FixtureEnv).SUBSCRIPTION_FIXTURE.getByName(this.env.WORKSPACE_ID);
    return {find:plan=>fixture.find(plan),enable:(plan,id)=>fixture.enable(plan,id),create:async plan=>{
      const result=await fixture.create(plan);
      const fault=await this.ctx.storage.get<boolean>('qualification-subscription-abort');
      if(fault){await this.ctx.storage.delete('qualification-subscription-abort');await this.ctx.storage.sync();this.ctx.abort('QUALIFICATION_ABORT_AFTER_SUBSCRIPTION_CREATE');}
      return result;
    }};
  }
  async fault(){await this.ctx.storage.put('qualification-subscription-abort',true);}
  async retireAbortedLease(){
    // Private fault harness only: the failed RPC confirmed that its DO aborted.
    const store=new WorkspaceStore(this.ctx.storage,this.env.WORKSPACE_ID),state=store.read();
    for(const op of Object.values(state.operations))if(op.state==='pending')op.leaseUntil=0;
    state.revision++;store.write(state,state.revision-1);await this.ctx.storage.sync();
  }
  read(){return {snapshot:new WorkspaceStore(this.ctx.storage,this.env.WORKSPACE_ID).read(),subscriptions:new ArtifactSubscriptions(this.ctx.storage).summary(),
    registrations:this.ctx.storage.sql.exec('SELECT * FROM artifact_subscriptions ORDER BY rowid').toArray(),
    registrationAttempts:this.ctx.storage.sql.exec('SELECT * FROM artifact_subscription_attempts ORDER BY rowid').toArray(),
    events:new ArtifactEventReceipts(this.ctx.storage).summary(),fixtureIdentity:true,simulatedProvider:true};}
  override async artifactPush(body:unknown,id:string){const value=await super.artifactPush(body,id);for(const notice of [...this.notices])notice();return value;}
  async wait(count:number){
    if(!Number.isInteger(count)||count<1||count>32)throw Error('INVALID_BARRIER');
    if(this.read().events.completed>=count)return this.read();
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.notices.delete(changed);reject(Error('EVENT_BARRIER_EXPIRED'));},20000);
      const changed=()=>{const state=this.read();if(state.events.completed>=count){clearTimeout(timer);this.notices.delete(changed);resolve(state);}};
      this.notices.add(changed);changed();
    });
  }
}

/** No fault controls or simulated identity are exported by the application. */
export class SubscriptionQualificationControl extends WorkerEntrypoint<FixtureEnv>{
  private coordinator(){return this.env.WORKSPACES.getByName(this.env.WORKSPACE_ID) as DurableObjectStub<WorkspaceCoordinator>;}
  async api(input:{path:string;body:Record<string,unknown>;key:string;foreign?:boolean}){
    const policy=accessPolicy(this.env),now=Math.floor(Date.now()/1000);
    const response=await this.coordinator().api({policy,principal:{provider:'cloudflare-access',kind:'owner',issuer:policy.issuer,id:policy.ownerSubject,
      workspaceId:input.foreign?'foreign':policy.workspaceId,displayName:'Scripted qualification owner',issuedAt:now,expiresAt:now+900},
      forbiddenSecrets:[],method:'POST',path:input.path,body:input.body,key:input.key});
    return {status:response.status,body:await response.json()};
  }
  fault(){return this.coordinator().fault();}
  retire(){return this.coordinator().retireAbortedLease();}
  async read(){return {...await this.coordinator().read(),providerSubscriptions:await this.env.SUBSCRIPTION_FIXTURE.getByName(this.env.WORKSPACE_ID).read()};}
  direct(input:{body:unknown;id:string}){return this.coordinator().artifactPush(input.body,input.id);}
  async emit(input:{body:unknown}){await this.env.PUSHES.send(input.body);return {sent:true};}
  wait(input:{count:number}){return this.coordinator().wait(input.count);}
}
export default {queue:production.queue,fetch:()=>new Response('Not found',{status:404})};
