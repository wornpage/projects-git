import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const result=await build({entryPoints:['tests/qualification/worker.ts'],bundle:true,write:false,platform:'node',format:'cjs',external:['cloudflare:workers'],target:'node24'});
const module={exports:{}};
class Entry {constructor(ctx,env){this.ctx=ctx;this.env=env;}}
new Function('require','module','exports',result.outputFiles[0].text)(name=>name==='cloudflare:workers'?{DurableObject:Entry,WorkerEntrypoint:Entry}:require(name),module,module.exports);
function fixture(connected=false){
 const runId=crypto.randomUUID(),calls=[],index={hasProjects:connected,seedConnected:connected,forks:{[runId]:'owned-fork'}};
 const tokens=new Map([['seed',[{id:'one',state:'active'}]],['owned-fork',[{id:'two',state:'active'}]]]);
 const env={WORKSPACE_ID:'lifecycle-test',MODEL_REPOSITORY:'seed',WORKSPACES:{getByName:id=>{assert.equal(id,'lifecycle-test');return{qualificationRepositoryIndex:async()=>index};}},
 ARTIFACTS:{create:async(name,options)=>{calls.push({kind:'create',name,options});return{name};},get:async name=>{
   assert.ok(tokens.has(name));calls.push({kind:'get',name});return{[Symbol.dispose](){},info:async()=>({remote:'https://artifacts.example.test/'+name,defaultBranch:'main'}),
    createToken:async(scope,ttl)=>{calls.push({kind:'token',scope,ttl});return{plaintext:'fixture-secret',expiresAt:'fixture'};},
    listTokens:async()=>({tokens:tokens.get(name)}),revokeToken:async id=>{tokens.get(name).find(t=>t.id===id).state='revoked';}};
 }} };
 return {control:new module.exports.QualificationControl({},env),calls,index,runId,tokens};
}
test('private lifecycle helper cannot bootstrap a connected seed or write to a candidate',async()=>{
 const f=fixture(true);await assert.rejects(f.control.lifecycleCreateSeed(),/before connecting/);
 await assert.rejects(f.control.lifecycleRepository(undefined,'write'),/unconnected seed/);
 await assert.rejects(f.control.lifecycleRepository(f.runId,'write'),/unconnected seed/);
 assert.deepEqual(f.calls,[]);
});
test('private lifecycle helper resolves retained fork IDs and refuses foreign resources',async()=>{
 const f=fixture();await assert.rejects(f.control.lifecycleRepository(crypto.randomUUID(),'read'),/unconnected seed/);
 await assert.rejects(f.control.lifecycleRepository(f.runId,'admin'),/Invalid/);assert.deepEqual(f.calls,[]);
 const credential=await f.control.lifecycleRepository(f.runId,'read');assert.equal(credential.name,'owned-fork');
 assert.deepEqual(f.calls,[{kind:'get',name:'owned-fork'},{kind:'token',scope:'read',ttl:300}]);
});
test('private lifecycle bootstrap names only its configured seed and retirement stays in its repository set',async()=>{
 const f=fixture();await f.control.lifecycleCreateSeed();assert.equal(f.calls[0].name,'seed');assert.equal(f.calls[0].options.setDefaultBranch,'main');
 const retired=await f.control.lifecycleRetire();assert.deepEqual(retired.map(r=>r.name),['seed','owned-fork']);assert.ok(retired.every(r=>r.tokens.every(t=>t.state==='revoked')));
});
