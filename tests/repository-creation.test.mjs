import test from 'node:test';
import assert from 'node:assert/strict';
import {HostedController} from '../src/cloudflare/controller.ts';
import {WorkspaceStore} from '../src/cloudflare/workspace-store.ts';
import {sqliteStorage} from './helpers/sqlite-store.mjs';
import {testAuthority,testReviewerAuthority,AGENT_CLIENT} from './helpers/hosted-authority.mjs';
import {authorizeRoute} from '../src/cloudflare/access.ts';
import {errorResponse} from '../src/cloudflare/security.ts';

const HEAD='a'.repeat(40), INITIAL='sensitive-initial-token', WRITE='sensitive-write-token';
const input={name:'customer-portal',description:'A small customer portal.'};
function fixture(t) {
  const {db,storage}=sqliteStorage();t.after(()=>db.close());
  const store=new WorkspaceStore(storage,'mock-workspace'), calls=[], repositories=new Map();
  const artifacts={
    async get(name) {calls.push(['get',name]);if(!repositories.has(name))throw Object.assign(Error('No repository'),{code:'NOT_FOUND'});return repositories.get(name);},
    async create(name,options) {
      calls.push(['create',name,options]);
      if(repositories.has(name))throw Object.assign(Error('Name taken'),{code:'ALREADY_EXISTS'});
      const data={id:crypto.randomUUID(),name,description:options.description,defaultBranch:options.setDefaultBranch,readOnly:options.readOnly,
        remote:'https://abc.artifacts.cloudflare.net/git/workspace/'+name+'.git'};
      const tokens=new Map([['initial',{id:'initial',state:'active'}]]);
      const repo={data,tokens,head:null,
        async info(){return {...data};},
        async listTokens(){calls.push(['tokens',name]);return {tokens:[...tokens.values()].map(token=>({...token})),total:tokens.size};},
        async revokeToken(id){calls.push(['revoke',id]);const token=tokens.get(id);if(!token)return false;token.state='revoked';return true;},
        async createToken(scope,ttl){const id=crypto.randomUUID();calls.push(['issue',scope,ttl]);tokens.set(id,{id,state:'active'});return {id,plaintext:WRITE,scope,expiresAt:new Date(Date.now()+ttl*1000).toISOString()};},
        async log(){return this.head?[{hash:this.head}]:[];},
        async readCommit(hash){return hash===this.head?{hash,parents:[],treeHash:'b'.repeat(40)}:null;},
        [Symbol.dispose](){},
      };
      repositories.set(name,repo);
      if(artifacts.afterCreate)await artifacts.afterCreate(repo);
      return {...data,token:INITIAL};
    },
  };
  const runtime={git:{async seedRepository(options){calls.push(['seed',options.timestamp]);assert.equal(options.token,WRITE);await options.beforePush(HEAD);repositories.get(input.name).head=HEAD;return HEAD;}},
    async ensureSubscription(){}};
  const controller=new HostedController(store,artifacts,testAuthority(),runtime);
  const operation=()=>Object.values(store.read().operations).find(op=>op.kind==='repository-create');
  const restart=()=>new HostedController(new WorkspaceStore(storage,'mock-workspace'),artifacts,testAuthority(),runtime);
  return {store,artifacts,runtime,controller,calls,repositories,operation,restart};
}
const count=(f,kind)=>f.calls.filter(call=>call[0]===kind).length;

test('backup captures the beforePush creation receipt and known commit before a project is attached',async t=>{
  const f=fixture(t);f.runtime.git.seedRepository=async options=>{await options.beforePush(HEAD);throw Error('Controlled interrupted seed');};
  await assert.rejects(f.controller.createRepository(input,'backup-before-push'),{code:'REPOSITORY_CREATION_INTERRUPTED'});
  assert.equal(Object.keys(f.store.read().workspace.projects).length,0);assert.equal(f.operation().pendingCommit,HEAD);
  const calls=f.calls.length,backup=await f.controller.workspaceBackup();assert.equal(f.calls.length,calls);
  assert.equal(backup.payload.projects.length,0);assert.equal(backup.payload.resources.length,1);
  assert.equal(backup.payload.resources[0].repositoryName,input.name);assert.deepEqual(backup.payload.resources[0].commits,[HEAD]);
  assert.equal(backup.payload.resources[0].projectId,f.operation().projectId);
});

