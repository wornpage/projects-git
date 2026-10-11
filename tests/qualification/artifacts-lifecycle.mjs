import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,rename,realpath,copyFile} from 'node:fs/promises';
import {resolve,join,sep} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {AccessVerifier} from '../../src/cloudflare/access.ts';
import {digest,requirementsDigest} from '../../src/core/check-definition.mjs';
import {writeProjectBundle,restoreProjectBundle} from '../../src/local/project-bundle.mjs';
import {RepositoryRunner} from '../../src/local/repository-runner.mjs';
import {git} from './git.mjs';

const setupPath=process.env.PROJECTS_LIFECYCLE_SETUP;
if(!setupPath)throw Error('Set PROJECTS_LIFECYCLE_SETUP to the explicit private setup file.');
const setup=JSON.parse(await readFile(setupPath,'utf8')),stage=process.argv[2];
assert.ok(['initial','restore','reconcile-restore','continue','cleanup'].includes(stage),'Choose an explicit lifecycle stage.');
const restorationReceipt=setup.restorationReceipt??'restore';
assert.ok(['restore','reconcile-restore'].includes(restorationReceipt),'Select an explicit restoration receipt.');
const source={commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim(),tree:execFileSync('git',['rev-parse','HEAD^{tree}'],{encoding:'utf8',windowsHide:true}).trim()};
assert.equal(execFileSync('git',['status','--porcelain'],{encoding:'utf8',windowsHide:true}).trim(),'','Commit the exact qualification source first.');
assert.equal(source.commit,setup.sourceCommit);assert.equal(new URL(setup.driverOrigin).hostname,'127.0.0.1');
const dir=resolve(setup.evidenceDirectory),privateDir=resolve(setup.credentialDirectory);await mkdir(dir,{recursive:true});
const actors=JSON.parse(await readFile(join(privateDir,'sessions.json'),'utf8'));
const key=(await readFile(setup.driverKeyFile,'utf8')).match(/^HARNESS_KEY=([a-f0-9]{64})\s*$/)?.[1];assert.ok(key);
const secrets=new Set([key,...Object.values(actors).map(actor=>actor.token)]);
const remember=credential=>{if(credential?.token){secrets.add(credential.token);secrets.add(credential.token.split('?')[0]);}return credential;};
const sanitize=text=>{for(const secret of secrets)if(secret)text=text.replaceAll(secret,'[redacted]');return text.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,'[redacted-jwt]');};
const verifier=new AccessVerifier();
for(const [role,actor] of Object.entries(actors)){
 const principal=await verifier.authenticate(new Request('https://qualification.invalid',{headers:{'Cf-Access-Jwt-Assertion':actor.token}}),
  {issuer:setup.issuer,audience:setup.audience,ownerSubject:setup.ownerSubject,workspaceId:setup.workspace,agentClientIds:setup.agentClientIds,reviewerClientIds:setup.reviewerClientIds,reviewerSubjects:[]});
 assert.equal(principal.kind,role==='builder'?'agent':role);actor.principal=principal;
}
const receipt={format:'artifacts-lifecycle-proof/v1',stage,source,startedAt:new Date().toISOString(),status:'reserved',
 scope:'Real Access, private Workers/SQLite, Artifacts and bounded containers. Scripted builders, assessments and owner decisions; zero model requests.',
 principals:Object.fromEntries(Object.entries(actors).map(([role,actor])=>[role,actor.principal])),cases:[],requests:[],steps:[],containerCommands:0};
