import test from 'node:test';
import assert from 'node:assert/strict';
import {TrialAgentClient,trialConnection} from '../src/local/trial-agent-client.mjs';
const connection={format:'projects-git-trial-connection/v1',origin:'https://trial.example.test',role:'agent',token:'pgt1_'+'a'.repeat(64),workspaceId:'trial-'+'b'.repeat(64)};
test('trial connections refuse HTTP, embedded secrets, selectors, and non-trial identities',()=>{
  assert.deepEqual(trialConnection(connection),connection);
  for(const change of [{origin:'http://trial.example.test'},{origin:'https://user:secret@trial.example.test'},{origin:'https://trial.example.test/path'},{role:'owner'},{workspaceId:'private-workspace'},{token:'short'},{extra:true}])assert.throws(()=>trialConnection({...connection,...change}));
});
test('builder requests are bound to one origin/workspace and cannot invoke reviewer or owner actions',async()=>{
  const calls=[],client=new TrialAgentClient(connection,{fetchImpl:async(url,options)=>{calls.push({url,options});return Response.json({id:connection.workspaceId});}});
  await client.execute('workspace');assert.equal(calls[0].url,connection.origin+'/agent/api/workspace');assert.equal(calls[0].options.redirect,'manual');
  assert.equal(calls[0].options.headers['X-Workspace-Id'],connection.workspaceId);assert.equal(calls[0].options.headers.Authorization,'Bearer '+connection.token);
  for(const action of ['assess','accept','merge'])await assert.rejects(client.execute(action));assert.equal(calls.length,1);
});
test('unknown responses and redirects never retry or reflect response credentials',async()=>{
  for(const mode of ['lost','redirect','secret','foreign']){
    let calls=0;const client=new TrialAgentClient(connection,{fetchImpl:async()=>{calls++;if(mode==='lost')throw Error(connection.token);if(mode==='redirect')return new Response(null,{status:302,headers:{Location:'https://elsewhere.test'}});if(mode==='secret')return Response.json({credentials:{token:'provider-token'}});return Response.json({id:'another-workspace'});}});
    await assert.rejects(client.execute('workspace'),error=>!error.message.includes(connection.token)&&!error.message.includes('provider-token'));assert.equal(calls,1);
  }
});
test('mutations require explicit IDs and bounded source while reviewers cannot claim work',async()=>{
  let calls=0;const client=new TrialAgentClient(connection,{fetchImpl:async()=>{calls++;return Response.json({runId:crypto.randomUUID()});}}),run=crypto.randomUUID();
  await assert.rejects(client.execute('publish',{run,source:'x',headCommit:'a'.repeat(40)}));
  await assert.rejects(client.execute('publish',{run,source:'x'.repeat(32769),headCommit:'a'.repeat(40),requestId:crypto.randomUUID()}));assert.equal(calls,0);
  await client.execute('publish',{run,source:'export const x=1;',headCommit:'a'.repeat(40),requestId:crypto.randomUUID()});assert.equal(calls,1);
  await assert.rejects(new TrialAgentClient({...connection,role:'reviewer'}).execute('claim',{project:crypto.randomUUID(),label:'Agent',requestId:crypto.randomUUID()}));
});
