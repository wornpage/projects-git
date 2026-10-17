import test from 'node:test';
import assert from 'node:assert/strict';
import {Client,InMemoryTransport} from '@modelcontextprotocol/client';
import {serveStdio} from '@modelcontextprotocol/server/stdio';
import {createTrialMcpServer} from '../src/local/trial-mcp.mjs';
async function setup(t,role,execute){const [a,b]=InMemoryTransport.createLinkedPair();const handle=serveStdio(()=>createTrialMcpServer({connection:{role},execute,sanitize:text=>String(text),serialize:JSON.stringify}),{transport:b});const client=new Client({name:'trial-test',version:'1'},{versionNegotiation:{mode:{pin:'2026-07-28'}}});t.after(async()=>{await client.close();await handle.close();});await client.connect(a);return client;}
test('trial builder and reviewer expose distinct tool sets without owner actions',async t=>{
  const a=await setup(t,'agent',async()=>({})),b=await setup(t,'reviewer',async()=>({}));
  const at=(await a.listTools()).tools.map(t=>t.name),bt=(await b.listTools()).tools.map(t=>t.name);
  assert.equal(at.length,7);assert.equal(bt.length,3);assert.ok(!at.some(name=>/assess|merge|accept/.test(name)));assert.ok(!bt.some(name=>/claim|publish|merge|accept/.test(name)));
});
test('trial MCP validates mutation arguments before invoking the client and preserves exact source',async t=>{
  const calls=[],client=await setup(t,'agent',async(name,args)=>{calls.push({name,args});return{runId:args.run};});
  const name='projects_git_trial_publish',args={run:crypto.randomUUID(),requestId:crypto.randomUUID(),headCommit:'a'.repeat(40),source:'export const checkoutTotal = () => 0;'};
  const result=await client.callTool({name,arguments:args});assert.ok(!result.isError);assert.deepEqual(calls,[{name:'publish',args}]);
  const refused=await client.callTool({name,arguments:{...args,owner:true}});assert.equal(refused.isError,true);assert.equal(calls.length,1);
});
test('reviewer assessment uses the existing SHA-256 context contract',async t=>{
  const calls=[],client=await setup(t,'reviewer',async(name,args)=>{calls.push({name,args});return{recorded:true};});
  const args={run:crypto.randomUUID(),requestId:crypto.randomUUID(),assessment:{format:'projects-code-review-assessment/v2',contextId:'a'.repeat(64),verdict:'pass',summary:'Reviewed exact candidate.',findings:[],resolvedPriorFindingIds:[]}};
  assert.ok(!(await client.callTool({name:'projects_git_trial_assess',arguments:args})).isError);assert.equal(calls.length,1);
  args.assessment.contextId=crypto.randomUUID();assert.equal((await client.callTool({name:'projects_git_trial_assess',arguments:args})).isError,true);assert.equal(calls.length,1);
});
