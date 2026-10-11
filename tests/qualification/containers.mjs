import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {privateDirectory,receipt,request,ok,control,passed,save,waitFor} from './client.mjs';
import {digest,requirementsDigest,CHECK_FORMAT} from '../../src/core/check-definition.mjs';
const candidates=JSON.parse(await readFile(join(privateDirectory,'container-candidates.json'),'utf8'));
const snapshot=async()=>{const r=await control('/snapshot');assert.equal(r.status,200);return r.result;};
const activity=async attemptId=>{const r=await control('/activity',{attemptId});assert.equal(r.status,200);return r.result;};
const operation=(state,candidate)=>Object.values(state.operations).findLast(o=>o.itemId===candidate.runId&&o.kind==='checks'&&o.state==='pending');
async function ready(candidate){const state=await waitFor(snapshot,s=>Boolean(operation(s,candidate)),'reserved verification');const op=operation(state,candidate);await waitFor(()=>activity(op.attemptId),a=>a.running&&a.ready,'actual container barrier',50000);return op;}
function definition(candidate,task,gated=true){const code=`const fs=require('fs');if(fs.readFileSync('qualification.txt','utf8')!==${JSON.stringify(candidate.expectedMarker)})process.exit(2);(async()=>{${gated?`await new Promise(resolve=>{const release=()=>{if(fs.existsSync('/tmp/qualification-release')){watcher.close();resolve();}};const watcher=fs.watch('/tmp',release);fs.writeFileSync('/tmp/qualification-ready','ready');release();});`:''}process.stdout.write('checked\\n');})()`;const value=JSON.stringify({format:CHECK_FORMAT,commit:candidate.head,taskRevision:task.revision,requirementsSha256:requirementsDigest(task),timeoutMs:60000,checks:[{name:'Trusted qualification marker',argv:['node','-e',code],stdin:'',expected:{exitCode:0,stdout:'checked\n'}}]});return {definition:value,definitionSha256:digest(value)};}
const check=(candidate,body,key)=>request('owner',`/api/runs/${candidate.runId}/checks`,body,key).catch(error=>({status:0,result:{error:error.message}}));
let failure;
try{
  const initial=await snapshot(),bodies=candidates.map(c=>definition(c,initial.workspace.tasks.find(t=>t.id===c.taskId))),keys=candidates.map(()=>crypto.randomUUID());
  const first=check(candidates[0],bodies[0],keys[0]),second=check(candidates[1],bodies[1],keys[1]);
  const active=await Promise.all([ready(candidates[0]),ready(candidates[1])]);
  const full=await ok('owner','/api/workspace');assert.equal(full.capacity.verification.occupied,2);receipt.peakVerification=2;
  const third=await check(candidates[2],bodies[2],keys[2]);assert.equal(third.status,409);assert.equal(third.result.code,'VERIFICATION_CAPACITY');
  receipt.executorActivity=await Promise.all(active.map(async op=>({attemptId:op.attemptId,...await activity(op.attemptId)})));
  passed('two observed real container executors fill the independent verification limit; third is refused');
  await control('/expire',{runId:candidates[0].runId});
  const recovered=await check(candidates[0],bodies[0],keys[0]);assert.equal(recovered.status,200,JSON.stringify(recovered.result));
  assert.equal((await activity(active[0].attemptId)).running,false);
  const late=await first;assert.equal(late.status,409);assert.equal(late.result.code,'STALE_OPERATION');
  assert.equal(recovered.result.runs.find(r=>r.id===candidates[0].runId).evidence.verified,false);
  await control('/release',{attemptId:active[1].attemptId});const completed=await second;assert.equal(completed.status,200);
  assert.equal(completed.result.runs.find(r=>r.id===candidates[1].runId).evidence.passed,1);
  passed('expired verification lease cancels and joins its real executor before releasing capacity; late result is fenced');
  const thirdStarted=check(candidates[2],bodies[2],keys[2]),thirdOp=await ready(candidates[2]);
  await control('/restart');await control('/expire',{runId:candidates[2].runId});
  const restart=await check(candidates[2],bodies[2],keys[2]);assert.equal(restart.status,200,JSON.stringify(restart.result));
  assert.equal((await activity(thirdOp.attemptId)).running,false);assert.notEqual((await thirdStarted).status,200);
  assert.equal(restart.result.runs.find(r=>r.id===candidates[2].runId).evidence.verified,false);
  passed('Durable Object restart during a real check retains its candidate and failed report without rerunning execution');
  // A new explicit request obtains new evidence; old interrupted reports remain.
  const state=await snapshot(),plain=definition(candidates[0],state.workspace.tasks.find(t=>t.id===candidates[0].taskId),false);
  const fresh=await check(candidates[0],plain,crypto.randomUUID());assert.equal(fresh.status,200);const run=fresh.result.runs.find(r=>r.id===candidates[0].runId);
  assert.equal(run.evidence.verified,true);assert.equal(run.evidence.passed,1);assert.ok(run.evidenceHistory.length>=1);
  await writeFile('qa/identity-concurrency/hosted/container-summary.json',JSON.stringify({runId:run.id,head:run.headCommit,evidence:run.evidence,history:run.evidenceHistory},null,2));
  passed('new explicit verification passes while interrupted evidence remains retained');
}catch(error){failure=error;}finally{await save('containers',failure);}if(failure)throw failure;