test('private creation seeds main, cleans credentials and connects one empty project; replay is stable',async t=>{
  const f=fixture(t),result=await f.controller.createRepository(input,'create-repo-01');
  assert.equal(result.name,input.name);assert.equal(result.baseCommit,HEAD);assert.equal(result.defaultBranch,'main');assert.equal(result.replayed,false);
  const snapshot=f.store.read(),project=snapshot.workspace.projects[result.projectId];
  assert.equal(project.mainCommit,HEAD);assert.equal(project.owner,testAuthority().principal.displayName);assert.equal(project.codeConnected,true);
  assert.equal(snapshot.workspace.tasks.length,0);assert.equal(snapshot.workspace.runs.length,0);
  assert.deepEqual(f.calls.find(call=>call[0]==='create')[2],{description:f.operation().marker,readOnly:false,setDefaultBranch:'main'});
  assert.match(f.operation().marker,/A small customer portal/);
  assert.ok([...f.repositories.get(input.name).tokens.values()].every(token=>token.state==='revoked'));
  assert.deepEqual(f.calls.find(call=>call[0]==='issue').slice(1),['write',180]);
  const serialized=JSON.stringify({snapshot,result});assert.ok(!serialized.includes(INITIAL));assert.ok(!serialized.includes(WRITE));
  const before=f.calls.length,replay=await f.restart().createRepository(input,'create-repo-01');
  assert.equal(replay.projectId,result.projectId);assert.equal(replay.replayed,true);assert.equal(f.calls.length,before);
  const queued=await f.controller.createTasks({source:'project',projectId:result.projectId,tasks:[{title:'First task',purpose:'Build useful code',owner:'Owner',criteria:['Working code']}]},'first-task-01');
  assert.equal(queued.projectId,result.projectId);assert.equal(queued.taskIds.length,1);
});

test('invalid inputs and unauthorized clients refuse before repository I/O',async t=>{
  const f=fixture(t);
  for(const key of ['',undefined,'short','invalid key','x'.repeat(129)])
    await assert.rejects(f.controller.createRepository(input,key),{code:'IDEMPOTENCY_REQUIRED'});
  for(const value of [{name:''},{name:'namespace/repo'},{name:'https://host/repo.git'},{...input,description:'x'.repeat(501)},{...input,visibility:'public'},{...input,remote:'https://elsewhere.invalid'}])
    await assert.rejects(f.controller.createRepository(value,'create-repo-02'),{status:400});
  for(const auth of [testAuthority('mock-workspace',AGENT_CLIENT),testReviewerAuthority()]){
    assert.throws(()=>authorizeRoute(auth.principal,'POST','/api/repositories'));
    await assert.rejects(new HostedController(f.store,f.artifacts,auth,f.runtime).createRepository(input,'create-repo-02'),{code:'OWNER_REQUIRED'});
  }
  assert.equal(f.calls.length,0);assert.equal(f.operation(),undefined);
});

test('an existing repository is never seeded, adopted or stripped of credentials',async t=>{
  const f=fixture(t);await f.artifacts.create(input.name,{description:'Existing private code',setDefaultBranch:'main',readOnly:false});f.calls.length=0;
  await assert.rejects(f.controller.createRepository(input,'create-repo-03'),{code:'REPOSITORY_NAME_TAKEN'});
  assert.equal(count(f,'create'),0);assert.equal(count(f,'seed'),0);assert.equal(count(f,'tokens'),0);
  assert.equal(f.repositories.get(input.name).tokens.get('initial').state,'active');assert.equal(f.operation().state,'failed');
});

for(const phase of ['create','push','token'])test(`lost ${phase} response retains its operation and resumes without duplicating the repository`,async t=>{
  const f=fixture(t);
  if(phase==='create')f.artifacts.afterCreate=async()=>{delete f.artifacts.afterCreate;throw Error(INITIAL);};
  if(phase==='push'){const seed=f.runtime.git.seedRepository;f.runtime.git.seedRepository=async options=>{f.runtime.git.seedRepository=seed;await seed(options);throw Error(WRITE);};}
  if(phase==='token')f.artifacts.afterCreate=async repo=>{const issue=repo.createToken.bind(repo);repo.createToken=async(...args)=>{repo.createToken=issue;await issue(...args);throw Error(WRITE);};};
  const error=await f.controller.createRepository(input,'create-repo-04').catch(error=>error);
  assert.equal(error.code,'REPOSITORY_CREATION_INTERRUPTED');assert.ok(!(await errorResponse(error).text()).includes('sensitive'));
  const attempt=f.operation();assert.equal(attempt.state,'pending');assert.equal(attempt.leaseUntil,0);
  assert.equal(Object.keys(f.store.read().workspace.projects).length,0);
  await assert.rejects(f.controller.createRepository({...input,description:'Different'},'create-repo-04'),{code:'IDEMPOTENCY_CONFLICT'});
  const result=await f.restart().createRepository(input,'create-repo-04');
  assert.equal(result.projectId,attempt.projectId);assert.equal(count(f,'create'),1);assert.equal(count(f,'seed'),1);
  assert.ok([...f.repositories.get(input.name).tokens.values()].every(token=>token.state==='revoked'));
});

