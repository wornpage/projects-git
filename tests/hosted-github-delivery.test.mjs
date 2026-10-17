import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir,rm,realpath} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createWorkspace,createTask,assignRun,startRun,completeRun,verifyRun,reviewRun,mergeRun} from '../src/core/workflow.mjs';
import {buildTaskHandoff} from '../src/core/handoff.mjs';
import {requirementsDigest} from '../src/core/check-definition.mjs';
import {independentReviewBinding} from '../public/review-boundary.js';
import {hostedDeliverySource,prepareHostedDelivery,openHostedDelivery,withHostedDeliveryLock,hostedDeliveryLock} from '../src/local/hosted-github-delivery.mjs';
import {deliveryArguments,runDelivery} from '../scripts/hosted-github-delivery.mjs';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonical=value=>value&&typeof value==='object'?Array.isArray(value)?value.map(canonical):Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const repin=value=>{const result=structuredClone(value);result.sha256=hash(canonical(result.payload));return result;};
async function fixture(t){
  const parent=await realpath(tmpdir()),root=await mkdtemp(path.join(parent,'projects-hosted-delivery-'));
  t.after(async()=>{assert.equal(path.dirname(await realpath(root)),parent);assert.ok(path.basename(root).startsWith('projects-hosted-delivery-'));await rm(root,{recursive:true,force:true});});
  const source=path.join(root,'source');await mkdir(source);
  const git=(...args)=>execFileSync('git',['-c','core.hooksPath='+path.join(root,'empty-hooks'),...args],{cwd:source,encoding:'utf8',windowsHide:true,env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_TERMINAL_PROMPT:'0'}}).trim();
  git('init','--initial-branch=main');git('config','user.name','Fixture');git('config','user.email','fixture@localhost.invalid');
  await writeFile(path.join(source,'app.txt'),'before\n');git('add','app.txt');git('commit','-m','Baseline');const baseCommit=git('rev-parse','HEAD');
  await writeFile(path.join(source,'app.txt'),'after\n');git('add','app.txt');git('commit','-m','Candidate');const headCommit=git('rev-parse','HEAD'),tree=git('rev-parse','HEAD^{tree}');
  const state=createWorkspace(),task=createTask(state,{title:'Fixture change',purpose:'Fixture purpose',criteria:['Fixture result'],owner:'Owner',baseCommit});
  const projectId=randomUUID();task.projectId=projectId;state.projects={[projectId]:{id:projectId,mainCommit:baseCommit}};
  const run=assignRun(state,task.id,{agent:'external',label:'Candidate',branch:'newwork/fixture'});startRun(state,run.id);
  completeRun(state,run.id,{headCommit,changedFiles:['app.txt'],diff:'Hosted whole-file preview, deliberately different from native Git diff.',summary:'Fixture'});
  verifyRun(state,run.id,{source:'independent-sandbox-checks',verified:true,commit:headCommit,taskRevision:1,passed:1,total:1,
    checks:[{name:'Fixture check',passed:true,detail:'Synthetic observation'}],exitCode:0,command:'fixture',output:'ok',verifiedAt:new Date().toISOString(),
    verification:{kind:'repository-command-checks/v1',definitionSha256:'a'.repeat(64),verifierSha256:'b'.repeat(64),inputHandoffSha256:'c'.repeat(64),requirementsSha256:requirementsDigest(task),image:'sha256:'+'d'.repeat(64),tree}});
  reviewRun(state,run.id,{decision:'accept',reviewer:'Owner',note:'Fixture approval',headCommit,taskRevision:1,ownerVersion:1,comparisons:[]});
  mergeRun(state,run.id,{headCommit,baseCommit,mergedCommit:headCommit});
  state.provider='cloudflare-artifacts';task.origin='artifacts';
  const owner={provider:'cloudflare-access',kind:'owner',issuer:'https://fixture.cloudflareaccess.com',id:'owner',workspaceId:state.id,displayName:'Fixture owner'};
  const reviewer={...owner,kind:'reviewer',id:'reviewer',displayName:'Fixture reviewer'};
  const assignment={id:randomUUID(),at:new Date().toISOString(),sourceContextId:'e'.repeat(64),reviewerIds:[reviewer.id],identity:owner};run.reviewAssignments=[assignment];
  const context=independentReviewBinding(state,run);assignment.contextId=hash(context);
  run.codeReview={id:randomUUID(),at:new Date().toISOString(),assignmentId:assignment.id,format:'projects-code-review-assessment/v2',contextId:hash(context),context,
    verdict:'pass',summary:'Synthetic independent assessment',findings:[],resolvedPriorFindingIds:[],unresolvedFindingIds:[],identity:reviewer};
  run.review.identity=owner;run.review.codeReviewId=run.codeReview.id;
  const handoff=await buildTaskHandoff(state,task.id),expected={workspaceId:state.id,runId:run.id,baseCommit,headCommit,tree,handoffSha256:handoff.sha256};
  const target=path.join(root,'delivery'),remote={base:baseCommit,head:null,pr:null,fault:null},calls=[];
  const provider={repository:'owner/private-repo',
    async repositoryInfo(){calls.push('repo');return {id:123,full_name:this.repository,private:true,permissions:{push:true},default_branch:'main'};},
    async ref(branch){return branch==='main'?remote.base:remote.head;},
    async findPullRequest(){return structuredClone(remote.pr);},async pullRequest(){return structuredClone(remote.pr);},
    async pushBranch(repository,binding){calls.push('push');assert.equal(repository,path.join(target,'objects.git'));
      const saved=JSON.parse(await readFile(path.join(target,'delivery.json'),'utf8'));assert.ok(saved.runs.find(item=>item.id===run.id).publication.pushStartedAt);assert.ok(saved.operatorApproval);
      if(remote.fault!=='push-absent')remote.head=binding.local.headCommit;if(remote.fault?.startsWith('push'))throw Error('credential-secret raw push diagnostic');},
    async createPullRequest(record){calls.push('create');
      const saved=JSON.parse(await readFile(path.join(target,'delivery.json'),'utf8'));assert.ok(saved.runs.find(item=>item.id===run.id).publication.prStartedAt);
      if(remote.fault!=='pr-absent')remote.pr={number:7,html_url:'https://github.com/owner/private-repo/pull/7',state:'open',merged:false,
        head:{sha:headCommit,ref:record.binding.headBranch,repo:{id:123}},base:{ref:'main',repo:{id:123}}};
      if(remote.fault?.startsWith('pr'))throw Error('credential-secret raw PR diagnostic');return remote.pr;}};
  const prepare=(override={})=>prepareHostedDelivery({handoffText:JSON.stringify(handoff),expected,source,directory:target,repository:provider.repository,...override});
  const open=()=>openHostedDelivery(target,provider);
  return {root,source,git,target,state,task,run,handoff,expected,prepare,open,provider,remote,calls};
}

