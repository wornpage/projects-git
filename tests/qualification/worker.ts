import {DurableObject,WorkerEntrypoint} from 'cloudflare:workers';
import production, {WorkspaceCoordinator as ProductionWorkspace} from '../../src/cloudflare/index.ts';
import {RepositoryCheckContainer as ProductionCheck} from '../../src/cloudflare/check-container.ts';
import {WorkspaceStore} from '../../src/cloudflare/workspace-store.ts';
import {ArtifactGit} from '../../src/cloudflare/git-transport.mjs';
import type {ModelProvider} from '../../src/core/agent.mjs';
import {checkoutTotal} from './candidate.mjs';
import {privateQualificationFetch} from './private-fetch.ts';
import {expireQualificationOperation} from './expire-operation.ts';

type Phase='artifact-get'|'checkout-start'|'model-response'|'git-ack'|'token-list';
const phases:Phase[]=['artifact-get','checkout-start','model-response','git-ack','token-list'];
interface GateState {held:Partial<Record<Phase,boolean>>;tokenList?:'armed'|'consumed';events:{phase:string;key:string;at:string}[]}
type QualificationEnv=Env&{GATES:DurableObjectNamespace<QualificationGates>};

// Only qualification exports contain faults. There are no HTTP fault routes.
export class QualificationGates extends DurableObject<QualificationEnv> {
  private waiting=new Map<Phase,Set<()=>void>>();
  read():GateState {return this.ctx.storage.sql.exec('SELECT name FROM sqlite_master WHERE name = ?', 'qualification_gates').toArray().length
    ? JSON.parse(this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM qualification_gates WHERE id=1').one().data) : {held:{},events:[]};}
  private write(state:GateState){this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS qualification_gates(id INTEGER PRIMARY KEY,data TEXT NOT NULL)');this.ctx.storage.sql.exec('INSERT OR REPLACE INTO qualification_gates VALUES(1,?)',JSON.stringify(state));}
  configure(phase:Phase,held:boolean){if(!phases.includes(phase)||typeof held!=='boolean')throw Error('Invalid qualification barrier');const state=this.read();state.held[phase]=held;this.write(state);if(!held){for(const release of this.waiting.get(phase)??[])release();this.waiting.delete(phase);}return this.read();}
  record(phase:string,key:string){const state=this.read();if(state.events.length>=2000)throw Error('Qualification event limit');state.events.push({phase,key,at:new Date().toISOString()});this.write(state);}
  armTokenList(){const state=this.read();if(state.held['token-list'])throw Error('Previous token-list barrier is still held');state.tokenList='armed';this.write(state);}
  async tokenList(key:string){const state=this.read();if(state.tokenList!=='armed')return;state.tokenList='consumed';state.held['token-list']=true;this.write(state);await this.wait('token-list',key);}
  async wait(phase:Phase,key:string){this.record(phase,key);if(!this.read().held[phase])return;
    await new Promise<void>((resolve,reject)=>{const group=this.waiting.get(phase)??new Set<()=>void>();this.waiting.set(phase,group);
      const release=()=>{clearTimeout(timer);group.delete(release);resolve();};
      const timer=setTimeout(()=>{group.delete(release);reject(Error('Qualification barrier exceeded two minutes'));},120000);group.add(release);});}
}

export class WorkspaceCoordinator extends ProductionWorkspace {
  private gate(){return (this.env as QualificationEnv).GATES.getByName(this.env.WORKSPACE_ID);}
  protected artifacts():Artifacts {const native=super.artifacts(),gate=this.gate();return {get:async(name:string)=>{
    await gate.wait('artifact-get',name);const repo=await native.get(name);
    // Native Artifacts handles must keep their method receivers. Forward the
    // controller's used methods directly; do not proxy or bind native methods.
    return {
      [Symbol.dispose]:()=>repo[Symbol.dispose](),
      info:()=>repo.info(),readCommit:(...args:Parameters<ArtifactsRepo['readCommit']>)=>repo.readCommit(...args),
      readTree:(...args:Parameters<ArtifactsRepo['readTree']>)=>repo.readTree(...args),readBlob:(...args:Parameters<ArtifactsRepo['readBlob']>)=>repo.readBlob(...args),
      log:(...args:Parameters<ArtifactsRepo['log']>)=>repo.log(...args),fork:(...args:Parameters<ArtifactsRepo['fork']>)=>repo.fork(...args),
      createToken:(...args:Parameters<ArtifactsRepo['createToken']>)=>repo.createToken(...args),revokeToken:(...args:Parameters<ArtifactsRepo['revokeToken']>)=>repo.revokeToken(...args),
      listTokens:async()=>{await gate.tokenList(name);return repo.listTokens();},
    };
  }} as Artifacts;}
  protected gitTransport():ArtifactGit {const gate=this.gate();return new class extends ArtifactGit {
    async merge(input:Parameters<ArtifactGit['merge']>[0]){const commit=await super.merge(input);await gate.record('git-write-completed',commit);await gate.wait('git-ack',commit);return commit;}
  }();}
  protected modelProvider():ModelProvider {const gate=this.gate();return async({signal})=>{signal.throwIfAborted();await gate.wait('model-response',crypto.randomUUID());signal.throwIfAborted();return {
    content:JSON.stringify({files:[{path:'checkout.mjs',content:'// Scripted qualification fixture; no model request.\nexport const checkoutTotal = '+checkoutTotal.toString()+';\n'}],summary:'Scripted qualification fixture; zero model-provider calls.'}),
    finishReason:'stop',usage:{prompt_tokens:0,completion_tokens:0,total_tokens:0}};};}
  protected async verifyCheckout(source:string,commit:string,signal?:AbortSignal,attemptId?:string){await this.gate().wait('checkout-start',attemptId??'missing');return super.verifyCheckout(source,commit,signal,attemptId);}
  qualificationSnapshot(){return new WorkspaceStore(this.ctx.storage,this.env.WORKSPACE_ID).read();}
  qualificationRepositoryIndex():{hasProjects:boolean;seedConnected:boolean;forks:Record<string,string>}{
    const snapshot=this.qualificationSnapshot(),projects=Object.values(snapshot.workspace.projects??{});
    return {hasProjects:projects.length>0,seedConnected:projects.some(project=>project.repositoryName===this.env.MODEL_REPOSITORY),
      forks:Object.fromEntries(Object.entries(snapshot.forks).map(([id,fork])=>[id,fork.name]))};
  }
  qualificationExpire(runId:string,attemptId?:string){const store=new WorkspaceStore(this.ctx.storage,this.env.WORKSPACE_ID),snapshot=store.read();
    if(!expireQualificationOperation(snapshot,runId,attemptId))throw Error('No pending operation for the supplied run and attempt');const revision=snapshot.revision;snapshot.revision++;store.write(snapshot,revision);return snapshot;}
  qualificationRestart(){this.ctx.abort('Requested private qualification restart');}
  async qualificationWake(){await this.ctx.storage.setAlarm(Date.now());}
  async qualificationTokens(runId:string){if(!/^[a-f0-9-]{36}$/.test(runId))throw Error('Invalid run');const state=this.qualificationSnapshot(),resource=state.forks[runId]?.name??Object.values(state.operations).find(op=>op.itemId===runId)?.resourceName;if(!resource)throw Error('Run has no retained resource');using repo=await super.artifacts().get(resource);return (await repo.listTokens()).tokens.map(({id,state,expiresAt})=>({id,state,expiresAt}));}
}

export class RepositoryCheckContainer extends ProductionCheck {
  async qualificationActivity(){if(!this.ctx.container?.running)return {running:false,ready:false};const check=await this.ctx.container.exec(['node','-e','process.exit(require("fs").existsSync("/tmp/qualification-ready")?0:1)']);return {running:true,ready:await check.exitCode===0};}
  async qualificationRelease(){if(!this.ctx.container?.running)throw Error('No running qualification executor');const check=await this.ctx.container.exec(['node','-e','require("fs").writeFileSync("/tmp/qualification-release","release")']);if(await check.exitCode!==0)throw Error('Could not release the qualification check');}
}

export class QualificationControl extends WorkerEntrypoint<QualificationEnv> {
  private workspace(){return this.env.WORKSPACES.getByName(this.env.WORKSPACE_ID) as unknown as DurableObjectStub<WorkspaceCoordinator>;}
  snapshot(){return this.workspace().qualificationSnapshot();}
  async lifecycleCreateSeed(){
    const index=await this.workspace().qualificationRepositoryIndex();
    if(index.hasProjects)throw Error('Seed creation is only available before connecting a project.');
    return this.env.ARTIFACTS.create(this.env.MODEL_REPOSITORY,{description:'Private lifecycle seed for '+this.env.WORKSPACE_ID,setDefaultBranch:'main',readOnly:false});
  }
  async lifecycleRepository(runId?:string,scope:'read'|'write'='read'){
    const index=await this.workspace().qualificationRepositoryIndex();
    if(!['read','write'].includes(scope)||runId!==undefined&&!/^[a-f0-9-]{36}$/.test(runId))throw Error('Invalid lifecycle repository request');
    const name=runId?index.forks[runId]:this.env.MODEL_REPOSITORY;
    if(!name||scope==='write'&&(runId!==undefined||index.seedConnected))
      throw Error('Only the unconnected seed may receive a bootstrap write credential.');
    using repo=await this.env.ARTIFACTS.get(name);const info=await repo.info(),token=await repo.createToken(scope,300);
    return {name,remote:info.remote,branch:info.defaultBranch,token:token.plaintext,expiresAt:token.expiresAt};
  }
  async lifecycleRetire(){
    const index=await this.workspace().qualificationRepositoryIndex(),names=[...new Set([this.env.MODEL_REPOSITORY,...Object.values(index.forks)])];
    const result=[];
    for(const name of names){using repo=await this.env.ARTIFACTS.get(name);for(const token of (await repo.listTokens()).tokens)if(token.state==='active')await repo.revokeToken(token.id);
      result.push({name,tokens:(await repo.listTokens()).tokens.map(({id,state,expiresAt})=>({id,state,expiresAt}))});}
    return result;
  }
  gates(){return this.env.GATES.getByName(this.env.WORKSPACE_ID).read();}
  configure(phase:Phase,held:boolean){return this.env.GATES.getByName(this.env.WORKSPACE_ID).configure(phase,held);}
  armTokenList(){return this.env.GATES.getByName(this.env.WORKSPACE_ID).armTokenList();}
  tokens(runId:string){return this.workspace().qualificationTokens(runId);}
  async seedCredential(){using repo=await this.env.ARTIFACTS.get(this.env.MODEL_REPOSITORY);const info=await repo.info(),token=await repo.createToken('write',180);return {token:token.plaintext,remote:info.remote,branch:info.defaultBranch,baseCommit:(await repo.log({ref:info.defaultBranch,limit:1}))[0]?.hash,expiresAt:token.expiresAt};}
  expire(runId:string,attemptId?:string){return this.workspace().qualificationExpire(runId,attemptId);}
  restart(){return this.workspace().qualificationRestart();}
  wake(){return this.workspace().qualificationWake();}
  repositories(){return this.env.ARTIFACTS.list({limit:200});}
  async seedState(retireTokens=false){using repo=await this.env.ARTIFACTS.get(this.env.MODEL_REPOSITORY);const info=await repo.info();if(retireTokens)for(const token of (await repo.listTokens()).tokens)if(token.state==='active')await repo.revokeToken(token.id);return {name:info.name,head:(await repo.log({ref:info.defaultBranch,limit:1}))[0]?.hash,tokens:(await repo.listTokens()).tokens.map(({id,state,expiresAt})=>({id,state,expiresAt}))};}
  async activity(attemptId:string,index:number){if(!/^[a-f0-9-]{36}$/.test(attemptId)||!Number.isInteger(index)||index<0||index>=16)throw Error('Invalid attempt');const stub=this.env.REPOSITORY_CHECKS.getByName(attemptId+':'+index) as unknown as DurableObjectStub<RepositoryCheckContainer>;return stub.qualificationActivity();}
  async release(attemptId:string,index:number){if(!/^[a-f0-9-]{36}$/.test(attemptId)||!Number.isInteger(index)||index<0||index>=16)throw Error('Invalid attempt');const stub=this.env.REPOSITORY_CHECKS.getByName(attemptId+':'+index) as unknown as DurableObjectStub<RepositoryCheckContainer>;return stub.qualificationRelease();}
}
export default {...production,fetch:privateQualificationFetch(production.fetch)};
