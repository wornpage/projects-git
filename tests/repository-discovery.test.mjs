import test from 'node:test';
import assert from 'node:assert/strict';
import {HostedController} from '../src/cloudflare/controller.ts';
import {WorkspaceStore} from '../src/cloudflare/workspace-store.ts';
import {sqliteStorage} from './helpers/sqlite-store.mjs';
import {testAuthority,testReviewerAuthority,AGENT_CLIENT} from './helpers/hosted-authority.mjs';
import {authorizeRoute} from '../src/cloudflare/access.ts';

function fixture(t) {
  const {db,storage}=sqliteStorage();t.after(()=>db.close());
  const store=new WorkspaceStore(storage,'mock-workspace'),calls=[];
  const info={name:'customer-portal',defaultBranch:'release/next',remote:'https://secret.invalid/never-return',token:'never-return',readOnly:false};
  const repo={info:async()=>{calls.push('info');return info;},log:async options=>{calls.push(['log',options]);return[{hash:'a'.repeat(40)}];},
    [Symbol.dispose](){calls.push('dispose');},createToken(){throw Error('No credentials may be issued');},fork(){throw Error('No fork may be created');}};
  const artifacts={list:async options=>{calls.push(['list',options]);return{repos:[info],total:2,cursor:'next-page'};},get:async name=>{calls.push(['get',name]);return repo;},create(){throw Error('No creation');}};
  const owner=new HostedController(store,artifacts,testAuthority());
  return {store,calls,info,repo,artifacts,owner};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('repository catalog is paginated, keeps the provider denominator and strips all extra metadata',async t=>{
  const f=fixture(t),before=f.store.read();
  const first=await f.owner.repositoryCatalog('');
  assert.deepEqual(first,{workspaceId:'mock-workspace',repositories:[{name:'customer-portal'}],total:2,nextCursor:'next-page'});
  assert.deepEqual(f.calls,[['list',{limit:20}]]);
  f.artifacts.list=async options=>{assert.deepEqual(options,{limit:20,cursor:'next-page'});return{repos:[{...f.info,name:'last-repo'}],total:2};};
  assert.equal((await f.owner.repositoryCatalog('?cursor=next-page')).nextCursor,null);
  assert.deepEqual(f.store.read(),before);
});

test('agents and reviewers are denied at route and resource boundaries before Artifacts I/O',async t=>{
  const f=fixture(t),before=f.store.read();
  for(const auth of [testAuthority('mock-workspace',AGENT_CLIENT),testReviewerAuthority()]){
    const client=new HostedController(f.store,f.artifacts,auth);
    for(const path of ['/api/repositories','/api/repositories/head'])assert.throws(()=>authorizeRoute(auth.principal,'GET',path));
    await assert.rejects(client.repositoryCatalog(''),{code:'OWNER_REQUIRED'});
    await assert.rejects(client.repositoryHead('?name=customer-portal'),{code:'OWNER_REQUIRED'});
  }
  assert.deepEqual(f.calls,[]);assert.deepEqual(f.store.read(),before);
  assert.throws(()=>new HostedController(f.store,f.artifacts,testAuthority('other-workspace')));
});

test('unknown, duplicated, oversized and cross-namespace parameters refuse before provider reads',async t=>{
  const f=fixture(t);
  for(const search of ['?namespace=foreign','?cursor=one&cursor=two','?cursor=','?cursor='+('x'.repeat(2049)),'?limit=200'])await assert.rejects(f.owner.repositoryCatalog(search),{status:400});
  for(const search of ['','?name=one&name=two','?name=namespace/repo','?name=https://example.test/repo','?name=repo&namespace=foreign'])await assert.rejects(f.owner.repositoryHead(search),{status:400});
  assert.deepEqual(f.calls,[]);
});

test('a repository selection reads the fresh default-branch head and disposes the handle without writes',async t=>{
  const f=fixture(t),before=f.store.read();
  assert.deepEqual(await f.owner.repositoryHead('?name=customer-portal'),{workspaceId:'mock-workspace',name:'customer-portal',defaultBranch:'release/next',baseCommit:'a'.repeat(40)});
  assert.deepEqual(f.calls,[['get','customer-portal'],'info',['log',{ref:'release/next',limit:1}],'dispose']);
  f.repo.log=async()=>[{hash:'b'.repeat(40)}];assert.equal((await f.owner.repositoryHead('?name=customer-portal')).baseCommit,'b'.repeat(40));
  assert.deepEqual(f.store.read(),before);
});

test('an empty default branch has no selectable commit',async t=>{
  const f=fixture(t);f.repo.log=async()=>[];
  assert.equal((await f.owner.repositoryHead('?name=customer-portal')).baseCommit,null);
  f.repo.log=async()=>{throw Object.assign(Error('Missing ref'),{code:'NOT_FOUND'});};
  assert.equal((await f.owner.repositoryHead('?name=customer-portal')).baseCommit,null);
});

test('creation rechecks the selected base and refuses a changed branch without saving tasks',async t=>{
  const f=fixture(t),selected=await f.owner.repositoryHead('?name=customer-portal'),before=f.store.read();
  f.repo.readCommit=async hash=>({hash,tree:'c'.repeat(40),parents:[]});f.repo.log=async()=>[{hash:'b'.repeat(40)}];
  await assert.rejects(f.owner.createTasks({source:'repository',repo:selected.name,baseCommit:selected.baseCommit,projectName:'Selected repository',
    tasks:[{title:'Agreed task',purpose:'Use the current committed code',criteria:['Observable result'],owner:'Owner'}]},crypto.randomUUID()),{code:'STALE_HEAD'});
  assert.deepEqual(f.store.read(),before);
});

test('provider failures are explicit and never disclose upstream secrets',async t=>{
  const f=fixture(t);
  for(const [code,expected] of [['NOT_FOUND','REPOSITORY_NOT_FOUND'],['IMPORT_IN_PROGRESS','REPOSITORY_NOT_READY'],['INTERNAL_ERROR','REPOSITORY_READ_FAILED']]){
    f.artifacts.get=async()=>{throw Object.assign(Error('secret upstream token'),{code});};
    await assert.rejects(f.owner.repositoryHead('?name=customer-portal'),error=>error.code===expected&&!error.message.includes('secret'));
  }
});

test('malformed catalog/head data and mismatched repository identity fail closed',async t=>{
  const f=fixture(t);
  for(const page of [{repos:[],total:-1},{repos:Array.from({length:21},(_,i)=>({name:'repo-'+i})),total:21},{repos:[f.info,f.info],total:2},{repos:[{name:'other/namespace'}],total:1},{repos:[],total:0,cursor:'x'.repeat(2049)}]){
    f.artifacts.list=async()=>page;await assert.rejects(f.owner.repositoryCatalog(''),{code:'INVALID_REPOSITORY_RESPONSE'});
  }
  f.info.name='foreign';await assert.rejects(f.owner.repositoryHead('?name=customer-portal'),{code:'INVALID_REPOSITORY_RESPONSE'});f.info.name='customer-portal';
  for(const history of [[{hash:'not-a-commit'}],[{}],[null]]){
    f.repo.log=async()=>history;await assert.rejects(f.owner.repositoryHead('?name=customer-portal'),{code:'INVALID_REPOSITORY_RESPONSE'});
  }
});

test('session revocation during catalog I/O prevents returning the results',async t=>{
  const f=fixture(t);let resolve;
  f.artifacts.list=()=>new Promise(done=>{resolve=done;});
  const pending=f.owner.repositoryCatalog('');
  const snapshot=f.store.read(),prior=snapshot.revision;snapshot.workspace.sessionsValidAfter=testAuthority().principal.issuedAt+1;snapshot.revision++;
  f.store.write(snapshot,prior);const revoked=f.store.read();
  resolve({repos:[f.info],total:1});await assert.rejects(pending,{status:401});
  assert.deepEqual(f.store.read(),revoked);
});

test('a timed-out read disposes a late handle without starting further provider calls',async t=>{
  const f=fixture(t);let resolve;
  f.artifacts.get=()=>new Promise(done=>{resolve=done;});
  t.mock.timers.enable({apis:['setTimeout']});
  const pending=f.owner.repositoryHead('?name=customer-portal');t.mock.timers.tick(10000);
  await assert.rejects(pending,{code:'REPOSITORY_READ_TIMEOUT'});
  resolve(f.repo);await settle();assert.deepEqual(f.calls,['dispose']);
});
