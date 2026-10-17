// Local Workerd harness: production SQL store, API dispatch, scheduler and alarm.
// Git transport and verifier observations are explicitly scripted fixtures.
import {DurableObject} from 'cloudflare:workers';
import {WorkspaceCoordinator, WorkspacePolicy} from '../../src/cloudflare/index.ts';
export {WorkspacePolicy};

// Separate durable fixture authority, never the retained coordinator's env.
// The actual private RPC and production policy validation run on every lookup.
export class PolicyState extends DurableObject {
  constructor(ctx,env){super(ctx,env);ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS policy(value TEXT)');}
  set(value){this.ctx.storage.sql.exec('DELETE FROM policy');this.ctx.storage.sql.exec('INSERT INTO policy VALUES(?)',JSON.stringify(value));}
  read(){return JSON.parse(this.ctx.storage.sql.exec('SELECT value FROM policy').one().value);}
}
export class FixturePolicy extends WorkspacePolicy {
  async readPolicy(workspaceId,nonce){
    const value=await this.env.POLICY_STATE.getByName('current').read();
    if(value.unavailable)throw Error('Controlled authority outage');
    return WorkspacePolicy.prototype.readPolicy.call({env:value.env},workspaceId,nonce);
  }
}

export class AutomaticMergeFixture extends WorkspaceCoordinator {
  constructor(ctx,env) {
    super(ctx,env);
    const write=this.store.write.bind(this.store);
    this.store.write=(snapshot,revision,options)=>{
      write(snapshot,revision,options);
      if(Object.values(snapshot.operations).some(op=>op.kind==='merge'&&op.state==='failed')
        &&this.ctx.storage.sql.exec('SELECT crash_once FROM fixture_git').one().crash_once){
        this.ctx.storage.sql.exec('UPDATE fixture_git SET crash_once=0');
        this.crashPending=(async()=>{
          await this.ctx.storage.sync();
          this.ctx.abort('Controlled crash immediately after the durable failed-merge write');
        })();
        this.ctx.waitUntil(this.crashPending);
      }
    };
  }
  async seed(snapshot) {
    const current = this.store.read();
    if (current.workspace.tasks.length) throw Error('Fixture already seeded');
    const crash=Boolean(snapshot.fixtureCrash),phase=snapshot.fixturePhase??'';delete snapshot.fixtureCrash;delete snapshot.fixturePhase;
    snapshot.revision = current.revision + 1;
    this.store.write(snapshot, current.revision);
    this.ctx.storage.sql.exec('CREATE TABLE fixture_git(id INTEGER PRIMARY KEY, head TEXT, checks INTEGER, pushes INTEGER, fail_token INTEGER, crash_once INTEGER, phase TEXT)');
    this.ctx.storage.sql.exec('INSERT INTO fixture_git VALUES(1,?,0,0,?,?,?)', snapshot.workspace.tasks[0].baseCommit,crash?1:0,crash?1:0,phase);
    return {seeded:true};
  }
  read() {return {snapshot:this.store.read(), activity:this.ctx.storage.sql.exec('SELECT * FROM fixture_git').one()};}
  async invokeAlarm() {await this.alarm();return this.read();}
  async restart() {await this.ctx.storage.sync();this.ctx.abort('Controlled coordinator restart with retained SQLite');}
  async revokeAt(phase) {
    if(this.read().activity.phase!==phase)return;
    const state=this.env.POLICY_STATE.getByName('current'),value=await state.read();
    await state.set({...value,env:{...value.env,ACCESS_REVIEWER_CLIENT_IDS:'[]'}});
  }
  async outcome() {
    const signal = AbortSignal.timeout(8000);
    while (true) {
      const result=this.read(),run=result.snapshot.workspace.runs[0];
      if (run.status === 'merged' || run.automaticMergeStop) {
        if(this.crashPending)await this.crashPending;
        return result;
      }
      await this.store.waitForChange(result.snapshot.revision,signal);
    }
  }
  artifacts() {
    const coordinator=this;
    return {get:async name=>({
      [Symbol.dispose]() {},
      info:async()=>({name,defaultBranch:'main',remote:'https://artifacts.example.test/'+name+'.git'}),
      listTokens:async()=>({tokens:[],total:0}), revokeToken:async()=>true,
      createToken:async()=>{
        if(coordinator.read().activity.fail_token)throw Error('Controlled credential failure before Git write');
        return {id:'fixture-token',plaintext:'synthetic-transport-fixture'};
      },
      log:async()=>[{hash:name==='target' ? coordinator.read().activity.head : 'b'.repeat(40)}],
      readCommit:async hash=>({hash,treeHash:'d'.repeat(40)}),
      readTree:async()=>[{name:'checkout.mjs',mode:'100644',type:'blob',hash:'e'.repeat(40)}],
      readBlob:async()=>{await coordinator.revokeAt('source-read');return new Blob(['export const checkoutTotal = () => 42;']);},
    })};
  }
  async verifyCheckout(_source,commit) {
    this.ctx.storage.sql.exec('UPDATE fixture_git SET checks = checks + 1');
    await this.revokeAt('verification');
    return {...this.store.read().workspace.runs[0].evidence,commit,verifiedAt:new Date().toISOString()};
  }
  gitTransport() {
    return {merge:async input=>{
      await this.revokeAt('before-push');
      await input.beforePush();
      if(this.read().activity.head!==input.baseCommit)throw Error('Fixture remote changed');
      this.ctx.storage.sql.exec('UPDATE fixture_git SET head = ?, pushes = pushes + 1', input.headCommit);
      if(this.read().activity.phase==='uncertain')throw Error('Controlled lost acknowledgement after actual fixture ref update');
    }};
  }
}

export default {async fetch(request,env) {
  const stub=env.WORKSPACES.getByName(env.WORKSPACE_ID),path=new URL(request.url).pathname;
  if(path==='/policy'){await env.POLICY_STATE.getByName('current').set(await request.json());return Response.json({updated:true});}
  const result=path==='/seed' ? await stub.seed(await request.json()) : path==='/outcome' ? await stub.outcome()
    : path==='/read' ? await stub.read() : path==='/alarm' ? await stub.invokeAlarm() : path==='/restart' ? await stub.restart() : await stub.api(await request.json());
  return result instanceof Response ? result : Response.json(result);
}};
