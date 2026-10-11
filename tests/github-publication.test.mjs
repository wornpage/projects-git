import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkspace, createTask, assignRun, startRun, completeRun, verifyRun, reviewRun, mergeRun} from '../src/core/workflow.mjs';
import {GitHubPublication, githubRepository, githubBranch} from '../src/local/github-publication.mjs';
import {buildTaskHandoff} from '../src/core/handoff.mjs';

function fixture() {
  let state = createWorkspace();
  const task = createTask(state, {title:'Useful change', purpose:'Improve the project', criteria:['Expected behavior'], owner:'Owner', baseCommit:'a'.repeat(40)});
  const run = assignRun(state, task.id, {agent:'external', label:'Agent', branch:'newwork/test'});
  startRun(state, run.id); completeRun(state, run.id, {headCommit:'b'.repeat(40), changedFiles:['app.py'], diff:'+change', summary:'Result'});
  verifyRun(state, run.id, {source:'independent-sandbox-checks', verified:true, commit:run.headCommit, taskRevision:1, passed:1, total:1,
    checks:[{name:'Contract', passed:true, detail:'Expected output observed'}], exitCode:0, command:'python', output:'ok', verifiedAt:new Date().toISOString()});
  reviewRun(state, run.id, {decision:'accept', reviewer:'Owner', note:'Approved', headCommit:run.headCommit, taskRevision:1, ownerVersion:1, comparisons:[]});
  mergeRun(state, run.id, {headCommit:run.headCommit, baseCommit:task.baseCommit, mergedCommit:run.headCommit});
  task.origin = 'connected-git';
  const remote = {repo:{id:123, full_name:'owner/repo', private:true, permissions:{push:true}, default_branch:'main'}, base:task.baseCommit, branch:null, pr:null, fault:null};
  const calls = [];
  let time = Date.now();
  const provider = {repository:'owner/repo',
    async repositoryInfo() {calls.push('repo');return structuredClone(remote.repo);},
    async ref(branch) {calls.push('ref');return branch === 'main' ? remote.base : remote.branch;},
    async findPullRequest() {calls.push('find');return structuredClone(remote.pr);},
    async pullRequest() {calls.push('read-pr');return structuredClone(remote.pr);},
    async pushBranch(path, binding) {
      calls.push('push');assert.equal(path,'owned-repository');assert.ok(state.runs[0].publication.pushStartedAt);
      if (remote.fault !== 'push-absent') remote.branch = binding.local.headCommit;
      if (remote.fault?.startsWith('push')) throw new Error('Lost push response');
    },
    async createPullRequest(record) {
      calls.push('create');assert.ok(state.runs[0].publication.prStartedAt);
      if (remote.fault !== 'pr-absent') remote.pr = {number:7, html_url:'https://github.com/owner/repo/pull/7', state:'open', merged:false,
        head:{sha:record.binding.local.headCommit, ref:record.binding.headBranch, repo:{id:123}}, base:{ref:'main', repo:{id:123}}};
      if (remote.fault?.startsWith('pr')) throw new Error('Lost PR response');
      return structuredClone(remote.pr);
    }};
  const ports = {provider, read:()=>state, save:change=>{const next=structuredClone(state);change(next);next.version++;state=next;},
    source:async()=> 'owned-repository', now:()=>time};
  const publisher = new GitHubPublication(ports);
  return {publisher, ports, state:()=>state, taskId:task.id, runId:run.id, remote, calls, advance:ms=>{time+=ms;},
    request:async()=>({previewId:(await publisher.preview(run.id)).id,requestId:crypto.randomUUID()})};
}

test('preview is local-only preparation; explicit publication binds exact source and preserves a separate GitHub state',async()=>{
  const f=fixture(),request=await f.request();
  assert.equal(f.calls.includes('push'),false);assert.equal(f.state().runs[0].publication,undefined);
  const record=await f.publisher.publish(f.runId,request);
  assert.equal(record.status,'open');assert.equal(record.binding.local.headCommit,'b'.repeat(40));
  assert.deepEqual(f.calls.filter(call=>['push','create'].includes(call)),['push','create']);
  assert.equal(f.state().tasks[0].status,'merged');assert.equal(record.pr.mergeCommit,null);
  f.remote.pr={...f.remote.pr,state:'closed',merged:true,merged_at:new Date().toISOString(),merge_commit_sha:'d'.repeat(40)};
  const refreshed=await f.publisher.refresh(f.runId,record.id);
  assert.equal(refreshed.status,'merged');assert.equal(refreshed.pr.mergeCommit,'d'.repeat(40));
  assert.equal(f.state().tasks[0].mergedCommit,'b'.repeat(40));
});

test('duplicate publication returns its retained receipt without repeating provider reads or writes; changed requests conflict',async()=>{
  const f=fixture(),request=await f.request();await f.publisher.publish(f.runId,request);const count=f.calls.length;
  assert.equal((await f.publisher.publish(f.runId,request)).status,'open');assert.equal(f.calls.length,count);
  await assert.rejects(f.publisher.publish(f.runId,{...request,previewId:crypto.randomUUID()}),{code:'idempotency_conflict'});
  await assert.rejects(f.publisher.publish(crypto.randomUUID(),request),{code:'idempotency_conflict'});
});

for(const fault of ['push-lost','pr-lost'])test(`restart reconciles ${fault} without repeating a Git write or PR creation`,async()=>{
  const f=fixture(),request=await f.request();f.remote.fault=fault;
  const interrupted=await f.publisher.publish(f.runId,request);assert.equal(interrupted.status,'needs_attention');
  const history=interrupted.observations.length;f.remote.fault=null;
  const restarted=new GitHubPublication(f.ports);
  const recovered=await restarted.continue(f.runId,interrupted.id);
  assert.equal(recovered.status,'open');assert.ok(recovered.observations.length>history);
  assert.equal(f.calls.filter(c=>c==='push').length,1);assert.equal(f.calls.filter(c=>c==='create').length,1);
  assert.ok(recovered.observations.some(item=>item.status==='needs_attention'));
});

