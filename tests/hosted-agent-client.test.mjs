import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {HostedAgentClient,loadHostedConnection} from '../src/local/hosted-agent-client.mjs';

const project='10000000-0000-4000-8000-000000000001',task='10000000-0000-4000-8000-000000000002',run='10000000-0000-4000-8000-000000000003';
const requestId='10000000-0000-4000-8000-000000000004';
const configuration={format:'projects-git-hosted-connection/v1',origin:'https://workspace.example.test',workspaceId:'test-workspace',clientId:'a'.repeat(32)+'.access',clientSecret:'private-service-secret'};
const execute=promisify(execFile);
async function fixture(t){
 const root=await mkdtemp(path.join(tmpdir(),'projects-hosted-client-'));
 t.after(async()=>{assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir())+path.sep));await rm(root,{recursive:true,force:true});});
 const file=path.join(root,'connection.json');await writeFile(file,JSON.stringify(configuration),{mode:0o600});
 const connection=await loadHostedConnection(file);
 const principal={kind:'agent',id:configuration.clientId,workspaceId:configuration.workspaceId};
 const assignment={id:run,taskId:task,label:'Fixture',origin:'external-agent',status:'assigned',branch:'agents/'+'c'.repeat(32),baseCommit:'b'.repeat(40),repository:'https://git.example.test/fork.git',agentIdentity:principal};
 const state={id:configuration.workspaceId,version:1,authentication:{mode:'cloudflare-access',principal},projects:{[project]:{id:project,name:'Fixture'}},tasks:[{id:task,projectId:project}],runs:[assignment]};
 const credentials={token:'private-git-token',expiresAt:new Date(Date.now()+900000).toISOString(),remote:assignment.repository,branch:assignment.branch,baseCommit:assignment.baseCommit};
 const requests=[];let issued=false,drop=false,dropSubmit=false;
 const fetchImpl=async(url,options)=>{
   assert.equal(url.origin,configuration.origin);assert.equal(options.redirect,'manual');
   assert.equal(options.headers['CF-Access-Client-Secret'],configuration.clientSecret);
   requests.push({path:url.pathname,method:options.method,body:options.body,key:options.headers['Idempotency-Key']});
   if(options.method==='GET')return Response.json(structuredClone(state));
   if(url.pathname.endsWith('/claim')){
     const replayed=issued;issued=true;
     if(drop){drop=false;throw Error('connection lost after reservation '+configuration.clientSecret);}
     return Response.json({runId:run,taskId:task,projectId:project,workspace:structuredClone(state),credentials:replayed?null:credentials,replayed});
   }
   if(url.pathname.endsWith('/fail'))assignment.status='failed';
   if(url.pathname.endsWith('/start'))assignment.status='running';
   if(url.pathname.endsWith('/submit')){assignment.status='awaiting_review';assignment.headCommit=JSON.parse(options.body).headCommit;assignment.summary=JSON.parse(options.body).summary.trim();if(dropSubmit){dropSubmit=false;throw Error('Lost response after successful submit');}}
   return Response.json(structuredClone(state));
 };
 const client=new HostedAgentClient(connection,{fetchImpl});
 return {root,file,connection,client,state,assignment,credentials,requests,fetchImpl,dropNextClaim:()=>drop=true,dropNextSubmit:()=>dropSubmit=true};
}

async function resolutionFixture(t){
 const f=await fixture(t);
 Object.assign(f.assignment,{branch:'updates/'+'d'.repeat(32),reconcilesRunId:crypto.randomUUID(),assignedRevision:2});
 Object.assign(f.state.tasks[0],{revision:2,baseCommit:f.assignment.baseCommit});
 f.credentials.branch=f.assignment.branch;
 const input={mode:'resolve',runId:run,taskId:task,projectId:project,credentials:f.credentials,workspace:{id:'untrusted-file-snapshot'}};
 const assignmentFile=path.join(f.root,'resolution.json');
 const save=async()=>writeFile(assignmentFile,JSON.stringify(input),{mode:0o600});await save();
 return {...f,input,assignmentFile,save};
}