test('offline preparation preserves exact hosted objects and provenance despite different diff formats',async t=>{
  const f=await fixture(t),result=await f.prepare();assert.equal(result.source.provenance,'historical-hosted-export');assert.equal(result.providerRequests,0);assert.deepEqual(f.calls,[]);
  assert.equal(result.source.headCommit,f.expected.headCommit);assert.equal(result.source.tree,f.expected.tree);
  const staged=path.join(f.target,'objects.git');assert.equal(execFileSync('git',['rev-parse','refs/candidates/'+f.run.id],{cwd:staged,encoding:'utf8'}).trim(),f.expected.headCommit);
  const config=await readFile(path.join(staged,'config'),'utf8');assert.ok(!config.includes('credential'));assert.ok(!config.includes(f.source));
  const delivery=await f.open();assert.equal(delivery.receipt().publication,null);assert.equal(delivery.receipt().authenticatedHostedAuthority,false);
  assert.ok(!JSON.stringify(delivery.receipt()).includes(f.source));assert.ok(!JSON.stringify(delivery.receipt()).includes(f.target));
});

test('wrong pins, unsupported nested fields, duplicate IDs and stale evidence/review/owner bindings refuse',async t=>{
  const f=await fixture(t);
  for(const change of [{workspaceId:'other'}, {runId:randomUUID()}, {handoffSha256:'0'.repeat(64)}, {baseCommit:'0'.repeat(40)}, {headCommit:'0'.repeat(40)}, {tree:'0'.repeat(40)}])
    await assert.rejects(hostedDeliverySource(JSON.stringify(f.handoff),{...f.expected,...change}));
  for(const mutate of [
    h=>{h.payload.runs[0].unexpected='secret';},h=>{h.payload.runs.push(h.payload.runs[0]);},h=>{h.payload.task.revision++;},
    h=>{h.payload.runs[0].evidence.passed=0;},h=>{h.payload.runs[0].evidence.verification.requirementsSha256='0'.repeat(64);},
    h=>{h.payload.runs[0].review.ownerVersion++;},h=>{h.payload.runs[0].review.codeReviewId=randomUUID();},
    h=>{h.payload.runs[0].codeReview.context.headCommit='0'.repeat(40);},h=>{h.payload.runs[0].codeReview.verdict='fail';},
    h=>{h.payload.runs[0].codeReview.identity.kind='agent';},h=>{h.payload.runs[0].review.identity.kind='agent';},
    h=>{h.payload.runs[0].status='accepted';}
  ]){const h=structuredClone(f.handoff);mutate(h);const pinned=repin(h);await assert.rejects(hostedDeliverySource(JSON.stringify(pinned),{...f.expected,handoffSha256:pinned.sha256}));}
});

