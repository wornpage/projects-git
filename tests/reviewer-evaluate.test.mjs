import test from 'node:test';
import assert from 'node:assert/strict';
import {scoreReviews} from '../src/reviewer/evaluate.mjs';
import {runFreshReview} from '../src/reviewer/run.mjs';
import {cases} from './evals/reviewer-cases.mjs';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,sep} from 'node:path';
import {spawnSync} from 'node:child_process';

test('quality score retains complete denominators, misses, false alarms and failed attempts',()=>{
 const first=cases[0],second=cases[1];
 const finding=packet=>({title:'Boundary issue',body:'The line can violate the contract.',priority:1,
  location:{path:'checkout.mjs',side:'head',startLine:1,endLine:1},evidence:'The checked expression lacks a guard.'});
 const result=scoreReviews(cases,[
  {caseId:first.id,status:'evaluated',assessment:{verdict:'changes_requested',findings:[finding(first.packet)]}},
  {caseId:second.id,status:'evaluated',assessment:{verdict:'changes_requested',findings:[finding(second.packet)]}},
  {caseId:cases[2].id,status:'failed'}]);
 assert.deepEqual(result.cases,{total:3,attempted:3,completed:2,failed:1,notRun:0});
 assert.deepEqual(result.blockingFindings,{expected:2,assessable:1,notAssessed:1,locationMatches:1,priorityMatches:1,priorityMismatches:0,missedLocations:0,reported:2,unmatchedLocations:1});
 assert.deepEqual(result.verdicts,{expectedPass:1,expectedChanges:2,correct:1,falsePass:0,falseReject:1});
});
test('a correct defect location does not conceal an inflated priority',()=>{
 const example=cases[0];
 const score=scoreReviews([example],[{caseId:example.id,status:'evaluated',assessment:{verdict:'changes_requested',
   findings:[{priority:0,location:{path:'checkout.mjs',side:'head',startLine:1,endLine:1}}]}}]);
 assert.equal(score.blockingFindings.locationMatches,1);
 assert.equal(score.blockingFindings.priorityMatches,0);
 assert.equal(score.blockingFindings.priorityMismatches,1);
});
test('a correctly located but nonblocking priority remains a severity mismatch',()=>{
 const example=cases[0];
 const score=scoreReviews([example],[{caseId:example.id,status:'evaluated',assessment:{verdict:'pass',
   findings:[{priority:2,location:{path:'checkout.mjs',side:'head',startLine:1,endLine:1}}]}}]);
 assert.equal(score.blockingFindings.locationMatches,1);
 assert.equal(score.blockingFindings.priorityMismatches,1);
 assert.equal(score.blockingFindings.missedLocations,0);
 assert.equal(score.blockingFindings.reported,0);
 assert.equal(score.verdicts.falsePass,1);
});
test('unrun cases remain visible outside the quality denominator',()=>{
 const score=scoreReviews(cases,[]);
 assert.deepEqual(score.cases,{total:3,attempted:0,completed:0,failed:0,notRun:3});
 assert.equal(score.blockingFindings.expected,2);assert.equal(score.blockingFindings.assessable,0);
 assert.equal(score.blockingFindings.notAssessed,2);assert.equal(score.blockingFindings.missedLocations,0);
});

