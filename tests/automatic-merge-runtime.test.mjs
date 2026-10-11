import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {initialSnapshot} from '../src/cloudflare/controller.ts';
import {createTask,assignRun,startRun,completeRun,verifyRun,assignReviewers,codeReviewContext,recordCodeReview} from '../src/core/workflow.mjs';
import {testAuthority,testReviewerAuthority,REVIEWER_CLIENT} from './helpers/hosted-authority.mjs';
import {ownerBinding} from '../src/cloudflare/access.ts';
import {setAutomaticMergePolicy} from '../src/core/project-work.mjs';
const {Miniflare,convertV4MiniflareOptions}=createRequire(new URL('../node_modules/wrangler/package.json',import.meta.url))('miniflare');

for (const trigger of ['owner policy switch','independent reviewer submission','crash after failure write']) test(`production Workerd alarm and SQLite retain the outcome for ${trigger}`, {timeout:20000}, async t=>{
  const authority=testAuthority(),snapshot=initialSnapshot(authority.policy.workspaceId),state=snapshot.workspace;
  state.authentication=ownerBinding(authority.policy);
  const projectId=crypto.randomUUID();
  const task=createTask(state,{title:'Alarm fixture',purpose:'Exercise scheduled policy approval',criteria:['Keep the policy receipt'],owner:'Fixture owner',baseCommit:'a'.repeat(40)});
  Object.assign(task,{projectId,repositoryKey:projectId,verificationProfile:'checkout'});
  state.projects[projectId]={id:projectId,name:'Fixture',repositoryName:'target',mainCommit:task.baseCommit,acceptingWork:true,policyVersion:1};
  const run=assignRun(state,task.id,{agent:'fixture',label:'Scripted builder',branch:'work'});
  startRun(state,run.id);completeRun(state,run.id,{headCommit:'b'.repeat(40),changedFiles:['checkout.mjs'],diff:'',summary:'Synthetic transport fixture'});
  verifyRun(state,run.id,{verified:true,source:'independent-sandbox-checks',commit:run.headCommit,taskRevision:1,passed:1,total:1,exitCode:0,
    checks:[{name:'Fixture',passed:true,detail:'Scripted observation'}],command:'fixture',output:'',verifiedAt:new Date().toISOString()});
  assignReviewers(state,run.id,{contextId:codeReviewContext(state,run.id).contextId,expectedVersion:state.version,reviewerIds:[REVIEWER_CLIENT]},authority.principal,[REVIEWER_CLIENT],'assignment');
  const assessment={format:'projects-code-review-assessment/v2',contextId:codeReviewContext(state,run.id).contextId,verdict:'pass',summary:'Scripted assessment',findings:[],resolvedPriorFindingIds:[]};
  if(trigger!=='independent reviewer submission') recordCodeReview(state,run.id,assessment,testReviewerAuthority().principal,'assessment');
  else setAutomaticMergePolicy(state,projectId,{enabled:true,expectedVersion:0},authority.principal);
  snapshot.repositories[task.id]='target';snapshot.forks[run.id]={name:'candidate',remote:'https://artifacts.example.test/candidate.git'};
  const bundle=await build({entryPoints:[fileURLToPath(new URL('./runtime/automatic-merge-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'node',mainFields:['module','main'],target:'es2022',external:['cloudflare:workers'],
    banner:{js:'import {createRequire as __fixtureCreateRequire} from "node:module"; const require = __fixtureCreateRequire("/bundle/fixture.mjs");'}});
  const runtime=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-08',compatibilityFlags:['nodejs_compat'],
    durableObjects:{WORKSPACES:{className:'AutomaticMergeFixture',useSQLite:true}},
    bindings:{WORKSPACE_ID:state.id,ACCESS_TEAM_DOMAIN:authority.policy.issuer,ACCESS_AUD:authority.policy.audience,ACCESS_OWNER_SUB:authority.policy.ownerSubject,
      ACCESS_AGENT_CLIENT_IDS:JSON.stringify(authority.policy.agentClientIds),ACCESS_REVIEWER_CLIENT_IDS:JSON.stringify([REVIEWER_CLIENT]),ACCESS_REVIEWER_SUBJECTS:'[]'},
    outboundService:()=>{assert.fail('Local fixture must never contact a real provider.');}}));
  t.after(()=>runtime.dispose());
  const call=async(path,body)=>{const response=await runtime.dispatchFetch('http://localhost'+path,body?{method:'POST',body:JSON.stringify(body)}:{});
    assert.equal(response.status,200,await response.clone().text());return response.json();};
  await call('/seed',{...snapshot,fixtureCrash:trigger==='crash after failure write'});
  assert.equal((await call('/read')).activity.pushes,0);
  const api=trigger!=='independent reviewer submission' ? {principal:authority.principal,path:'/api/projects/'+projectId+'/automatic-merge',body:{enabled:true,expectedVersion:0}}
    : {principal:testReviewerAuthority().principal,path:'/api/runs/'+run.id+'/code-review',body:assessment};
  await call('/api',{...api,policy:authority.policy,forbiddenSecrets:[],method:'POST',key:'trigger'});
  if(trigger==='crash after failure write') {
    // A real DO abort disconnects the first waiter. Read the restarted object;
    // never resend the approval, check or merge request.
    await call('/outcome').catch(()=>{});
    const result=await call('/outcome'),stopped=result.snapshot.workspace.runs[0];
    assert.equal(result.activity.crash_once,0);assert.equal(result.activity.pushes,0);assert.equal(result.activity.checks,1);
    assert.equal(stopped.status,'accepted');assert.equal(stopped.automaticMergeStop.phase,'before-write');
    assert.equal(Object.values(result.snapshot.operations).filter(op=>op.kind==='merge'&&op.state==='failed').length,1);
    assert.equal(result.snapshot.workspace.events.filter(event=>event.type==='run.automatic_merge_stopped').length,1);
    return;
  }
  const result=await call('/outcome');
  assert.equal(result.snapshot.workspace.runs[0].status,'merged');assert.equal(result.activity.pushes,1);assert.equal(result.activity.checks,1);
  assert.equal(result.snapshot.workspace.runs[0].review.identity,undefined);assert.equal(result.snapshot.workspace.runs[0].review.policy.enabledBy.id,authority.principal.id);
  assert.equal(Object.values(result.snapshot.operations).filter(op=>op.kind==='merge'&&op.state==='complete').length,1);
  assert.equal((await call('/read')).activity.pushes,1);
});