test('wrong tree, changed paths, missing objects, unrelated base and reused staging destinations refuse',async t=>{
  const f=await fixture(t);
  const h=structuredClone(f.handoff);h.payload.runs[0].changedFiles=['forged.txt'];const pinned=repin(h);
  await assert.rejects(f.prepare({handoffText:JSON.stringify(pinned),expected:{...f.expected,handoffSha256:pinned.sha256}}));
  await assert.rejects(f.prepare({source:f.root}));
  await assert.rejects(f.prepare({directory:path.join(f.source,'private-delivery')}));
  // A fully consistent historical record still cannot substitute an unrelated local base.
  f.git('checkout','--orphan','other');f.git('rm','-rf','.');await writeFile(path.join(f.source,'other.txt'),'other');f.git('add','.');f.git('commit','-m','Other history');
  const unrelated=f.git('rev-parse','HEAD'),other=structuredClone(f.handoff);other.payload.task.baseCommit=unrelated;other.payload.runs[0].baseCommit=unrelated;
  other.payload.runs[0].codeReview.context.baseCommit=unrelated;other.payload.runs[0].codeReview.contextId=hash(other.payload.runs[0].codeReview.context);
  other.payload.runs[0].reviewAssignments[0].contextId=other.payload.runs[0].codeReview.contextId;const otherPin=repin(other);
  await assert.rejects(f.prepare({handoffText:JSON.stringify(otherPin),expected:{...f.expected,baseCommit:unrelated,handoffSha256:otherPin.sha256}}));
  await f.prepare();await assert.rejects(f.prepare());
});

test('operator-local CLI fixture E2E previews, approves exact target, publishes once and retains local receipt',async t=>{
  const f=await fixture(t),file=path.join(f.root,'handoff.json');await writeFile(file,JSON.stringify(f.handoff));
  const args=['prepare','--handoff',file,'--sha256',f.handoff.sha256,'--workspace',f.state.id,'--run',f.run.id,'--base',f.expected.baseCommit,'--head',f.expected.headCommit,'--tree',f.expected.tree,'--source',f.source,'--directory',f.target,'--repository',f.provider.repository];
  const ports={providerFactory:()=>f.provider};await runDelivery(args,ports);
  const common=['--directory',f.target,'--repository',f.provider.repository],preview=await runDelivery(['preview',...common],ports);
  assert.deepEqual(f.calls.filter(call=>['push','create'].includes(call)),[]);assert.match(preview.preview.body,/not authenticated/);
  const publish=['publish',...common,'--preview',preview.preview.id,'--request',randomUUID(),'--approve',preview.approvalSha256];
  await assert.rejects(runDelivery([...publish.slice(0,-1),'0'.repeat(64)],ports));
  const record=await runDelivery(publish,ports);assert.equal(record.publication.status,'open');assert.equal(record.source.provenance,'historical-hosted-export');
  assert.equal(record.operatorApproval.sha256,preview.approvalSha256);assert.deepEqual(f.calls.filter(call=>['push','create'].includes(call)),['push','create']);
  await runDelivery(publish,ports);assert.deepEqual(f.calls.filter(call=>['push','create'].includes(call)),['push','create']);
  assert.ok(!JSON.stringify(record).includes(f.source));assert.ok(!JSON.stringify(record).includes(f.target));
});