test('credential cleanup failure prevents success and is retried without another seed',async t=>{
  const f=fixture(t);let block=false;
  f.artifacts.afterCreate=async repo=>{const revoke=repo.revokeToken.bind(repo);repo.revokeToken=async id=>{if(block)throw Error(INITIAL);return revoke(id);};};
  const seed=f.runtime.git.seedRepository;f.runtime.git.seedRepository=async options=>{const head=await seed(options);block=true;return head;};
  await assert.rejects(f.controller.createRepository(input,'create-repo-05'),{code:'REPOSITORY_CREATION_INTERRUPTED'});
  assert.equal(Object.keys(f.store.read().workspace.projects).length,0);assert.equal(f.operation().pendingCommit,HEAD);
  block=false;await f.restart().createRepository(input,'create-repo-05');assert.equal(count(f,'seed'),1);
});

test('a false revocation result cannot masquerade as completed cleanup',async t=>{
  const f=fixture(t);f.artifacts.afterCreate=async repo=>{repo.revokeToken=async()=>false;};
  await assert.rejects(f.controller.createRepository(input,'create-repo-06'),{code:'TOKEN_REVOCATION_UNCONFIRMED'});
  assert.equal(Object.keys(f.store.read().workspace.projects).length,0);assert.equal(f.operation().state,'pending');
});

test('a different main commit is retained and never overwritten on recovery',async t=>{
  const f=fixture(t);f.artifacts.afterCreate=async repo=>{repo.head='c'.repeat(40);};
  await assert.rejects(f.controller.createRepository(input,'create-repo-07'),{code:'REPOSITORY_SEED_CHANGED'});
  assert.equal(count(f,'seed'),0);assert.equal(count(f,'issue'),0);assert.equal(f.repositories.get(input.name).head,'c'.repeat(40));
  assert.equal(f.operation().state,'pending');
});

test('concurrent retries and independent requests cannot claim one repository name',async t=>{
  const f=fixture(t);let unblock,entered;const gate=new Promise(resolve=>{unblock=resolve;}),waiting=new Promise(resolve=>{entered=resolve;});
  f.artifacts.afterCreate=async()=>{entered();await gate;};
  const first=f.controller.createRepository(input,'create-repo-08');await waiting;
  await assert.rejects(f.restart().createRepository(input,'create-repo-08'),{code:'OPERATION_IN_PROGRESS'});
  await assert.rejects(f.restart().createRepository(input,'create-repo-09'),{code:'REPOSITORY_NAME_RESERVED'});
  unblock();await first;assert.equal(count(f,'create'),1);assert.equal(count(f,'seed'),1);
});

test('revoked sessions still clean initial credentials but cannot seed or attach a project',async t=>{
  const f=fixture(t);f.artifacts.afterCreate=async()=>{const snapshot=f.store.read();snapshot.workspace.sessionsValidAfter=testAuthority().principal.issuedAt;f.store.write({...snapshot,revision:snapshot.revision+1},snapshot.revision);};
  await assert.rejects(f.controller.createRepository(input,'create-repo-10'),{code:'SESSION_REVOKED'});
  assert.equal(count(f,'seed'),0);assert.equal(count(f,'issue'),0);assert.equal(f.repositories.get(input.name).tokens.get('initial').state,'revoked');
  assert.equal(Object.keys(f.store.read().workspace.projects).length,0);assert.equal(f.operation().state,'pending');
});

test('connect cannot bypass a partially created repository and its credential cleanup',async t=>{
  const f=fixture(t);f.artifacts.afterCreate=async()=>{throw Error('Lost create response');};
  await assert.rejects(f.controller.createRepository(input,'create-repo-11'));
  await assert.rejects(f.controller.createTasks({source:'repository',repo:input.name,projectName:input.name,baseCommit:HEAD,
    tasks:[{title:'Work',purpose:'Work',owner:'Owner',criteria:['Done']}]},'connect-repo-01'),{code:'REPOSITORY_CREATION_PENDING'});
  assert.equal(Object.keys(f.store.read().workspace.projects).length,0);
});

test('a lost subscription result replays the completed project without minting more tokens',async t=>{
  const f=fixture(t);f.runtime.ensureSubscription=async()=>{throw Error('Registration not confirmed');};
  await assert.rejects(f.controller.createRepository(input,'create-repo-12'));
  assert.equal(f.operation().state,'complete');assert.equal(Object.keys(f.store.read().workspace.projects).length,1);
  const before=f.calls.length;f.runtime.ensureSubscription=async()=>{};
  const result=await f.restart().createRepository(input,'create-repo-12');assert.equal(result.replayed,true);assert.equal(f.calls.length,before);
});
