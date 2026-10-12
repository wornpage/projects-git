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

for (const trigger of ['owner policy switch','independent reviewer submission','crash after failure write','revoked reviewer after forwarded policy',
  'revoked after restart','updated authority binding','unavailable authority','source-read','verification','before-push','uncertain']) test(`production Workerd alarm and SQLite retain the outcome for ${trigger}`, {timeout:20000}, async t=>{
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
  const explicitAlarm=!['owner policy switch','independent reviewer submission','crash after failure write'].includes(trigger);
  if(explicitAlarm)setAutomaticMergePolicy(state,projectId,{enabled:true,expectedVersion:0},authority.principal);
  snapshot.repositories[task.id]='target';snapshot.forks[run.id]={name:'candidate',remote:'https://artifacts.example.test/candidate.git'};
  const bundle=await build({entryPoints:[fileURLToPath(new URL('./runtime/automatic-merge-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'node',mainFields:['module','main'],target:'es2022',external:['cloudflare:workers'],
    banner:{js:'import {createRequire as __fixtureCreateRequire} from "node:module"; const require = __fixtureCreateRequire("/bundle/fixture.mjs");'}});
  const options={name:'automatic-fixture',modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-08',compatibilityFlags:['nodejs_compat'],
    durableObjects:{WORKSPACES:{className:'AutomaticMergeFixture',useSQLite:true},POLICY_STATE:{className:'PolicyState',useSQLite:true}},
    serviceBindings:{CURRENT_POLICY:{name:'automatic-fixture',entrypoint:'FixturePolicy'}},
    bindings:{WORKSPACE_ID:state.id,ACCESS_TEAM_DOMAIN:authority.policy.issuer,ACCESS_AUD:authority.policy.audience,ACCESS_OWNER_SUB:authority.policy.ownerSubject,
      ACCESS_AGENT_CLIENT_IDS:JSON.stringify(authority.policy.agentClientIds),ACCESS_REVIEWER_CLIENT_IDS:JSON.stringify([REVIEWER_CLIENT]),ACCESS_REVIEWER_SUBJECTS:'[]'},
    outboundService:()=>{assert.fail('Local fixture must never contact a real provider.');}};
  const bindingOptions=reviewers=>convertV4MiniflareOptions({workers:[
    {...options,serviceBindings:{CURRENT_POLICY:{name:'authority',entrypoint:'WorkspacePolicy'}}},
    {name:'authority',modules:true,script:bundle.outputFiles[0].text,compatibilityDate:options.compatibilityDate,compatibilityFlags:options.compatibilityFlags,
      bindings:{...options.bindings,ACCESS_REVIEWER_CLIENT_IDS:JSON.stringify(reviewers)},outboundService:options.outboundService}
  ]});
  const runtime=new Miniflare(trigger==='updated authority binding'?bindingOptions([REVIEWER_CLIENT]):convertV4MiniflareOptions(options));
  t.after(()=>runtime.dispose());
  const call=async(path,body)=>{const response=await runtime.dispatchFetch('http://localhost'+path,body?{method:'POST',body:JSON.stringify(body)}:{});
    assert.equal(response.status,200,await response.clone().text());return response.json();};
  const policyEnv={WORKSPACE_ID:state.id,ACCESS_TEAM_DOMAIN:authority.policy.issuer,ACCESS_AUD:authority.policy.audience,ACCESS_OWNER_SUB:authority.policy.ownerSubject,
    ACCESS_AGENT_CLIENT_IDS:JSON.stringify(authority.policy.agentClientIds),ACCESS_REVIEWER_CLIENT_IDS:JSON.stringify([REVIEWER_CLIENT]),ACCESS_REVIEWER_SUBJECTS:'[]'};
  await call('/policy',{env:policyEnv});
  await call('/seed',{...snapshot,fixtureCrash:trigger==='crash after failure write',fixturePhase:trigger});
  assert.equal((await call('/read')).activity.pushes,0);
  if(trigger==='updated authority binding'){
    const before=await call('/read');
    // Update actual Worker bindings, not the PolicyState substitute. The caller
    // retains the old allowlist; production WorkspacePolicy runs unchanged.
    await runtime.setOptions(bindingOptions([]));
    assert.deepEqual(await call('/read'),before,'The same SQLite workspace survives the authority binding update');
    const result=await call('/alarm');assert.equal(result.activity.checks,0);assert.equal(result.activity.pushes,0);
    assert.equal(result.snapshot.workspace.runs[0].review,null);
    assert.deepEqual(result.snapshot,before.snapshot);return;
  }
  if(trigger==='revoked reviewer after forwarded policy'){
    await call('/policy',{env:{...policyEnv,ACCESS_REVIEWER_CLIENT_IDS:'[]'}});
    const revoked={...authority.policy,reviewerClientIds:[]};
    const response=await runtime.dispatchFetch('http://localhost/api',{method:'POST',body:JSON.stringify({
      principal:authority.principal,policy:revoked,forbiddenSecrets:[],method:'POST',key:'revoked-owner-review',
      path:'/api/runs/'+run.id+'/review',body:{decision:'accept',note:'Must refuse revoked review',headCommit:run.headCommit,taskRevision:task.revision,ownerVersion:task.ownerVersion,comparisons:[]}
    })});
    assert.equal(response.status,409);assert.equal((await response.json()).code,'REVIEWER_ACCESS_CHANGED');
    assert.equal((await call('/read')).activity.pushes,0);
    const result=await call('/alarm');
    console.log(JSON.stringify({probe:'workerd-revocation-followed-by-alarm',status:result.snapshot.workspace.runs[0].status,checks:result.activity.checks,pushes:result.activity.pushes}));
    assert.equal(result.activity.pushes,0,'The alarm must not use the stale environment after trusted forwarded policy revoked the reviewer.');
    assert.equal(result.activity.checks,0);return;
  }
  if(trigger==='revoked after restart'){
    await call('/policy',{env:{...policyEnv,ACCESS_REVIEWER_CLIENT_IDS:'[]'}});
    await call('/restart').catch(()=>{});
    // An older forwarded read cannot overwrite the independent policy source.
    await call('/api',{...authority,method:'GET',path:'/api/review-inbox',body:{},key:''});
    const result=await call('/alarm');assert.equal(result.activity.checks,0);assert.equal(result.activity.pushes,0);
    assert.equal(result.snapshot.workspace.runs[0].review,null);return;
  }
  if(trigger==='unavailable authority'){
    await call('/policy',{unavailable:true});const response=await runtime.dispatchFetch('http://localhost/alarm');assert.equal(response.status,500);
    const result=await call('/read');assert.equal(result.activity.checks,0);assert.equal(result.activity.pushes,0);assert.equal(result.snapshot.workspace.runs[0].review,null);return;
  }
  if(['source-read','verification','before-push','uncertain'].includes(trigger)){
    const result=await call('/alarm'),run=result.snapshot.workspace.runs[0];
    assert.equal(result.activity.checks,trigger==='source-read'?0:1);assert.equal(result.activity.pushes,trigger==='uncertain'?1:0);
    assert.equal(run.automaticMergeStop.phase,trigger==='uncertain'?'uncertain-write':'before-write');
    if(trigger==='uncertain'){
      await call('/policy',{unavailable:true});
      const response=await call('/api',{principal:authority.principal,policy:{...authority.policy,reviewerClientIds:[]},method:'POST',path:'/api/runs/'+run.id+'/merge',body:{headCommit:run.headCommit},key:''});
      assert.equal(response.runs[0].status,'merged');const after=await call('/read');assert.equal(after.activity.checks,1);assert.equal(after.activity.pushes,1);
    }
    return;
  }
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