for(const fault of ['push-absent','pr-absent'])test(`${fault} is retained as uncertain and never resent even after explicit continuation`,async()=>{
  const f=fixture(),request=await f.request();f.remote.fault=fault;
  const first=await f.publisher.publish(f.runId,request);f.remote.fault=null;
  const observed=await f.publisher.refresh(f.runId,first.id);
  assert.equal(observed.status,'needs_attention');assert.ok(observed.error);
  const second=await f.publisher.continue(f.runId,first.id);
  assert.equal(second.status,'needs_attention');
  assert.equal(f.calls.filter(c=>c==='push').length,1);
  assert.equal(f.calls.filter(c=>c==='create').length,fault==='push-absent'?0:1);
});

test('changed upstream refuses before provider writes and stale or forged previews never reserve a publication',async()=>{
  const f=fixture(),request=await f.request();f.remote.base='c'.repeat(40);
  const refused=await f.publisher.publish(f.runId,request);assert.equal(refused.error.code,'github_base_changed');
  assert.equal(f.calls.includes('push'),false);assert.equal(f.calls.includes('create'),false);
  const expired=fixture(),old=await expired.request();expired.advance(300_001);
  await assert.rejects(expired.publisher.publish(expired.runId,old),{code:'publication_preview_expired'});
  assert.equal(expired.state().runs[0].publication,undefined);
  await assert.rejects(expired.publisher.publish(expired.runId,{...old,repository:'attacker/repo'}),{code:'publication_input'});
  const corrupted=fixture(),malformed=await corrupted.request();corrupted.state().runs[0].publicationPreview.expiresAt='invalid';
  await assert.rejects(corrupted.publisher.publish(corrupted.runId,malformed),{code:'publication_preview_expired'});
  assert.equal(corrupted.state().runs[0].publication,undefined);
});

test('public, renamed, read-only and unapproved destinations fail closed',async()=>{
  for(const change of [{private:false},{full_name:'other/repo'},{permissions:{push:false}},{archived:true}]){
    const f=fixture();Object.assign(f.remote.repo,change);await assert.rejects(f.publisher.preview(f.runId));
    assert.equal(f.calls.includes('push'),false);assert.equal(f.state().runs[0].publicationPreview,undefined);
  }
  const f=fixture();f.state().runs[0].review.ownerVersion=99;
  await assert.rejects(f.publisher.preview(f.runId),{code:'publication_not_approved'});assert.deepEqual(f.calls,[]);
});

test('source or decision changes during provider reads are caught again immediately before pushing',async()=>{
  const f=fixture(),request=await f.request();
  f.ports.source=async()=>{f.state().runs[0].review.note='Changed after preview';return 'owned-repository';};
  const publisher=new GitHubPublication(f.ports);
  const record=await publisher.publish(f.runId,request);
  assert.equal(record.status,'needs_attention');assert.equal(f.calls.includes('push'),false);
});

test('a changed remote branch or PR never gets overwritten or represented as the approved merge',async()=>{
  const f=fixture(),request=await f.request();f.remote.branch='c'.repeat(40);
  const changed=await f.publisher.publish(f.runId,request);assert.equal(changed.status,'changed');assert.equal(f.calls.includes('push'),false);
  const g=fixture(),sent=await g.publisher.publish(g.runId,await g.request());
  g.remote.pr.head.sha='c'.repeat(40);g.remote.pr.state='closed';g.remote.pr.merged=true;g.remote.pr.merged_at=new Date().toISOString();g.remote.pr.merge_commit_sha='d'.repeat(40);
  assert.equal((await g.publisher.refresh(g.runId,sent.id)).status,'changed');
});

test('handoff exports retain publication links and history without internal or secret fields',async()=>{
  const f=fixture();await f.publisher.publish(f.runId,await f.request());
  const record=f.state().runs[0].publication;record.secret='not-exported';record.binding.local.path='not-exported';record.pr.token='not-exported';record.observations[0].private='not-exported';
  const handoff=await buildTaskHandoff(f.state(),f.taskId);
  assert.equal(handoff.payload.runs[0].publication.pr.number,7);assert.ok(handoff.payload.runs[0].publication.observations.length>0);
  assert.equal(JSON.stringify(handoff).includes('not-exported'),false);
});

test('malformed merge observations stay unconfirmed while a deleted branch does not erase a valid merged PR',async()=>{
  const f=fixture(),sent=await f.publisher.publish(f.runId,await f.request());
  f.remote.pr={...f.remote.pr,state:'closed',merged:'true',merged_at:new Date().toISOString(),merge_commit_sha:'d'.repeat(40)};
  assert.equal((await f.publisher.refresh(f.runId,sent.id)).error.code,'github_pr_invalid');
  f.remote.pr.merged=true;f.remote.pr.merged_at=0;
  assert.equal((await f.publisher.refresh(f.runId,sent.id)).status,'needs_attention');
  f.remote.pr.merged_at=new Date().toISOString();f.remote.branch=null;
  assert.equal((await f.publisher.refresh(f.runId,sent.id)).status,'merged');
});

test('configuration refuses URLs and unsafe refs rather than inventing a target',()=>{
  for(const value of ['', '../repo', 'https://github.com/owner/repo', 'owner/repo.git', 'Owner/Repo.GIT'])assert.throws(()=>githubRepository(value));
  for(const value of ['-main','../main','main.lock','refs//main','main~1'])assert.throws(()=>githubBranch(value));
});
