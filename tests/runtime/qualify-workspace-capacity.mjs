import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';

const origin=process.argv[2],output=process.argv[3];
if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)||!output)throw Error('Supply the explicit loopback fixture origin and a new receipt filename.');
const checks=[],observations=[];
async function check(name,fn){try{await fn();checks.push({name,passed:true});}catch(error){checks.push({name,passed:false,error:error.message});throw error;}}
async function call(path,body,key,headers={}){
  const start=performance.now(),response=await fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{...headers,'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(60000)});
  const text=await response.text();observations.push({path,status:response.status,ms:performance.now()-start,bytes:Buffer.byteLength(text),fullReads:response.headers.get('X-Fixture-Full-Reads')});
  return {response,data:JSON.parse(text)};
}
let before,first,last,receipt;
try{
  await check('Seed 100 projects, 800 tasks, 800 candidates and 3,203 operation receipts',async()=>{
    const result=process.argv[4]==='resume-seed'?await call('/__fixture/stats'):await call('/__fixture/seed',{});assert.equal(result.response.status,200);before=result.data;
    assert.equal(before.counts.projects,100);assert.equal(before.counts.tasks,800);assert.equal(before.counts.runs,800);assert.equal(before.counts.operations,3203);
  });
  const seen=new Set();
  await check('All ten project pages have complete denominators, no duplicates and zero full snapshot reads',async()=>{
    for(let offset=0;offset<100;offset+=10){
      const result=await call(`/api/workspace?limit=10&offset=${offset}&at=${before.revision}`);assert.equal(result.response.status,200);assert.equal(result.response.headers.get('X-Fixture-Full-Reads'),'0');
      const data=result.data;first??=data;last=data;assert.equal(data.page.totalProjects,100);assert.equal(data.tasks.length,80);assert.equal(data.runs.length,80);assert.equal(data.capacity.occupied,4);assert.equal(data.capacity.verification.occupied,2);
      assert.ok(observations.at(-1).bytes<1_500_000);for(const id of Object.keys(data.projects)){assert.ok(!seen.has(id));seen.add(id);}
    }
    assert.equal(seen.size,100);
  });
  await check('A deep link loads one complete project and retains its global task number',async()=>{
    const task=last.tasks.at(-1),result=await call('/api/workspace?limit=1&task='+task.id);assert.equal(result.response.status,200);assert.equal(result.data.tasks.length,8);assert.equal(result.data.page.taskNumbers[task.id],800);assert.equal(result.response.headers.get('X-Fixture-Full-Reads'),'0');
  });
  const input={source:'project',projectId:Object.keys(first.projects)[0],tasks:[{title:'Retained after lost response',purpose:'Test 100-project durable replay.',criteria:['Create exactly one task.'],owner:'Scripted scale owner'}]};
  await check('A new operation succeeds beyond the former 500-record ceiling with a bounded project reply',async()=>{const result=await call('/api/tasks',input,'scale-lost-response');assert.equal(result.response.status,201);receipt=result.data.taskId;assert.equal(result.data.workspace.tasks.length,9);assert.equal(result.data.workspace.page.totalProjects,100);assert.ok(observations.at(-1).bytes<200000);});
  await check('A superseded page cursor is rejected',async()=>{const result=await call(`/api/workspace?limit=10&offset=10&at=${before.revision}`);assert.equal(result.response.status,409);assert.equal(result.data.code,'WORKSPACE_PAGE_CHANGED');});
  await check('Restart preserves all operation identities and the lost response replays one result',async()=>{
    await fetch(origin+'/__fixture/restart',{method:'POST',signal:AbortSignal.timeout(10000)}).catch(()=>{});
    const result=await call('/api/tasks',input,'scale-lost-response');assert.equal(result.response.status,201);assert.equal(result.data.replayed,true);assert.equal(result.data.taskId,receipt);
    const stats=(await call('/__fixture/stats')).data;assert.equal(stats.counts.tasks,801);assert.equal(stats.counts.operations,3204);
  });
  await check('Changed payload and agent owner-action attempts refuse without mutation',async()=>{
    const changed=await call('/api/tasks',{...input,tasks:[{...input.tasks[0],title:'Conflict'}]},'scale-lost-response');assert.equal(changed.response.status,409);
    const agent=await call('/api/tasks',input,'agent-forgery',{'X-Fixture-Agent':'11111111111111111111111111111111.access'});assert.equal(agent.response.status,403);
    const stats=(await call('/__fixture/stats')).data;assert.equal(stats.counts.tasks,801);assert.equal(stats.counts.operations,3204);
  });
}finally{
  const report={at:new Date().toISOString(),kind:'local-workerd-sqlite-synthetic-histories',resumedSeed:process.argv[4]==='resume-seed',status:checks.length===7&&checks.every(item=>item.passed)?'passed':'failed',passed:checks.filter(item=>item.passed).length,total:7,checks,observations,sourceProjects:100,sourceTasks:800,sourceCandidates:800,sourceOperationReceipts:3203,hosted:false,providerCalls:0};
  await writeFile(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({status:report.status,passed:report.passed,total:report.total,output}));
}