test('resolution checkout retains a bound credential when an existing directory prevents cloning',async t=>{
 const f=await resolutionFixture(t),key=crypto.randomUUID();
 await assert.rejects(f.client.checkout(run,f.root,key,f.assignmentFile),/EEXIST/);
 assert.ok(f.requests.every(r=>r.method==='GET'));
 const filename=path.join(f.connection.stateDirectory,'runs',run+'.json'),saved=JSON.parse(await readFile(filename));
 assert.equal(saved.credentials.token,f.credentials.token);assert.equal(saved.credentials.branch,f.assignment.branch);
 saved.directory=path.join(f.root,'existing-checkout');await writeFile(filename,JSON.stringify(saved));
 await assert.rejects(new HostedAgentClient(f.connection,{fetchImpl:f.fetchImpl}).checkout(run,f.root,key,f.assignmentFile),/EEXIST/);
 assert.deepEqual(JSON.parse(await readFile(filename)),saved);
 const receipt=await f.client.receipt(key);assert.equal(receipt.attempts.length,2);
 for(const secret of [configuration.clientSecret,f.credentials.token])assert.ok(!JSON.stringify(receipt).includes(secret));
 f.credentials.token='different-credential';await f.save();
 await assert.rejects(f.client.checkout(run,f.root,key,f.assignmentFile),/conflicts/);
 await assert.rejects(f.client.checkout(run,f.root,crypto.randomUUID(),f.assignmentFile),/different retained credential/);
 assert.deepEqual(JSON.parse(await readFile(filename)),saved);
 await f.client.mutate('start',run,{},crypto.randomUUID());
 await f.client.mutate('submit',run,{headCommit:'e'.repeat(40),summary:'Resolved'},crypto.randomUUID());
 await assert.rejects(readFile(filename),{code:'ENOENT'});
});

test('resolution checkout refuses foreign, stale, closed or mismatched assignments before saving a credential',async t=>{
 const changes=[
  f=>f.state.id='foreign',f=>f.assignment.agentIdentity={...f.assignment.agentIdentity,id:'foreign.access'},
  f=>f.state.authentication.principal.kind='owner',f=>f.input.mode='reapply',f=>f.input.runId=crypto.randomUUID(),
  f=>f.input.taskId=crypto.randomUUID(),f=>f.input.projectId=crypto.randomUUID(),f=>f.assignment.status='superseded',
  f=>f.state.tasks[0].revision++,f=>f.state.tasks[0].baseCommit='e'.repeat(40),f=>delete f.assignment.reconcilesRunId,
  f=>f.credentials.baseCommit='e'.repeat(40),f=>f.credentials.remote='https://unrelated.example/fork.git',
  f=>f.credentials.branch='updates/'+'e'.repeat(32),f=>f.credentials.expiresAt='not-a-time',
  f=>f.credentials.expiresAt=new Date(Date.now()-1000).toISOString(),f=>f.input.credentials=null,
  ...['main','agents/'+'d'.repeat(32),'updates/../main','updates/'+'d'.repeat(32)+'/extra'].map(branch=>f=>{f.assignment.branch=branch;f.credentials.branch=branch;})
 ];
 for(const change of changes){const f=await resolutionFixture(t);change(f);await f.save();
  await assert.rejects(f.client.checkout(run,path.join(f.root,'checkout'),crypto.randomUUID(),f.assignmentFile));
  assert.ok(f.requests.every(r=>r.method==='GET'));await assert.rejects(readFile(path.join(f.connection.stateDirectory,'runs',run+'.json')),{code:'ENOENT'});
 }
});

test('resolution checkout requires a bounded private file outside Git',async t=>{
 const f=await resolutionFixture(t);
 const checkout=(file)=>f.client.checkout(run,path.join(f.root,'checkout'),crypto.randomUUID(),file);
 await assert.rejects(checkout('resolution.json'),/absolute private/);
 await writeFile(f.assignmentFile,Buffer.from([123,0xff,125]));await assert.rejects(checkout(f.assignmentFile),/UTF-8/);
 await writeFile(f.assignmentFile,' '.repeat(4*1024*1024+1));await assert.rejects(checkout(f.assignmentFile),/exceeds/);
 await f.save();await mkdir(path.join(f.root,'.git'));await assert.rejects(checkout(f.assignmentFile),/outside Git/);
 assert.equal(f.requests.length,0);
});