test('evaluation sends only the packet to a fresh tool-free model and never posts an assessment',async()=>{
 const example=cases[0],saved=[];let calls=0;
 assert.ok(cases.every(item=>item.packet.evidence.verified&&item.packet.evidence.source==='scripted-evaluation-fixture'
   &&item.packet.evidence.passed===item.packet.evidence.total));
 const output={format:'projects-code-review-assessment/v2',contextId:example.packet.contextId,
   verdict:'changes_requested',summary:'The sum can overflow.',resolvedPriorFindingIds:[],findings:[{title:'Unsafe sum',body:'Large values return an unsafe integer.',priority:1,
     location:{path:'checkout.mjs',side:'head',startLine:1,endLine:1},evidence:'The changed expression does not check Number.isSafeInteger.'}]};
 const result=await runFreshReview({mode:'evaluate',runId:example.packet.context.runId,model:'scripted-evaluation',
   limits:{maxInputBytes:8192,maxOutputTokens:1024,timeoutMs:5000},readContext:async()=>example.packet,
   provider:async request=>{calls++;assert.ok(!JSON.stringify(request.messages).includes('"expected"'));
     return {content:JSON.stringify(output),finishReason:'stop',usage:{prompt_tokens:50,completion_tokens:35,total_tokens:85}};},
   save:async receipt=>saved.push(receipt)});
 assert.equal(calls,1);assert.equal(result.receipt.status,'evaluated');assert.equal(saved.at(-1).assessment.verdict,'changes_requested');
 assert.equal(scoreReviews([example],[{caseId:example.id,status:result.receipt.status,assessment:result.assessment}]).blockingFindings.locationMatches,1);
});

test('an explicit continuation schedules only unattempted cases and retains the full denominator',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'review-eval-plan-'));
 t.after(async()=>{assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true});});
 const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
 const limits={maxInputBytes:8192,maxOutputTokens:1024,timeoutMs:120000};
 const prior={format:'projects-review-quality-run/v1',provider:'workers-ai',model:'fixture-model',limits,
  casesSha256:sha(await readFile(new URL('./evals/reviewer-cases.mjs',import.meta.url))),
  runnerSha256:sha(await readFile(new URL('../src/reviewer/run.mjs',import.meta.url))),
  attempts:[{caseId:'unsafe-total',status:'failed'}]};
 const path=join(directory,'prior.json');await writeFile(path,JSON.stringify(prior));
 const args=['tests/evals/evaluate-reviewer.mjs','--provider','workers-ai','--model','fixture-model',
  '--max-input-bytes','8192','--max-output-tokens','1024','--timeout-ms','120000','--prior-report',path,'--dry-run'];
 const run=(...selection)=>spawnSync(process.execPath,[...args,'--max-cases',String(selection.length),'--case-ids',selection.join(',')],
  {cwd:resolve('.'),encoding:'utf8',windowsHide:true});
 const planned=run('clean-total','missing-quantity-check');assert.equal(planned.status,0,planned.stderr);
 assert.deepEqual(JSON.parse(planned.stdout).scheduledCaseIds,['clean-total','missing-quantity-check']);
 assert.equal(JSON.parse(planned.stdout).totalAfterRun,3);
 const repeated=run('unsafe-total');assert.notEqual(repeated.status,0);
 assert.match(repeated.stderr,/already attempted case cannot be sent/);
 const interrupted=spawnSync(process.execPath,[...args.filter(value=>value!=='--dry-run'),
  '--max-cases','1','--case-ids','missing-quantity-check','--simulate-interruption-after-reservation'],
  {cwd:resolve('.'),encoding:'utf8',windowsHide:true,env:{...process.env,REVIEW_MODEL_API_KEY:'fixture-only',
    REVIEW_MODEL_ENDPOINT:'https://api.cloudflare.com/client/v4/accounts/'+'a'.repeat(32)+'/ai/v1/chat/completions'}});
 assert.equal(interrupted.status,0,interrupted.stderr);
 const reservedReport=JSON.parse(interrupted.stdout).report,reservedDirectory=dirname(reservedReport);
 assert.ok(resolve(reservedDirectory).startsWith(resolve('qa/review-workflow/evaluations')+sep));
 t.after(async()=>{await rm(reservedDirectory,{recursive:true,force:true});});
 const reserved=JSON.parse(await readFile(reservedReport,'utf8'));
 assert.deepEqual(reserved.attempts.map(item=>item.status),['failed','reserved']);
 const replayAfterCrash=spawnSync(process.execPath,[...args.map(value=>value===path?reservedReport:value),
  '--max-cases','1','--case-ids','missing-quantity-check'],
  {cwd:resolve('.'),encoding:'utf8',windowsHide:true});
 assert.notEqual(replayAfterCrash.status,0);
 assert.match(replayAfterCrash.stderr,/already attempted case cannot be sent/);
});
