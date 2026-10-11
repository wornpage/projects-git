import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {spawnSync} from 'node:child_process';
import {credentialDirectory,readSetup} from './qualification/setup.mjs';

const valid={account:'a'.repeat(32),workerName:'operator-qualification',artifactsNamespace:'operator-fixtures',repository:'operator-seed',hostname:'operator.example.workers.dev',issuer:'https://operator.cloudflareaccess.com',audience:'b'.repeat(64),workspace:'operator-workspace',ownerEmail:'owner@example.invalid',ownerSubject:'verified-subject',ownerVerifiedAt:'2026-10-06T00:00:00Z'};
async function fixture(t){
  const base=await mkdtemp(join(tmpdir(),'publication-setup-'));
  t.after(async()=>{assert.ok(resolve(base).startsWith(resolve(tmpdir())+sep));await rm(base,{recursive:true,force:true});});
  const root=join(base,'source'),privateDir=join(base,'credentials'),qa=join(root,'qa','identity-concurrency');
  await mkdir(qa,{recursive:true});await mkdir(privateDir);
  const setupFile=join(qa,'access-setup.json');await writeFile(setupFile,JSON.stringify(valid));
  const agents=Array.from({length:8},(_,i)=>({id:`${String(i+1).padStart(8,'0')}-1111-1111-1111-111111111111`,name:'Agent '+i,client_id:(i+1).toString(16).repeat(32)+'.access',client_secret:'private-test-credential-'+i,duration:'24h'}));
  await writeFile(join(privateDir,'agents.json'),JSON.stringify(agents));
  await writeFile(join(privateDir,'reviewers.json'),JSON.stringify(Array.from({length:2},(_,index)=>({
    id:`${String(index+9).padStart(8,'0')}-1111-1111-1111-111111111111`,
    client_id:(index+9).toString(16).repeat(32)+'.access',client_secret:'private-reviewer-test-credential-'+index,duration:'24h'}))));
  return {root,privateDir,qa,setupFile,agents};
}
const configure=f=>spawnSync(process.execPath,[resolve('tests/qualification/configure.mjs')],{cwd:f.root,env:{...process.env,PROJECTS_QUALIFICATION_CREDENTIAL_DIR:f.privateDir},encoding:'utf8',windowsHide:true});

test('qualification credentials require an explicit external directory',()=>{
  const root=resolve('source-fixture');
  for(const value of [undefined,'relative',root,join(root,'private')])assert.throws(()=>credentialDirectory({PROJECTS_QUALIFICATION_CREDENTIAL_DIR:value},root));
  const outside=resolve('source-fixture-sibling');
  assert.equal(credentialDirectory({PROJECTS_QUALIFICATION_CREDENTIAL_DIR:outside},root),outside);
});
test('qualification setup refuses missing operator inputs and overlong resource names',async t=>{
  const f=await fixture(t);assert.deepEqual(await readSetup(f.setupFile),valid);
  for(const changed of [{account:''},{issuer:'https://example.invalid'},{audience:'bad'},{workerName:'a'.repeat(51)},{ownerEmail:''},{accessApplicationId:'not-an-app-id'}]){
    await writeFile(f.setupFile,JSON.stringify({...valid,...changed}));await assert.rejects(readSetup(f.setupFile));
  }
});
test('generated qualification resources use operator inputs, stay offline and omit secrets',async t=>{
  const f=await fixture(t),result=configure(f);assert.equal(result.status,0,result.stderr);
  const hosted=JSON.parse(await readFile(join(f.qa,'hosted.wrangler.jsonc'),'utf8'));
  const driver=JSON.parse(await readFile(join(f.qa,'driver.wrangler.jsonc'),'utf8'));
  assert.equal(hosted.account_id,valid.account);assert.equal(hosted.name,valid.workerName);
  assert.equal(hosted.vars.WORKSPACE_ID,valid.workspace);assert.equal(hosted.vars.MODEL_REPOSITORY,valid.repository);
  assert.equal(hosted.artifacts[0].namespace,valid.artifactsNamespace);
  assert.equal(driver.services[0].service,valid.workerName);assert.equal(driver.name,valid.workerName+'-local-driver');
  assert.deepEqual(JSON.parse(hosted.vars.ACCESS_AGENT_CLIENT_IDS),f.agents.map(a=>a.client_id));
  assert.deepEqual(JSON.parse(hosted.vars.ACCESS_REVIEWER_CLIENT_IDS),['9'.repeat(32)+'.access','a'.repeat(32)+'.access']);
  assert.ok(!JSON.stringify(hosted).includes('private-reviewer-test-credential'));
  for(const config of [hosted,driver]){assert.equal(config.workers_dev,false);assert.equal(config.preview_urls,false);}
  assert.deepEqual(hosted.routes,[]);
  const updated=await readFile(f.setupFile,'utf8');
  for(const agent of f.agents)assert.ok(![JSON.stringify(hosted),JSON.stringify(driver),updated,result.stdout,result.stderr].some(text=>text.includes(agent.client_secret)));
  const key=await readFile(join(f.qa,'.dev.vars'),'utf8');assert.match(key,/^HARNESS_KEY=[a-f0-9]{64}\n$/);
  assert.equal(configure(f).status,0);assert.equal(await readFile(join(f.qa,'.dev.vars'),'utf8'),key);
});

test('qualification refuses missing, overlapping or duplicate reviewers before writing configuration',async t=>{
 const f=await fixture(t),path=join(f.privateDir,'reviewers.json');await rm(path);assert.notEqual(configure(f).status,0);await assert.rejects(access(join(f.qa,'hosted.wrangler.jsonc')));
 const valid=[{id:'00000009-1111-1111-1111-111111111111',client_id:'9'.repeat(32)+'.access',client_secret:'first',duration:'24h'},
  {id:'00000010-1111-1111-1111-111111111111',client_id:'a'.repeat(32)+'.access',client_secret:'second',duration:'24h'}];
 for(const reviewers of [[{...valid[0],client_id:f.agents[0].client_id},valid[1]],
  [valid[0],{...valid[1],client_id:valid[0].client_id}],
  [{...valid[0],id:''},valid[1]],[valid[0]]]){
  await writeFile(path,JSON.stringify(reviewers));assert.notEqual(configure(f).status,0);await assert.rejects(access(join(f.qa,'hosted.wrangler.jsonc')));
 }
});
test('unverified owner or duplicate agents fail before writing resource configuration',async t=>{
  const f=await fixture(t);await writeFile(f.setupFile,JSON.stringify({...valid,ownerSubject:''}));
  assert.notEqual(configure(f).status,0);
  await assert.rejects(access(join(f.qa,'hosted.wrangler.jsonc')));
  await writeFile(f.setupFile,JSON.stringify(valid));f.agents[1].client_id=f.agents[0].client_id;
  await writeFile(join(f.privateDir,'agents.json'),JSON.stringify(f.agents));
  assert.notEqual(configure(f).status,0);await assert.rejects(access(join(f.qa,'hosted.wrangler.jsonc')));
  f.agents[1].client_id='2'.repeat(32)+'.access';f.agents[1].id='not-provider-id';
  await writeFile(join(f.privateDir,'agents.json'),JSON.stringify(f.agents));
  assert.notEqual(configure(f).status,0);await assert.rejects(access(join(f.qa,'hosted.wrangler.jsonc')));
});