test('real CLI parses the resolution checkout option and rejects mismatched input without exposing secrets',async t=>{
 const f=await resolutionFixture(t),loader=path.join(f.root,'read-only-api-loader.mjs');
 f.input.mode='reapply';await f.save();
 await writeFile(loader,`const state=${JSON.stringify(f.state)};globalThis.fetch=async(url,options)=>{if(url.origin!==${JSON.stringify(configuration.origin)}||options.method!=='GET')throw Error('Unexpected mutation or origin');return Response.json(state);};`);
 await assert.rejects(execute(process.execPath,['--import',pathToFileURL(loader).href,path.resolve('scripts/repository-work.mjs'),'checkout','--connection',f.file,'--run',run,'--directory',path.join(f.root,'checkout'),'--assignment',f.assignmentFile,'--request-id',crypto.randomUUID()],{windowsHide:true}),error=>{assert.match(error.stderr,/Resolution file/);for(const secret of [configuration.clientSecret,f.credentials.token])assert.ok(!error.stdout.includes(secret)&&!error.stderr.includes(secret));return true;});
 const help=await execute(process.execPath,[path.resolve('scripts/repository-work.mjs'),'checkout','--help']);assert.match(help.stdout,/--assignment/);
 const submitHelp=await execute(process.execPath,[path.resolve('scripts/repository-work.mjs'),'submit','--help']);assert.match(submitHelp.stdout,/--directory/);
 await assert.rejects(execute(process.execPath,[path.resolve('scripts/repository-work.mjs'),'adopt','--help']),error=>/Unknown command/.test(error.stderr));
});

test('connection configuration refuses unsafe origins, unknown fields, malformed UTF-8 and repository storage',async t=>{
 const f=await fixture(t);
 for(const patch of [{origin:'http://example.test'},{origin:'https://user:secret@example.test'},{origin:'https://example.test/path'},{origin:'https://example.test/'},{unexpected:true},{clientSecret:'x\r\ny'}]){
   await writeFile(f.file,JSON.stringify({...configuration,...patch}));await assert.rejects(loadHostedConnection(f.file));
 }
 await writeFile(f.file,Buffer.from([123,0xff,125]));await assert.rejects(loadHostedConnection(f.file),/UTF-8/);
 await writeFile(f.file,JSON.stringify(configuration));await mkdir(path.join(f.root,'.git'));
 await assert.rejects(loadHostedConnection(f.file),/outside Git/);
});

test('wrong workspace, foreign principal and owner sessions stop before any POST',async t=>{
 const f=await fixture(t);
 for(const change of [()=>f.state.id='foreign',()=>{f.state.id=configuration.workspaceId;f.state.authentication.principal={kind:'owner',id:configuration.clientId,workspaceId:configuration.workspaceId};},()=>{f.state.authentication.principal={kind:'agent',id:'foreign.access',workspaceId:configuration.workspaceId};}]){
   change();await assert.rejects(f.client.claim(project,'Builder',requestId),/identity/);
 }
 assert.equal(f.requests.filter(r=>r.method==='POST').length,0);
});

test('claim privately retains issued-once Git credentials and immutable principal-bound request inputs',async t=>{
 const f=await fixture(t);
 const first=await f.client.claim(project,'Builder',requestId);
 assert.equal(first.credentialStatus,'saved-privately');assert.ok(!JSON.stringify(first).includes(f.credentials.token));
 const second=await f.client.claim(project,'Builder',requestId);assert.equal(second.replayed,true);assert.equal(second.credentialStatus,'saved-privately');
 const before=f.requests.filter(r=>r.method==='POST').length;
 await assert.rejects(f.client.claim(project,'Changed',requestId),/conflicts/);
 assert.equal(f.requests.filter(r=>r.method==='POST').length,before);
 const receipt=await f.client.receipt(requestId);assert.equal(receipt.attempts.length,2);
 assert.ok(!JSON.stringify(receipt).includes(f.credentials.token));assert.ok(!JSON.stringify(receipt).includes(configuration.clientSecret));
 const saved=JSON.parse(await readFile(path.join(f.connection.stateDirectory,'runs',run+'.json'),'utf8'));
 assert.equal(saved.credentials.token,f.credentials.token);assert.equal(saved.scope.clientId,configuration.clientId);
 if(process.platform!=='win32')assert.equal((await stat(path.join(f.connection.stateDirectory,'runs',run+'.json'))).mode&0o077,0);
 assert.equal(JSON.parse(f.requests.find(r=>r.method==='POST').body).label,'Builder');
 assert.ok(!f.requests.find(r=>r.method==='POST').body.includes('clientId'));
});

test('lost claim response retains an unknown attempt; explicit same-key replay never fabricates a credential',async t=>{
 const f=await fixture(t);f.dropNextClaim();
 await assert.rejects(f.client.claim(project,'Builder',requestId),error=>!error.message.includes(configuration.clientSecret)&&/receipt/.test(error.message));
 assert.equal(f.requests.filter(r=>r.method==='POST').length,1);
 let receipt=await f.client.receipt(requestId);assert.equal(receipt.attempts[0].state,'outcome-unknown');
 const recovered=await f.client.claim(project,'Builder',requestId);assert.equal(recovered.runId,run);assert.equal(recovered.credentialStatus,'unavailable');
 receipt=await f.client.receipt(requestId);assert.equal(receipt.attempts.length,2);assert.ok(receipt.attempts.some(a=>a.state==='outcome-unknown'));
 assert.equal(f.requests.filter(r=>r.method==='POST').length,2);
});