const receiptPath=join(dir,stage+'.json');await writeFile(receiptPath,JSON.stringify(receipt,null,2),{flag:'wx'});
let priorCommands=0;
const dependencies={initial:[],restore:['initial'],'reconcile-restore':['initial'],continue:['initial',restorationReceipt],cleanup:['initial',restorationReceipt,'continue']};
receipt.priorReceipts={};
for(const prior of dependencies[stage]) {
 const bytes=await readFile(join(dir,prior+'.json'),'utf8'),previous=JSON.parse(bytes);assert.equal(previous.status,'passed');priorCommands+=previous.containerCommands;
 receipt.priorReceipts[prior]=digest(bytes);
}
const save=()=>writeFile(receiptPath,sanitize(JSON.stringify(receipt,null,2)));
const passed=(name,proof={})=>{receipt.cases.push({name,status:'passed',...proof});console.log('PASS '+name);};
const control=async(path,body={})=>{
 const response=await fetch(setup.driverOrigin+path,{method:'POST',headers:{'X-Qualification-Key':key,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(145000)});
 const value=await response.json();remember(value);if(!response.ok)throw Error('Private control '+path+' refused: '+response.status);return value;
};
async function request(role,path,body,workspace='primary',requestKey=randomUUID(),expected=200){
 const headers={'Cf-Access-Jwt-Assertion':actors[role].token,'Content-Type':'application/json','Idempotency-Key':requestKey};
 const start=Date.now();
 const attempt={role,workspace,path,key:requestKey,status:'reserved',bodySha256:body===undefined?null:digest(JSON.stringify(body))};receipt.requests.push(attempt);await save();
 const response=await fetch(setup.driverOrigin+'/direct',{method:'POST',headers:{'X-Qualification-Key':key,'Content-Type':'application/json'},
  body:JSON.stringify({workspace,path,method:body===undefined?'GET':'POST',headers,body}),signal:AbortSignal.timeout(145000)});
 const value=await response.json();remember(value.credentials);Object.assign(attempt,{status:response.status,code:value.code,elapsedMs:Date.now()-start});await save();
 assert.equal(response.status,expected,sanitize(path+': '+JSON.stringify(value)));return value;
}
const state=workspace=>request('owner','/api/workspace',undefined,workspace);
async function once(name,operation){
 assert.ok(!receipt.steps.some(step=>step.name===name),'Do not repeat a reserved mutation.');
 const step={name,status:'reserved',at:new Date().toISOString()};receipt.steps.push(step);await save();
 const value=await operation();step.status='confirmed';await save();return value;
}
function credential(value){remember(value);const url=new URL(value.remote);assert.equal(url.protocol,'https:');assert.equal(url.hostname,setup.account+'.artifacts.cloudflare.net');
 assert.ok(url.pathname.startsWith('/git/'+setup.namespace+'/'));assert.ok(!url.username&&!url.password&&!url.search&&!url.hash);return value;}
async function pushFresh(directory,credentials,refs){
 credentials=credential(credentials);
 await git(['push',...refs.map(ref=>'--force-with-lease='+ref+':'),credentials.remote,...refs.map(ref=>ref+':'+ref)],directory,credentials);
}
async function commit(directory,message){await git(['add','README.md','reports.py'],directory);await git(['-c','user.name=Projects lifecycle fixture','-c','user.email=lifecycle@example.invalid','commit','-m',message],directory);return git(['rev-parse','HEAD'],directory);}
const contract='from reports import summarize_checks as f\nr=f([{ "name":"pass", "passed":2,"total":2},{"name":"fail","passed":0,"total":3},{"name":"zero","passed":0,"total":0}])\nassert r=={"passed":2,"total":5,"reports":3,"failed_reports":1},r\nprint("contract verified")';
const boundaries='from reports import summarize_checks as f\nfrom copy import deepcopy\na=[{"name":"large","passed":10**50,"total":10**50}]\nb=deepcopy(a)\nassert f(a)["passed"]==10**50 and a==b\nfor bad in [None,{},[{}],[{"name":"x","passed":True,"total":1}],[{"name":"x","passed":2,"total":1}]]:\n try: f(bad)\n except ValueError: continue\n raise AssertionError("invalid input accepted")\nprint("boundaries verified")';
async function check(runId,workspace,commands){
 const w=await state(workspace),run=w.runs.find(r=>r.id===runId),task=w.tasks.find(t=>t.id===run.taskId);
 const definition=JSON.stringify({format:'repository-command-checks/v1',commit:run.headCommit,taskRevision:task.revision,requirementsSha256:requirementsDigest(task),timeoutMs:60000,
  checks:commands.map(([name,code,stdout])=>({name,argv:['python3','-c',code],stdin:'',expected:{exitCode:0,stdout}}))});
 receipt.containerCommands+=commands.length;assert.ok(priorCommands+receipt.containerCommands<=setup.budget.containerCommands);await save();
 return request('owner',`/api/runs/${runId}/checks`,{definition,definitionSha256:digest(definition)},workspace);
}
async function reviewMerge(runId,workspace,checkCount){
 let w=await state(workspace),run=w.runs.find(r=>r.id===runId),task=w.tasks.find(t=>t.id===run.taskId);
 const context=await request('owner',`/api/runs/${runId}/review-context`,undefined,workspace);
 await request('owner',`/api/runs/${runId}/review-assignments`,{contextId:context.contextId,expectedVersion:w.version,reviewerIds:setup.reviewerClientIds},workspace);
 const reviewed=await request('reviewer',`/api/runs/${runId}/review-context`,undefined,workspace);
 await request('reviewer',`/api/runs/${runId}/code-review`,{format:'projects-code-review-assessment/v2',contextId:reviewed.contextId,verdict:'pass',findings:[],resolvedPriorFindingIds:[],summary:'Scripted lifecycle boundary assessment of exact Git objects and retained independent checks. This is not model-quality or manual human-review proof.'},workspace);
 w=await state(workspace);
 const decision={decision:'accept',headCommit:run.headCommit,taskRevision:task.revision,ownerVersion:task.ownerVersion,comparisons:w.coordination[runId].overlaps.map(({runId,headCommit})=>({runId,headCommit})),note:'Scripted owner decision authorized for the disposable lifecycle qualification; not manual product-code acceptance.'};
 await request('owner',`/api/runs/${runId}/review`,decision,workspace);
 receipt.containerCommands+=checkCount;assert.ok(priorCommands+receipt.containerCommands<=setup.budget.containerCommands);await save();
 await once('merge-'+runId,()=>request('owner',`/api/runs/${runId}/merge`,{headCommit:run.headCommit},workspace));
 w=await state(workspace);assert.equal(w.tasks.find(t=>t.id===task.id).mergedCommit,run.headCommit);
 assert.equal(w.runs.find(r=>r.id===runId).evidenceHistory.at(-1).operation,'merge');return w;
}
async function candidate(projectId,label,source,workspace='primary',taskId){
 const claim=await once('claim-'+label,()=>taskId
  ?request('owner',`/api/tasks/${taskId}/agents`,{label,agentClientId:setup.agentClientIds[0]},workspace,randomUUID(),201)
  :request('builder',`/api/projects/${projectId}/claim`,{label},workspace));
 const credentials=credential(claim.credentials),directory=join(dir,'candidate-'+claim.runId);
 await git(['clone',credentials.remote,directory],dir,credentials);await git(['switch','-c',credentials.branch,credentials.baseCommit],directory);
 await request('builder',`/api/runs/${claim.runId}/start`,{},workspace);
 if(source!==null)await writeFile(join(directory,'reports.py'),source);
 else await writeFile(join(directory,'README.md'),(await readFile(join(directory,'README.md'),'utf8'))+'\nRestored project continuation retains failed and zero-check report denominators.\n');
 const head=await commit(directory,label);
 await once('push-'+claim.runId,()=>pushFresh(directory,credentials,['refs/heads/'+credentials.branch]));
 await request('builder',`/api/runs/${claim.runId}/submit`,{headCommit:head,summary:label+'; scripted Git actor, zero model requests.'},workspace);
 return {runId:claim.runId,taskId:claim.taskId,head,directory};
}
try{
 if(stage==='initial'){
  const empty=await state('primary');assert.equal(empty.tasks.length,0);assert.equal(Object.keys(empty.projects).length,0);
  await request('builder','/api/projects/restore',{},'primary',randomUUID(),403);assert.equal((await state('primary')).version,empty.version);
  const created=credential(await once('create-origin',()=>control('/lifecycle-create-seed'))),seed=join(dir,'seed');await mkdir(seed);
  await git(['init','-b','main'],seed);await writeFile(join(seed,'README.md'),'# Private Artifacts lifecycle fixture\n\nSummarize every report, including failures and zero-check rows.\n');
  await writeFile(join(seed,'reports.py'),'def summarize_checks(reports):\n    raise NotImplementedError("qualification baseline")\n');
  const base=await commit(seed,'Create native Artifacts lifecycle project');await once('push-origin',()=>pushFresh(seed,created,['refs/heads/main']));
  const seedRead=await control('/seed',{retireTokens:true});assert.equal(seedRead.head,base);passed('Native Artifacts seed created and its initial credential retired',{base});
  const brief={title:'Summarize Python checks',purpose:'Retain every report and its denominator.',criteria:['Keep failed and zero-check reports in counts.','Validate rows, preserve inputs and exact integer counts.'],owner:'Scripted lifecycle coordinator'};
  const project=await once('connect-origin',()=>request('owner','/api/tasks',{source:'repository',repo:setup.repository,baseCommit:base,projectName:'Private Artifacts lifecycle',tasks:[brief]},'primary',randomUUID(),201));
  const bad=await candidate(project.projectId,'Scripted retained failure','def summarize_checks(reports):\n    return {"passed":0,"total":0,"reports":0,"failed_reports":0}\n');
  const failed=await check(bad.runId,'primary',[['Report contract',contract,'contract verified\n']]);assert.equal(failed.runs.find(r=>r.id===bad.runId).evidence.passed,0);
  await request('owner',`/api/runs/${bad.runId}/review`,{decision:'reject',headCommit:bad.head,taskRevision:1,ownerVersion:1,comparisons:[],note:'Scripted rejection: the independent check retained the incorrect denominator.'});
  passed('A failed candidate and its 0/1 result are retained',{runId:bad.runId,commit:bad.head});
  const good=await candidate(project.projectId,'Scripted correct candidate',await readFile(setup.candidateSource,'utf8'),'primary',bad.taskId);
  const verified=await check(good.runId,'primary',[['Report contract',contract,'contract verified\n'],['Input boundaries',boundaries,'boundaries verified\n']]);assert.equal(verified.runs.find(r=>r.id===good.runId).evidence.passed,2);
  const w=await reviewMerge(good.runId,'primary',2);assert.equal(w.projects[project.projectId].mainCommit,good.head);passed('Independent reviewer, owner decision and guarded Artifacts merge',{runId:good.runId,commit:good.head});
  await request('owner',`/api/projects/${project.projectId}/policy`,{acceptingWork:false,expectedVersion:w.projects[project.projectId].policyVersion});
  const archive=await request('owner',`/api/projects/${project.projectId}/export`);assert.equal(archive.payload.current[0].payload.runs.length,2);
  await writeFile(join(dir,'project.json'),JSON.stringify(archive),{flag:'wx'});
  const sources=Object.fromEntries(archive.payload.commits.map(hash=>[hash,hash===bad.head?bad.directory:hash===base?seed:good.directory]));
  const bundle=await writeProjectBundle({archive,expectedArchiveSha256:archive.sha256,sources,directory:join(dir,'export')});
  receipt.result={projectId:project.projectId,base,bad,good,archiveSha256:archive.sha256,bundle};passed('All recorded candidates, checks and reviews exported with Git ancestry',receipt.result.bundle);
 }else if(stage==='restore'){
  const initial=JSON.parse(await readFile(join(dir,'initial.json'),'utf8'));assert.equal(initial.status,'passed');
  const archive=JSON.parse(await readFile(join(dir,'project.json'),'utf8'));
  const packageOnly=join(dir,'recovery-package');await mkdir(packageOnly);
  for(const file of ['manifest.json','project.json','project.bundle'])await copyFile(join(initial.result.bundle.directory,file),join(packageOnly,file));
  for(const old of [join(dir,'seed'),initial.result.bad.directory,initial.result.good.directory]){
   const from=resolve(old),to=resolve(old+'.retained-unavailable');assert.ok(from.startsWith(dir+sep)&&to.startsWith(dir+sep));assert.equal(await realpath(from),from);await rename(from,to);
  }
  const originalFetch=globalThis.fetch;globalThis.fetch=()=>{throw Error('Network is disabled for offline recovery');};let offline;
  try{offline=await restoreProjectBundle({directory:packageOnly,destination:join(dir,'offline-restored.git'),expectedManifestSha256:initial.result.bundle.manifestSha256});}finally{globalThis.fetch=originalFetch;}
  assert.equal(offline.mainCommit,initial.result.good.head);passed('Offline Git and record restoration without provider requests',offline);
  const created=credential(await once('create-restore',()=>control('/lifecycle-create-seed',{workspace:'second'})));
  const runner=new RepositoryRunner(dir);await runner.initialize();const refs=(await runner.git(offline.directory,['for-each-ref','--format=%(refname)','refs/heads'])).split('\n');
  await once('push-restored',()=>pushFresh(offline.directory,created,refs));assert.equal((await control('/seed',{workspace:'second',retireTokens:true})).head,offline.mainCommit);
  const input={archive,expectedSha256:archive.sha256,repo:setup.restoreRepository,projectName:'Restored Artifacts lifecycle'},key=randomUUID();
  const restored=await once('restore-project',()=>request('owner','/api/projects/restore',input,'second',key,201));
  const replay=await request('owner','/api/projects/restore',input,'second',key,201);assert.equal(replay.projectId,restored.projectId);assert.equal(replay.replayed,true);
  await request('owner','/api/projects/restore',{...input,projectName:'conflicting payload'},'second',key,409);
  await request('builder','/api/projects/restore',input,'second',key,403);
  const history=await request('owner',`/api/projects/${restored.projectId}/history`,undefined,'second');assert.equal(history.historical,true);assert.deepEqual(history.tasks,archive.payload.current);
  const w=await state('second');assert.equal(w.projects[restored.projectId].acceptingWork,false);assert.equal(w.tasks.length,0);assert.equal(w.runs.length,0);
  await request('owner',`/api/runs/${initial.result.good.runId}/review`,{decision:'accept',note:'Foreign resource isolation probe',headCommit:initial.result.good.head,taskRevision:1,ownerVersion:1,comparisons:[]},'second',randomUUID(),404);
  receipt.result={projectId:restored.projectId,offline,archiveSha256:archive.sha256,historySha256:digest(JSON.stringify(history))};passed('Restored history grants no active work or approval; replay is scoped and conflict-safe');
 }else if(stage==='reconcile-restore'){
  // Only reconcile the known final-probe failure. Never repeat creation or Git writes.
  const failedBytes=await readFile(join(dir,'restore.json'),'utf8'),failed=JSON.parse(failedBytes);
  const initial=JSON.parse(await readFile(join(dir,'initial.json'),'utf8')),archive=JSON.parse(await readFile(join(dir,'project.json'),'utf8'));
  assert.equal(failed.status,'failed');assert.equal(failed.containerCommands,0);
  assert.deepEqual(failed.steps.map(step=>[step.name,step.status]),[['create-restore','confirmed'],['push-restored','confirmed'],['restore-project','confirmed']]);
  assert.equal(failed.requests.at(-1).path,`/api/runs/${initial.result.good.runId}/review`);
  assert.equal(failed.requests.at(-1).status,400);assert.equal(failed.requests.at(-1).code,'INVALID_INPUT');
  assert.equal(failed.cases.length,1);assert.equal(failed.cases[0].status,'passed');
  const w=await state('second'),projects=Object.values(w.projects);assert.equal(projects.length,1);
  const project=projects[0];assert.equal(project.repositoryName,setup.restoreRepository);assert.equal(project.mainCommit,initial.result.good.head);
  assert.equal(project.acceptingWork,false);assert.equal(w.tasks.length,0);assert.equal(w.runs.length,0);
  assert.equal((await control('/seed',{workspace:'second'})).head,project.mainCommit);
  const input={archive,expectedSha256:archive.sha256,repo:setup.restoreRepository,projectName:'Restored Artifacts lifecycle'},key=failed.requests[0].key;
  assert.equal(digest(JSON.stringify(input)),failed.requests[0].bodySha256);
  const replay=await request('owner','/api/projects/restore',input,'second',key,201);assert.equal(replay.projectId,project.id);assert.equal(replay.replayed,true);
  await request('owner','/api/projects/restore',{...input,projectName:'conflicting payload'},'second',key,409);
  await request('builder','/api/projects/restore',input,'second',key,403);
  const history=await request('owner',`/api/projects/${project.id}/history`,undefined,'second');assert.equal(history.historical,true);assert.deepEqual(history.tasks,archive.payload.current);
  await request('owner',`/api/runs/${initial.result.good.runId}/review`,{decision:'accept',note:'Foreign resource isolation probe',headCommit:initial.result.good.head,taskRevision:1,ownerVersion:1,comparisons:[]},'second',randomUUID(),404);
  assert.equal((await state('second')).version,w.version);
  receipt.reconciles={stage:'restore',sha256:digest(failedBytes),source:failed.source};
  const {name,status,...offline}=failed.cases[0];
  receipt.result={projectId:project.id,offline,archiveSha256:archive.sha256,historySha256:digest(JSON.stringify(history))};
  passed('Existing restore reconciled without repeating repository creation or Git writes');
  passed('Restored history grants no active work or approval; replay is scoped and conflict-safe');
 }else if(stage==='continue'){
  const restored=JSON.parse(await readFile(join(dir,restorationReceipt+'.json'),'utf8'));assert.equal(restored.status,'passed');const projectId=restored.result.projectId;
  let w=await state('second');await request('owner',`/api/projects/${projectId}/policy`,{acceptingWork:true,expectedVersion:w.projects[projectId].policyVersion},'second');
  await request('owner','/api/tasks',{source:'project',projectId,tasks:[{title:'Document recovery continuation',purpose:'Continue the restored permanent project.',criteria:['README describes retained denominators after restoration.'],owner:'Scripted lifecycle coordinator'}]},'second',randomUUID(),201);
  const next=await candidate(projectId,'Scripted restored-project continuation',null,'second');
  const code='from pathlib import Path\nassert "Restored project continuation retains failed and zero-check report denominators." in Path("README.md").read_text()\n'+contract;
  const verified=await check(next.runId,'second',[['Restored continuation',code,'contract verified\n']]);assert.equal(verified.runs.find(r=>r.id===next.runId).evidence.passed,1);
  w=await reviewMerge(next.runId,'second',1);assert.equal(w.projects[projectId].mainCommit,next.head);
  const history=await request('owner',`/api/projects/${projectId}/history`,undefined,'second');assert.equal(digest(JSON.stringify(history)),restored.result.historySha256);
  const initial=JSON.parse(await readFile(join(dir,'initial.json'),'utf8'));assert.equal((await control('/seed')).head,initial.result.good.head);
  receipt.result={projectId,runId:next.runId,commit:next.head,originalMain:initial.result.good.head};passed('Fresh task, checks and review merge after restore; original project stays unchanged');
 }else{
  for(const workspace of ['primary','second']){
   const retired=await control('/lifecycle-retire',{workspace});assert.ok(retired.every(repo=>repo.tokens.every(token=>token.state!=='active')));
   const snapshot=await control('/snapshot',{workspace});assert.ok(!Object.values(snapshot.operations).some(op=>op.state==='pending'));
   assert.ok(!snapshot.workspace.runs.some(run=>['assigned','running'].includes(run.status)));passed(workspace+' has no active Git credentials, assignments or pending operations',{repositories:retired.map(repo=>repo.name)});
  }
 }
 receipt.status='passed';
}catch(error){receipt.status='failed';receipt.error=sanitize(error.message);process.exitCode=1;}
finally{receipt.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify({stage,status:receipt.status,cases:receipt.cases.length,receipt:receiptPath,error:receipt.error}));}