for(const fault of ['push-lost','push-absent','pr-lost','pr-absent'])test('restart reconciles '+fault+' without replaying attempted writes',async t=>{
  const f=await fixture(t);await f.prepare();let delivery=await f.open();const preview=await delivery.preview(),id=randomUUID();f.remote.fault=fault;
  let record=await delivery.publish({previewId:preview.preview.id,requestId:id,approvalSha256:preview.approvalSha256});assert.equal(record.status,'needs_attention');
  delivery=await f.open();f.remote.fault=null;record=await delivery.resume(id,preview.approvalSha256);
  assert.equal(record.status,fault.endsWith('absent')?'needs_attention':'open');
  assert.equal(f.calls.filter(call=>call==='push').length,1);assert.ok(f.calls.filter(call=>call==='create').length<=1);
  const receipt=JSON.stringify(delivery.receipt());assert.ok(!receipt.includes('credential-secret'));assert.ok(!receipt.includes(f.source));assert.ok(!receipt.includes(f.target));
});

test('changed upstream, decision, export and staged objects never authorize later writes',async t=>{
  const f=await fixture(t);await f.prepare();const delivery=await f.open(),preview=await delivery.preview();
  f.remote.base='0'.repeat(40);const record=await delivery.publish({previewId:preview.preview.id,requestId:randomUUID(),approvalSha256:preview.approvalSha256});
  assert.equal(record.error.code,'github_base_changed');assert.ok(!f.calls.includes('push'));
  const stateFile=path.join(f.target,'delivery.json'),state=JSON.parse(await readFile(stateFile,'utf8'));state.runs[0].review.note='changed';await writeFile(stateFile,JSON.stringify(state));
  await assert.rejects(f.open());
  state.runs[0].review.note=f.run.review.note;await writeFile(stateFile,JSON.stringify(state));
  await writeFile(path.join(f.target,'handoff.json'),JSON.stringify({...f.handoff,sha256:'0'.repeat(64)}));await assert.rejects(f.open());
});

test('corrupt staged blobs and a different GitHub target cannot use the previous source approval',async t=>{
  const f=await fixture(t);await f.prepare();let delivery=await f.open();const prepared=await delivery.preview();
  await assert.rejects(openHostedDelivery(f.target,{...f.provider,repository:'owner/another-repo'}));
  const blob=f.git('rev-parse',f.expected.headCommit+':app.txt'),file=path.join(f.target,'objects.git','objects',blob.slice(0,2),blob.slice(2));
  await writeFile(file,Buffer.from('corrupt object'));
  const result=await delivery.publish({previewId:prepared.preview.id,requestId:randomUUID(),approvalSha256:prepared.approvalSha256});
  assert.equal(result.status,'needs_attention');assert.ok(!f.calls.includes('push'));
});

test('package locks serialize clients; live and mismatched stale locks cannot be released',async t=>{
  const f=await fixture(t);await f.prepare();
  await withHostedDeliveryLock(f.target,async()=>{
    await assert.rejects(withHostedDeliveryLock(f.target,async()=>{}));const lock=await hostedDeliveryLock(f.target);
    await assert.rejects(hostedDeliveryLock(f.target,randomUUID()));await assert.rejects(hostedDeliveryLock(f.target,lock.id));
  });
  await withHostedDeliveryLock(f.target,async()=>{});
});

test('an expired preview cannot persist approval or prevent a fresh deliberate preview',async t=>{
  const f=await fixture(t);await f.prepare();let time=Date.now();
  const delivery=await openHostedDelivery(f.target,f.provider,{now:()=>time}),old=await delivery.preview();time+=300001;
  await assert.rejects(delivery.publish({previewId:old.preview.id,requestId:randomUUID(),approvalSha256:old.approvalSha256}));
  assert.equal(delivery.receipt().operatorApproval,null);assert.equal(delivery.receipt().publication,null);
  const fresh=await delivery.preview(),record=await delivery.publish({previewId:fresh.preview.id,requestId:randomUUID(),approvalSha256:fresh.approvalSha256});assert.equal(record.status,'open');
});

test('CLI options reject ambiguous input and help never opens a provider',async()=>{
  for(const args of [[],['publish'],['preview','--directory','a','--repository','owner/repo','--repository','other/repo'],['--help','extra'],['status','--directory','a','--repository','owner/repo','--secret','never-print']])assert.throws(()=>deliveryArguments(args));
  const result=await runDelivery(['--help'],{providerFactory:()=>assert.fail('Help contacted a provider')});assert.match(result.help,/historical hosted merged candidate/);
});