test('separate service clients cannot read each other\'s request receipts',async t=>{
 const f=await fixture(t);await f.client.claim(project,'Builder',requestId);
 await writeFile(f.file,JSON.stringify({...configuration,clientId:'b'.repeat(32)+'.access'}));
 const other=await loadHostedConnection(f.file);assert.notEqual(other.stateDirectory,f.connection.stateDirectory);
 await assert.rejects(new HostedAgentClient(other,{fetchImpl:f.fetchImpl}).receipt(requestId),{code:'ENOENT'});
});

test('foreign assignment mutation is refused and successful closure removes its temporary credential',async t=>{
 const f=await fixture(t);await f.client.claim(project,'Builder',requestId);
 f.assignment.agentIdentity={...f.assignment.agentIdentity,id:'foreign.access'};
 const before=f.requests.filter(r=>r.method==='POST').length;
 await assert.rejects(f.client.mutate('fail',run,{message:'Stop'},crypto.randomUUID()),/does not belong/);
 assert.equal(f.requests.filter(r=>r.method==='POST').length,before);
 f.assignment.agentIdentity=f.state.authentication.principal;
 const result=await f.client.mutate('fail',run,{message:'Stop'},crypto.randomUUID());assert.equal(result.status,'failed');
 await assert.rejects(readFile(path.join(f.connection.stateDirectory,'runs',run+'.json')),{code:'ENOENT'});
});

test('redirects, non-JSON errors and credential-bearing server messages do not leak credentials',async t=>{
 const f=await fixture(t);
 for(const response of [new Response('',{status:302,headers:{Location:'https://foreign.test'}}),new Response(configuration.clientSecret,{status:403}),Response.json({code:'FORBIDDEN',error:configuration.clientSecret},{status:403})]){
  let calls=0;const client=new HostedAgentClient(f.connection,{fetchImpl:async()=>{calls++;return response;}});
  await assert.rejects(client.workspace(),error=>!error.message.includes(configuration.clientSecret));assert.equal(calls,1);
 }
});

test('expired Git credentials cannot start a checkout or a push',async t=>{
 const f=await fixture(t);await f.client.claim(project,'Builder',requestId);
 const client=new HostedAgentClient(f.connection,{fetchImpl:f.fetchImpl,now:()=>Date.now()+1000000});
 await assert.rejects(client.checkout(run,path.join(f.root,'new-checkout'),crypto.randomUUID()),/expired/);
 await assert.rejects(stat(path.join(f.root,'new-checkout')),{code:'ENOENT'});
});

test('lost successful submit reconciles the exact terminal head after restart without another POST and removes the secret',async t=>{
 const f=await fixture(t);await f.client.claim(project,'Builder',requestId);await f.client.mutate('start',run,{},crypto.randomUUID());
 const key=crypto.randomUUID(),body={headCommit:'d'.repeat(40),summary:'Submitted result'};
 f.dropNextSubmit();await assert.rejects(f.client.mutate('submit',run,body,key),/receipt/);
 assert.equal(f.assignment.status,'awaiting_review');assert.ok(await stat(path.join(f.connection.stateDirectory,'runs',run+'.json')));
 const restarted=new HostedAgentClient(f.connection,{fetchImpl:f.fetchImpl});
 const result=await restarted.mutate('submit',run,body,key);assert.equal(result.reconciled,true);assert.equal(result.remoteMutation,false);
 assert.equal(f.requests.filter(r=>r.path.endsWith('/submit')).length,1);
 await assert.rejects(readFile(path.join(f.connection.stateDirectory,'runs',run+'.json')),{code:'ENOENT'});
 const receipt=await restarted.receipt(key);assert.equal(receipt.attempts.length,2);assert.ok(receipt.attempts.some(a=>a.state==='outcome-unknown'));
});

test('a local cleanup failure can be reconciled without repeating the completed submit',async t=>{
 const f=await fixture(t);await f.client.claim(project,'Builder',requestId);await f.client.mutate('start',run,{},crypto.randomUUID());
 const key=crypto.randomUUID(),body={headCommit:'d'.repeat(40),summary:'Submitted result'},retire=f.client.retireCredential.bind(f.client);
 f.client.retireCredential=async()=>{throw Error('Simulated local permission failure');};
 await assert.rejects(f.client.mutate('submit',run,body,key),/permission failure/);
 f.client.retireCredential=retire;
 const result=await f.client.mutate('submit',run,body,key);assert.equal(result.reconciled,true);
 assert.equal(f.requests.filter(r=>r.path.endsWith('/submit')).length,1);
 await assert.rejects(readFile(path.join(f.connection.stateDirectory,'runs',run+'.json')),{code:'ENOENT'});
});

