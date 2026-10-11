import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {runFreshReview} from '../src/reviewer/run.mjs';

const head='b'.repeat(40),base='a'.repeat(40),runId=randomUUID();
function source(name,body){const bytes=Buffer.from(body);return {name,base64:bytes.toString('base64'),oid:createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')};}
function packet(){
 const context={workspaceId:'fixture',taskId:randomUUID(),runId,headCommit:head,baseCommit:base,reviewAssignmentId:'assignment-1',requirements:{title:'Check integer totals',criteria:['Safe cents']}};
 return {format:'projects-code-review/v1',contextId:createHash('sha256').update(JSON.stringify(context)).digest('hex'),context,
  candidate:{changedFiles:['checkout.mjs'],diff:'+ return total;'},source:{commit:head,files:[source('checkout.mjs','return total;\n')]},
  baseSource:{commit:base,files:[source('checkout.mjs','return 0;\n')]},verificationPolicy:{definitionSha256:'1'.repeat(64)},
  evidence:{verified:true,passed:1,total:1},secretOutsidePacket:'must never enter the model prompt'};
}
const budget={maxInputBytes:8192,maxOutputTokens:1024,timeoutMs:5000};
const output=contextId=>({format:'projects-code-review-assessment/v2',contextId,verdict:'changes_requested',summary:'The result may be unsafe.',resolvedPriorFindingIds:[],
 findings:[{title:'Unsafe sum',body:'The total can exceed the safe-integer limit.',priority:1,
  location:{path:'checkout.mjs',side:'head',startLine:1,endLine:1},evidence:'The committed line returns total without a bound.'}]});
const providerResult=content=>({content:JSON.stringify(content),finishReason:'stop',usage:{prompt_tokens:100,completion_tokens:30,total_tokens:130}});
const reserveReview=async(id,input,key)=>{
 assert.equal(id,runId);assert.equal(input.assignmentId,'assignment-1');assert.match(key,/^[a-f0-9-]{36}$/);
 return {attemptId:randomUUID(),contextId:input.contextId,state:'pending',replayed:false};
};

test('fresh reviewer sees only the bounded packet, retains reservation before inference, and submits one assessment',async()=>{
 const fixture=packet(),saves=[],calls=[];
 const result=await runFreshReview({runId,model:'fixture-reviewer',limits:budget,readContext:async()=>fixture,
  reserveReview,
  provider:async request=>{calls.push(request);assert.equal(saves[0].status,'reserved');assert.equal(saves[1].status,'server_reserved');assert.equal(saves[2].status,'in_flight');
   assert.equal(request.messages.length,2);assert.ok(!JSON.stringify(request.messages).includes('secretOutsidePacket'));
   assert.match(request.messages[0].content,/Side must be exactly "head" or "base"/);
   assert.match(request.messages[0].content,/Verdict must be exactly "pass" or "changes_requested"/);
   return providerResult(output(fixture.contextId));},
  submitAssessment:async(id,assessment,key,attemptId)=>{assert.equal(id,runId);assert.match(key,/^[a-f0-9-]{36}$/);assert.match(attemptId,/^[a-f0-9-]{36}$/);assert.equal(assessment.findings[0].location.path,'checkout.mjs');return {codeReview:{id:'assessment',contextId:assessment.contextId}};},
  save:async receipt=>saves.push(receipt)});
 assert.equal(calls.length,1);assert.equal(result.receipt.status,'submitted');assert.equal(result.receipt.usage.inputTokens,100);
 assert.equal(saves.at(-1).assessmentId,'assessment');assert.ok(!JSON.stringify(saves).includes('secretOutsidePacket'));
});

test('tampered source and oversized packets refuse before reservation or provider work',async()=>{
 for(const mutate of [value=>value.source.files[0].base64=Buffer.from('altered\n').toString('base64'),
   value=>value.candidate.diff='x'.repeat(9000)]){
  const value=packet();mutate(value);let saves=0,calls=0;
  await assert.rejects(runFreshReview({runId,model:'fixture-reviewer',limits:budget,readContext:async()=>value,
    reserveReview,provider:async()=>{calls++;},submitAssessment:async()=>{},save:async()=>{saves++;}}));
  assert.equal(saves,0);assert.equal(calls,0);
 }
});

test('invalid model findings retain the failed output without submitting or silently retrying',async()=>{
 const fixture=packet(),saves=[];let calls=0,submits=0;
 await assert.rejects(runFreshReview({runId,model:'fixture-reviewer',limits:budget,readContext:async()=>fixture,
  reserveReview,
  provider:async()=>{calls++;return providerResult({...output(fixture.contextId),findings:[{...output(fixture.contextId).findings[0],location:{path:'other.mjs',side:'head',startLine:1,endLine:1}}]});},
  submitAssessment:async()=>{submits++;},save:async receipt=>saves.push(receipt)}));
 assert.equal(calls,1);assert.equal(submits,0);assert.equal(saves.at(-1).status,'invalid_response');assert.match(saves.at(-1).rawSha256,/^[a-f0-9]{64}$/);
});

test('evaluation refuses findings beyond either hash-verified source side before quality scoring',async()=>{
 for(const side of ['head','base']){
  const fixture=packet(),saves=[];let calls=0;
  await assert.rejects(runFreshReview({mode:'evaluate',runId,model:'fixture-reviewer',limits:budget,readContext:async()=>fixture,
   provider:async()=>{calls++;return providerResult({...output(fixture.contextId),findings:[{...output(fixture.contextId).findings[0],
     location:{path:'checkout.mjs',side,startLine:2,endLine:2}}]});},save:async receipt=>saves.push(receipt)}),
   /beyond the committed source file/);
  assert.equal(calls,1);assert.equal(saves.at(-1).status,'invalid_response');
  assert.notEqual(saves.at(-1).status,'evaluated');
 }
 const fixture=packet();
 const valid=await runFreshReview({mode:'evaluate',runId,model:'fixture-reviewer',limits:budget,readContext:async()=>fixture,
  provider:async()=>providerResult({...output(fixture.contextId),findings:[{...output(fixture.contextId).findings[0],
    location:{path:'checkout.mjs',side:'base',startLine:1,endLine:1}}]}),save:async()=>{}});
 assert.equal(valid.receipt.status,'evaluated');
});

test('a replayed or uncertain server reservation never starts model inference',async()=>{
 for(const outcome of ['replayed','lost']){
  const fixture=packet(),saves=[];let providerCalls=0;
  await assert.rejects(runFreshReview({runId,model:'fixture-reviewer',limits:budget,readContext:async()=>fixture,
   reserveReview:async(id,input)=>outcome==='lost'?Promise.reject(new Error('Lost reservation reply'))
     :{attemptId:randomUUID(),contextId:input.contextId,state:'pending',replayed:true},
   provider:async()=>{providerCalls++;return providerResult(output(fixture.contextId));},
   submitAssessment:async()=>{},save:async receipt=>saves.push(receipt)}));
  assert.equal(providerCalls,0);assert.equal(saves.at(-1).status,'reservation_uncertain');
 }
});

test('a delayed model result cannot submit after cancellation',async()=>{
 const fixture=packet(),controller=new AbortController(),saves=[];let started,finish,submits=0;
 const entered=new Promise(resolve=>started=resolve),late=new Promise(resolve=>finish=resolve);
 const pending=runFreshReview({runId,model:'fixture-reviewer',limits:budget,readContext:async()=>fixture,
  reserveReview,
  provider:async()=>{started();return late;},submitAssessment:async()=>{submits++;},save:async receipt=>saves.push(receipt),signal:controller.signal});
 await entered;controller.abort(new Error('Cancelled reviewer'));await assert.rejects(pending);
 finish(providerResult(output(fixture.contextId)));await Promise.resolve();
 assert.equal(submits,0);assert.equal(saves.at(-1).status,'inference_uncertain');
});
