import test from 'node:test';
import assert from 'node:assert/strict';
import {downloadJson} from '../public/ui/json-download.js';
import {installFakeDOM} from './helpers/fake-dom.mjs';
import {createWorkspace} from '../src/core/workflow.mjs';
import {buildWorkspaceBackup,readWorkspaceBackup,MAX_WORKSPACE_BACKUP_BYTES} from '../src/core/workspace-backup.mjs';

function downloads(t){
  installFakeDOM();const blobs=[],links=[],revoked=[],timers=[];
  document.body={append(link){links.push(link);}};
  t.mock.method(document,'createElement',tag=>{assert.equal(tag,'a');return {click(){this.clicked=true;},remove(){this.removed=true;}};});
  t.mock.method(URL,'createObjectURL',blob=>{blobs.push(blob);return 'blob:json-fixture-'+blobs.length;});
  t.mock.method(URL,'revokeObjectURL',url=>revoked.push(url));
  t.mock.method(globalThis,'setTimeout',(callback,delay)=>{timers.push({callback,delay});return 0;});
  return {blobs,links,revoked,timers};
}

test('ordinary JSON exports retain pretty formatting, trailing newline and the existing download lifecycle',async t=>{
  const f=downloads(t),data={title:'Ordinary export',items:[1,2]};downloadJson(data,'ordinary.json');
  assert.equal(await f.blobs[0].text(),JSON.stringify(data,null,2)+'\n');assert.equal(f.blobs[0].type,'application/json;charset=utf-8');
  assert.equal(f.links[0].download,'ordinary.json');assert.equal(f.links[0].href,'blob:json-fixture-1');
  assert.equal(f.links[0].clicked,true);assert.equal(f.links[0].removed,true);assert.equal(f.timers[0].delay,1000);
  assert.deepEqual(f.revoked,[]);f.timers[0].callback();assert.deepEqual(f.revoked,['blob:json-fixture-1']);
});

test('actual compact backup Blob at the exact archive admission limit round-trips without padding or newline',async t=>{
  const workspace={...createWorkspace({id:'download-boundary',provider:'cloudflare-artifacts'}),projects:{}};
  workspace.events=Array.from({length:4000},()=>({id:crypto.randomUUID(),at:'2026-10-16T12:00:00.000Z',type:'workspace.observed',message:'x'.repeat(100)}));
  const snapshot={workspace,revision:0,repositories:{},forks:{},operations:{},jobs:{},checkPolicies:{}},at='2026-10-16T12:00:00.000Z';
  const ledgers={capture:'coherent-sqlite-transaction',artifactSubscriptions:[],artifactSubscriptionAttempts:[],artifactEvents:[],artifactEventAttempts:[],artifactDeliveries:[]};
  const first=await buildWorkspaceBackup(snapshot,at,ledgers);
  let remaining=MAX_WORKSPACE_BACKUP_BYTES-Buffer.byteLength(JSON.stringify(first));assert.ok(remaining>0);
  for(const event of workspace.events){const extra=Math.min(10000-event.message.length,remaining);event.message+='x'.repeat(extra);remaining-=extra;if(!remaining)break;}
  assert.equal(remaining,0);
  const archive=await buildWorkspaceBackup(snapshot,at,ledgers),compact=JSON.stringify(archive);
  assert.equal(Buffer.byteLength(compact),MAX_WORKSPACE_BACKUP_BYTES);
  const f=downloads(t);downloadJson(archive,'workspace.json',{compact:true});
  assert.equal(f.blobs[0].size,MAX_WORKSPACE_BACKUP_BYTES);assert.equal(await f.blobs[0].text(),compact);
  assert.deepEqual(await readWorkspaceBackup(await f.blobs[0].text(),archive.sha256),archive);
  // The shared pretty default reproduces the previous backup download failure.
  downloadJson(archive,'ordinary-pretty.json');assert.ok(f.blobs[1].size>MAX_WORKSPACE_BACKUP_BYTES);
  await assert.rejects(readWorkspaceBackup(await f.blobs[1].text(),archive.sha256),{code:'WORKSPACE_BACKUP_INVALID'});
});
