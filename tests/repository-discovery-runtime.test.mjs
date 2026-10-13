import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {testAuthority,testReviewerAuthority,AGENT_CLIENT} from './helpers/hosted-authority.mjs';
const {Miniflare,convertV4MiniflareOptions}=createRequire(new URL('../node_modules/wrangler/package.json',import.meta.url))('miniflare');

test('repository picker reads through production Workerd RPC and SQLite without creating work', {timeout:20000},async t=>{
  const authority=testAuthority();
  const bundle=await build({entryPoints:[fileURLToPath(new URL('./runtime/repository-picker-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'node',mainFields:['module','main'],target:'es2022',external:['cloudflare:workers'],
    banner:{js:'import {createRequire as __fixtureCreateRequire} from "node:module"; const require = __fixtureCreateRequire("/bundle/fixture.mjs");'}});
  const runtime=new Miniflare(convertV4MiniflareOptions({name:'repository-picker-fixture',modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-08',compatibilityFlags:['nodejs_compat'],
    durableObjects:{WORKSPACES:{className:'PickerCoordinator',useSQLite:true}},serviceBindings:{ARTIFACTS:{name:'repository-picker-fixture',entrypoint:'RepositoryService'}},
    bindings:{WORKSPACE_ID:authority.policy.workspaceId,ACCESS_TEAM_DOMAIN:authority.policy.issuer,ACCESS_AUD:authority.policy.audience,ACCESS_OWNER_SUB:authority.policy.ownerSubject,ACCESS_AGENT_CLIENT_IDS:JSON.stringify(authority.policy.agentClientIds)},
    outboundService:()=>{throw Error('No outbound network allowed');}}));
  t.after(()=>runtime.dispose());
  const call=(path,search='',actor=authority)=>runtime.dispatchFetch('http://localhost/api',{method:'POST',body:JSON.stringify({...actor,method:'GET',path,search,body:{},key:''})});
  assert.equal((await call('/api/workspace')).status,200);
  const snapshot=()=>runtime.dispatchFetch('http://localhost/snapshot').then(r=>r.json());
  const before=await snapshot();
  const first=await call('/api/repositories');assert.equal(first.status,200);assert.equal(first.headers.get('cache-control'),'no-store');
  assert.deepEqual(await first.json(),{workspaceId:authority.policy.workspaceId,repositories:[{name:'starter'}],total:2,nextCursor:'page-two'});
  assert.equal((await (await call('/api/repositories','?cursor=page-two')).json()).repositories[0].name,'empty');
  assert.deepEqual(await (await call('/api/repositories/head','?name=starter')).json(),{workspaceId:authority.policy.workspaceId,name:'starter',defaultBranch:'release/next',baseCommit:'a'.repeat(40)});
  assert.equal((await (await call('/api/repositories/head','?name=empty')).json()).baseCommit,null);
  for(const actor of [testAuthority(authority.policy.workspaceId,AGENT_CLIENT),testReviewerAuthority()])for(const path of ['/api/repositories','/api/repositories/head'])assert.equal((await call(path,'',actor)).status,403);
  assert.equal((await call('/api/repositories','?namespace=foreign')).status,400);
  assert.deepEqual(await snapshot(),before);
});