test('a different terminal head is never relabeled as the requested submission',async t=>{
 const f=await fixture(t);await f.client.claim(project,'Builder',requestId);await f.client.mutate('start',run,{},crypto.randomUUID());
 const key=crypto.randomUUID(),body={headCommit:'d'.repeat(40),summary:'Submitted result'},retire=f.client.retireCredential.bind(f.client);
 f.client.retireCredential=async()=>{throw Error('Simulated local permission failure');};
 await assert.rejects(f.client.mutate('submit',run,body,key),/permission failure/);
 f.client.retireCredential=retire;
 f.assignment.headCommit='e'.repeat(40);
 await assert.rejects(f.client.mutate('submit',run,body,key),/different retained outcome/);
 assert.equal(f.requests.filter(r=>r.path.endsWith('/submit')).length,1);
 await assert.rejects(readFile(path.join(f.connection.stateDirectory,'runs',run+'.json')),{code:'ENOENT'});
 const receipt=await f.client.receipt(key);assert.ok(receipt.attempts.every(a=>a.state==='outcome-unknown'));
});

test('submit summary accepts the hosted 2000-character boundary and rejects 2001 before POST or a receipt',async t=>{
 const f=await fixture(t);await f.client.claim(project,'Builder',requestId);await f.client.mutate('start',run,{},crypto.randomUUID());
 const key=crypto.randomUUID(),before=f.requests.filter(r=>r.method==='POST').length;
 await assert.rejects(f.client.mutate('submit',run,{headCommit:'d'.repeat(40),summary:'a'.repeat(2001)},key),/Summary/);
 assert.equal(f.requests.filter(r=>r.method==='POST').length,before);
 await assert.rejects(f.client.receipt(key),{code:'ENOENT'});
 const result=await f.client.mutate('submit',run,{headCommit:'d'.repeat(40),summary:'a'.repeat(2000)},key);
 assert.equal(result.status,'awaiting_review');
});

test('CLI refuses hosted owner operations before reading credentials and documents the explicit modes',async()=>{
 const script=path.resolve('scripts/repository-work.mjs');
 await assert.rejects(execute(process.execPath,[script,'admission','--connection','not-a-file']),error=>/not available to hosted agents/.test(error.stderr));
 const help=await execute(process.execPath,[script,'checkout','--help']);assert.match(help.stdout,/--connection/);assert.match(help.stdout,/No mutation is retried automatically/);
});

test('real CLI process uses hosted mode and never prints its issued Git credential',async t=>{
 const f=await fixture(t),loader=path.join(f.root,'inert-api-loader.mjs');
 Object.assign(f.state,{provider:'cloudflare-artifacts',coordination:{[run]:{acceptance:[],overlaps:[]}}});
 Object.assign(f.state.tasks[0],{revision:1,ownerVersion:1,criteria:[],title:'Fixture',status:'running',baseCommit:f.assignment.baseCommit});
 Object.assign(f.assignment,{agent:'external',assignedRevision:1,changedFiles:[],evidence:null});
 await writeFile(loader,`const state=${JSON.stringify(f.state)}; const credentials=${JSON.stringify(f.credentials)};
 globalThis.fetch=async(url,options)=>{if(url.origin!==${JSON.stringify(configuration.origin)})throw Error('Unexpected origin');
 if(options.headers['CF-Access-Client-Secret']!==${JSON.stringify(configuration.clientSecret)})throw Error('Missing credential');
 return Response.json(options.method==='POST'?{runId:${JSON.stringify(run)},taskId:${JSON.stringify(task)},projectId:${JSON.stringify(project)},workspace:state,credentials}:state);};`);
 const result=await execute(process.execPath,['--import',pathToFileURL(loader).href,path.resolve('scripts/repository-work.mjs'),'claim','--connection',f.file,'--project',project,'--label','CLI fixture','--request-id',requestId],{windowsHide:true});
 const data=JSON.parse(result.stdout);assert.equal(data.runId,run);assert.equal(data.credentialStatus,'saved-privately');
 assert.equal(data.candidate.status,'assigned');
 for(const secret of [configuration.clientSecret,f.credentials.token])assert.ok(!result.stdout.includes(secret)&&!result.stderr.includes(secret));
 assert.ok(data.browserUrl.startsWith(configuration.origin));
});
