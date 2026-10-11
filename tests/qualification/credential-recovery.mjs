import assert from 'node:assert/strict';import {readFile,writeFile,mkdir} from 'node:fs/promises';import {join,resolve} from 'node:path';
import {setup,agents,privateDirectory,receipt,request,ok,control,passed,save,waitFor,rememberSecret} from './client.mjs';
import {git} from './git.mjs';
const snapshot=async()=>{const r=await control('/snapshot');assert.equal(r.status,200);return r.result;};
const tokens=async runId=>{const r=await control('/tokens',{runId});assert.equal(r.status,200);return r.result;};
async function retainCredential(label,credentials){rememberSecret(credentials.token);await writeFile(join(privateDirectory,label+'.json'),JSON.stringify(credentials),{mode:0o600});}
async function commit(credentials,name,content){const directory=resolve('qa/identity-concurrency/hosted/git-'+crypto.randomUUID());await mkdir(directory,{recursive:true});await git(['clone','--no-checkout',credentials.remote,'.'],directory,credentials);await git(['checkout','--detach',credentials.baseCommit],directory,credentials);await git(['config','user.name','Scripted hosted credential regression'],directory);await git(['config','user.email','fixture@projects.invalid'],directory);await writeFile(join(directory,name),content);await git(['add',name],directory);await git(['commit','-m','Retain private credential-recovery fixture'],directory);const head=await git(['rev-parse','HEAD'],directory);await writeFile(join(privateDirectory,'pending-qualification-write.json'),JSON.stringify({head,remote:credentials.remote,branch:credentials.branch}),{mode:0o600});await git(['push','origin','HEAD:refs/heads/'+credentials.branch],directory,credentials);return head;}
async function proveRace(kind,start,operationRunId){
  const before=await snapshot(),eventsBefore=(await control('/gates')).result.events.filter(e=>e.phase==='token-list').length;
  assert.equal((await control('/arm-token-list')).status,200);
  const old=start().catch(error=>({status:0,result:{error:error.message}}));
  const gates=await waitFor(()=>control('/gates'),r=>r.result.events.filter(e=>e.phase==='token-list').length===eventsBefore+1,'old token-list call blocked');
  const resourceName=gates.result.events.filter(e=>e.phase==='token-list').at(-1).key;
  const pending=await snapshot(),op=Object.values(pending.operations).find(o=>o.state==='pending'&&o.kind===(kind==='assignment'?'assign':'base-update')&&o.resourceName===resourceName);
  assert.ok(op);const runId=operationRunId??op.itemId;const expired=await control('/expire',{runId,attemptId:op.attemptId});assert.equal(expired.status,200,JSON.stringify(expired.result));
  const replacement=await start();assert.ok(replacement.status>=200&&replacement.status<300);const result=replacement.result;assert.ok(result.credentials);await retainCredential('race-'+kind,result.credentials);
  const activeBefore=(await tokens(result.runId)).filter(t=>t.state==='active');assert.equal(activeBefore.length,1);
  const refsBefore=await git(['ls-remote',result.credentials.remote],undefined,result.credentials);assert.ok(refsBefore.includes(result.credentials.baseCommit));
  const settled=await snapshot();await control('/configure',{phase:'token-list',held:false});
  const late=await old;assert.equal(late.status,409);assert.equal(late.result.code,'STALE_OPERATION');
  assert.deepEqual(await snapshot(),settled,'The old request must not overwrite completed recovery');
  const activeAfter=(await tokens(result.runId)).filter(t=>t.state==='active');assert.deepEqual(activeAfter,activeBefore);
  assert.equal(await git(['ls-remote',result.credentials.remote],undefined,result.credentials),refsBefore,'Delivered Git credential must still authenticate after late cleanup');
  const replay=await start();assert.equal(replay.result.runId,result.runId);assert.equal(replay.result.credentials,null);
  receipt.recovery??=[];receipt.recovery.push({kind,runId:result.runId,oldAttempt:op.attemptId,resourceName:op.resourceName,activeTokenId:activeAfter[0].id,lateStatus:late.status,credentialAuthenticatedBeforeAndAfter:true,sourceRevisionBefore:before.revision,completedRevision:settled.revision,barrier:gates.result.events.filter(e=>e.phase==='token-list').at(-1)});
  await ok(0,`/api/runs/${result.runId}/fail`,{message:'Scripted hosted credential-recovery regression complete.'});assert.ok((await tokens(result.runId)).every(t=>t.state!=='active'));
  passed(kind+' recovery keeps its delivered real Git credential active after superseded cleanup');
}
let failure;
try{
  const state=await ok('owner','/api/workspace'),project=Object.values(state.projects).find(p=>p.repositoryName===setup.repository);assert.ok(project);
  const batch=await ok('owner','/api/tasks',{source:'project',projectId:project.id,tasks:['Assignment','Resolution'].map(kind=>({title:kind+' credential cleanup race',purpose:'Prove superseded cleanup cannot revoke a delivered successor credential.',criteria:['The delivered credential authenticates before and after the late attempt.'],owner:'Scripted private qualification'}))});
  const body={label:'Assignment cleanup fixture',agentClientId:agents[0].client_id},key=crypto.randomUUID();
  await proveRace('assignment',()=>request('owner',`/api/tasks/${batch.taskIds[0]}/agents`,body,key));
  const original=await ok('owner',`/api/tasks/${batch.taskIds[1]}/agents`,{label:'Resolution source fixture',agentClientId:agents[0].client_id});await retainCredential('resolution-original',original.credentials);
  await ok(0,`/api/runs/${original.runId}/start`,{});const head=await commit(original.credentials,'requalification-candidate-'+original.runId+'.txt','Original retained candidate\n');await ok(0,`/api/runs/${original.runId}/submit`,{headCommit:head,summary:'Scripted candidate retained before current main advances.'});
  const permit=await control('/seed-credential');assert.equal(permit.status,200);await retainCredential('seed-advance',permit.result);
  const currentBase=await commit(permit.result,'requalification-base-'+original.runId+'.txt','Independent main advancement for private recovery proof\n');await control('/seed',{retireTokens:true});
  const input={headCommit:head,taskRevision:1,mode:'resolve',agentClientId:agents[0].client_id},resolutionKey=crypto.randomUUID();
  await proveRace('resolution',()=>request('owner',`/api/runs/${original.runId}/update-base`,input,resolutionKey),original.runId);
  const final=await snapshot();assert.equal(final.workspace.runs.find(r=>r.id===original.runId).headCommit,head);assert.equal(final.workspace.runs.find(r=>r.id===original.runId).status,'superseded');assert.equal(final.workspace.tasks.find(t=>t.id===batch.taskIds[1]).baseCommit,currentBase);
}catch(error){failure=error;}finally{await control('/configure',{phase:'token-list',held:false}).catch(()=>{});await control('/seed',{retireTokens:true}).catch(()=>{});await save('credential-recovery',failure);}if(failure)throw failure;
