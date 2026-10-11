import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fixtureToken,loadAccessFixture} from './access-fixture.mjs';

const manifest=JSON.parse(await readFile(process.argv[2],'utf8'));
assert.equal(manifest.format,'projects-git-local-runtime/v1');
assert.match(manifest.container,/^projects-agent-identity-\d+$/);
const origin=manifest.origin;assert.match(origin,/^http:\/\/127\.0\.0\.1:\d+$/);
process.env.PROJECTS_ACCESS_FIXTURE_KEY=manifest.fixtureKey;
const fixture=await loadAccessFixture(),owner=await fixtureToken(),agents=await Promise.all(fixture.agentClientIds.map(id=>fixtureToken(id)));
const receipt={runtime:'local-workerd',startedAt:new Date().toISOString(),source:manifest.source,scenarios:[],requests:[],peakOccupied:0,limitations:'Real local Worker and SQLite. Access signatures and Artifacts objects are explicit fixtures. External agents are scripted HTTP clients, not model executors. No hosted qualification.'};
async function request(token,path,body,key=crypto.randomUUID(),headers={}) {
  const response=await fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{...(token?{'Cf-Access-Jwt-Assertion':token}:{}),'Content-Type':'application/json','Idempotency-Key':key,...headers},body:body===undefined?undefined:JSON.stringify(body)});
  const result=await response.json();
  receipt.requests.push({path,key,status:response.status,principal:token===owner?'owner':agents.includes(token)?fixture.agentClientIds[agents.indexOf(token)]:'negative-fixture'});
  return {status:response.status,result};
}
const ok=async(...args)=>{const response=await request(...args);assert.ok(response.status>=200&&response.status<300,JSON.stringify(response.result));return response.result;};
const passed=name=>receipt.scenarios.push({name,status:'passed'});
try {
  const initial=await ok(owner,'/api/workspace');
  assert.equal(initial.authentication.principal.kind,'owner');
  for(const agent of agents)assert.equal((await ok(agent,'/api/workspace')).authentication.principal.kind,'agent');
  passed('verified owner and eight individually allowlisted service identities');
  const seconds=Math.floor(Date.now()/1000);
  for(const changes of [{exp:seconds-1},{nbf:seconds+60},{iss:'https://foreign.cloudflareaccess.com'},{aud:['b'.repeat(64)]}])assert.equal((await request(await fixtureToken(undefined,changes),'/api/workspace')).status,401);
  for(const token of ['',owner.slice(0,-8)+'forged12'])assert.equal((await request(token,'/api/workspace')).status,401);
  assert.equal((await request(owner,'/api/workspace',undefined,undefined,{'X-Workspace-Id':'foreign-workspace'})).status,403);
  assert.equal((await request(agents[0],'/api/tasks',{source:'repository'})).status,403);
  assert.equal((await request(agents[0],'/api/workspace/revoke-sessions',{})).status,403);
  assert.equal((await ok(owner,'/api/workspace')).version,initial.version);
  passed('invalid signatures, expiry, nbf, issuer, audience, workspace and owner-only requests refuse mutation');
  const tasks=Array.from({length:8},(_,index)=>({title:'Eight-client fixture '+index,purpose:'Bound four external reservations.',criteria:['Retain every queued task.'],owner:'Scripted local qualification'}));
  const project=await ok(owner,'/api/tasks',{source:'repository',projectName:'Identity fixture',repo:'browser-starter',baseCommit:'a'.repeat(40),tasks});
  const keys=agents.map(()=>crypto.randomUUID());
  const claims=await Promise.all(agents.map((agent,index)=>request(agent,`/api/projects/${project.projectId}/claim`,{label:'Scripted client '+index},keys[index])));
  const admitted=claims.flatMap((item,index)=>item.status===200?[{...item.result,index}]:[]);
  assert.equal(admitted.length,4);assert.equal(claims.filter(item=>item.status===409&&item.result.code==='CAPACITY_FULL').length,4);
  assert.equal(new Set(admitted.map(item=>item.taskId)).size,4);
  let state=await ok(owner,'/api/workspace');receipt.peakOccupied=state.capacity.occupied;
  assert.deepEqual([state.capacity.running,state.capacity.reserved,state.capacity.occupied,state.capacity.limit],[0,4,4,4]);
  assert.equal(state.tasks.filter(task=>project.taskIds.includes(task.id)).length,8);
  passed('eight competing clients retain eight tasks with exactly four occupied execution slots');
  const first=admitted[0],other=admitted[1];
  const replay=await ok(agents[first.index],`/api/projects/${project.projectId}/claim`,{label:'Scripted client '+first.index},keys[first.index]);
  assert.equal(replay.runId,first.runId);assert.equal(replay.credentials,null);
  assert.equal((await request(agents[first.index],`/api/projects/${project.projectId}/claim`,{label:'Changed'},keys[first.index])).status,409);
  const foreignReplay=await request(agents[other.index],`/api/projects/${project.projectId}/claim`,{label:'Scripted client '+first.index},keys[first.index]);
  assert.equal(foreignReplay.status,409);assert.equal(foreignReplay.result.credentials,undefined);
  for(const action of ['start','submit','fail'])assert.equal((await request(agents[other.index],`/api/runs/${first.runId}/${action}`,{})).status,403);
  assert.equal((await request(owner,`/api/runs/${first.runId}/review`,{reviewer:'Forged owner'})).status,400);
  assert.equal((await request(agents[first.index],`/api/runs/${crypto.randomUUID()}/start`,{})).status,404);
  passed('duplicate and changed requests, cross-client replay, foreign assignments and forged review attribution');
  const revoked=await ok(owner,'/api/workspace/revoke-sessions',{});
  for(const token of [owner,...agents])assert.equal((await request(token,'/api/workspace')).status,401);
  passed('durable workspace cutoff refuses all previously valid sessions');
  execFileSync('docker',['restart',manifest.container],{encoding:'utf8',windowsHide:true,timeout:30000});
  // Readiness polling is not a concurrency barrier or simulated executor delay.
  const deadline=Date.now()+120000;let ready=false;
  while(Date.now()<deadline){try{if((await fetch(origin+'/api/health')).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,250));}
  assert.ok(ready,'Restarted runtime must become healthy.');
  assert.equal((await request(owner,'/api/workspace')).status,401);
  const fresh=await fixtureToken();state=await ok(fresh,'/api/workspace');
  assert.equal(state.sessionsValidAfter,revoked.sessionsValidAfter);assert.equal(state.capacity.reserved,4);
  for(const item of admitted)assert.ok(state.runs.some(run=>run.id===item.runId&&run.status==='assigned'));
  passed('real Workerd restart retains session revocation, assignments and reservations; fresh authentication succeeds');
  for(const item of admitted)await ok(await fixtureToken(fixture.agentClientIds[item.index]),`/api/runs/${item.runId}/fail`,{message:'Scripted qualification cleanup after durable restart.'});
  assert.equal((await ok(fresh,'/api/workspace')).capacity.occupied,0);
  passed('fresh clients can close their retained assignments and release all four slots');
  receipt.status='passed';
}catch(error){receipt.status='failed';receipt.error=String(error.message);throw error;}
finally{receipt.finishedAt=new Date().toISOString();await writeFile(manifest.directory+'/identity-results.json',JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt,null,2));}
