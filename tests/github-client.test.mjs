import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {GitHubClient} from '../src/local/github-client.mjs';

function transport(response, error = null, stderr = '') {
  const calls=[];
  return {calls, execute:(binary,args,options,callback)=>{
    const stdin=new PassThrough();let input='';stdin.on('data',data=>{input+=data;});
    stdin.on('finish',()=>{calls.push({binary,args,options,input});queueMicrotask(()=>callback(error,response,stderr));});
    return {stdin};
  }};
}

test('push uses an exact commit, creation-only ref guard and bounded credential-isolated process',async()=>{
  const t=transport('ok'),client=new GitHubClient('Owner/Repo',{execute:t.execute,env:{PATH:'trusted',GIT_CONFIG_COUNT:'7',GIT_SSL_NO_VERIFY:'true',GH_DEBUG:'api',GH_TOKEN:'secret',UNRELATED_SECRET:'private'}});
  await client.pushBranch('owned-repository',{repository:'owner/repo',local:{headCommit:'b'.repeat(40)},headBranch:'newwork/projects-test'});
  const call=t.calls[0];assert.equal(call.binary,'git');assert.equal(call.options.cwd,'owned-repository');
  assert.ok(call.args.includes('--force-with-lease=refs/heads/newwork/projects-test:'));
  assert.equal(call.args.at(-1),'b'.repeat(40)+':refs/heads/newwork/projects-test');
  assert.equal(call.args.at(-2),'https://github.com/owner/repo.git');
  assert.ok(!call.args.includes('--force'));assert.ok(call.args.includes('http.followRedirects=false'));
  assert.ok(call.args.includes('credential.helper='));assert.ok(call.args.includes('credential.helper=!gh auth git-credential'));
  assert.equal(call.options.env.GIT_CONFIG_COUNT,undefined);assert.equal(call.options.env.GH_DEBUG,undefined);assert.equal(call.options.env.GIT_SSL_NO_VERIFY,undefined);
  assert.equal(call.options.env.UNRELATED_SECRET,undefined);assert.equal(call.options.env.GH_TOKEN,'secret');
  assert.equal(JSON.stringify(call.args).includes('secret'),false);assert.equal(call.options.timeout,30000);assert.equal(t.calls.length,1);
});

test('PR input is structured stdin and never changes readiness, merges or adds shell commands',async()=>{
  const t=transport('{"number":1}'),client=new GitHubClient('owner/repo',{execute:t.execute});
  const body='Untrusted $(command) and `code`\nnew line';
  await client.createPullRequest({id:'receipt',title:'A change',body,binding:{repository:'owner/repo',headBranch:'newwork/projects-test',baseBranch:'main'}});
  const call=t.calls[0],sent=JSON.parse(call.input);
  assert.equal(call.binary,'gh');assert.ok(call.args.includes('--input'));assert.equal(call.args.includes(body),false);
  assert.equal(sent.body,body+'\n\n<!-- projects-publication:receipt -->');assert.equal(sent.draft,false);assert.equal(sent.maintainer_can_modify,false);
  assert.equal(call.options.shell,undefined);assert.equal(t.calls.length,1);
});

test('missing refs are distinguished from access failures and provider errors do not disclose raw secrets',async()=>{
  const missing=transport('',new Error('failed'),'gh: Not Found (HTTP 404)');
  assert.equal(await new GitHubClient('owner/repo',{execute:missing.execute}).ref('main'),null);
  const denied=transport('private token',new Error('secret'),'gh: forbidden (HTTP 403) token=private');
  await assert.rejects(new GitHubClient('owner/repo',{execute:denied.execute}).ref('main'),error=>error.code==='github_provider_failed'&&!error.message.includes('token='));
  assert.equal(denied.calls.length,1);
});

test('unexpected refs, malformed JSON and ambiguous PRs refuse',async()=>{
  const wrong=transport(JSON.stringify({ref:'refs/heads/other',object:{type:'commit',sha:'a'.repeat(40)}}));
  await assert.rejects(new GitHubClient('owner/repo',{execute:wrong.execute}).ref('main'));
  const bad=transport('not json');await assert.rejects(new GitHubClient('owner/repo',{execute:bad.execute}).repositoryInfo());
  const many=transport('[{"number":1},{"number":2}]');await assert.rejects(new GitHubClient('owner/repo',{execute:many.execute}).findPullRequest('newwork/projects-test'));
});
