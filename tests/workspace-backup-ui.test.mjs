import test from 'node:test';
import assert from 'node:assert/strict';
import {installFakeDOM} from './helpers/fake-dom.mjs';
import {createWorkspace} from '../src/core/workflow.mjs';
import {buildWorkspaceBackup,workspaceBackupPreview} from '../src/core/workspace-backup.mjs';
import {createWorkspaceBackupPanel,canInspectWorkspaceBackup} from '../public/ui/workspace-backup.js';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function archive(){return buildWorkspaceBackup({revision:1,workspace:{...createWorkspace({id:'fixture-workspace',provider:'cloudflare-artifacts'}),projects:{}},operations:{},repositories:{},forks:{},jobs:{},checkPolicies:{}});}
function panel(api){
  installFakeDOM();let generation=0;const downloads=[],context={workspace:{id:'fixture-workspace',authentication:{mode:'cloudflare-access',permissions:{manage:true}}}};
  const root=createWorkspaceBackupPanel({getContext:()=>context,captureSession:()=>{const captured=generation;return()=>captured===generation;},api,downloadJson:(...args)=>downloads.push(args)});
  return {root,context,downloads,changeSession:()=>generation++};
}
test('backup panel requests nothing automatically and downloads only complete current-workspace metadata',async()=>{
  const value=await archive(),calls=[],p=panel(async(...args)=>{calls.push(args);return value;});await tick();assert.deepEqual(calls,[]);
  await p.root.querySelector('button').dispatch('click');assert.deepEqual(calls,[['/api/workspace/backup']]);assert.equal(p.downloads.length,1);
  assert.deepEqual(p.downloads[0][0],value);assert.match(p.root.textContent,/Metadata alone cannot recover code/);
  assert.match(p.root.textContent,/does not resume work or install an active database/);
});
test('backup preview is explicit, validates without applying and displays complete uncertainty counts',async()=>{
  const value=await archive(),calls=[],p=panel(async(...args)=>{calls.push(args);return workspaceBackupPreview(value);}),input=p.root.querySelector('input');
  input.files=[new Blob([JSON.stringify(value)])];await input.dispatch('change');
  assert.equal(calls.length,1);assert.equal(calls[0][0],'/api/workspace/backup-preview');assert.equal(calls[0][1].method,'POST');
  assert.deepEqual(calls[0][1].body,{archive:value,expectedSha256:value.sha256});assert.equal(p.downloads.length,0);
  assert.match(p.root.textContent,/0 unresolved operation receipts/);assert.match(p.root.textContent,/No work will be resumed/);
});
test('late download and preview responses cannot cross a session, workspace, owner revocation or detached view',async()=>{
  const value=await archive();
  for(const change of [p=>p.changeSession(),p=>{p.context.workspace.id='other';},p=>{p.context.workspace.authentication.permissions.manage=false;},p=>{p.root.isConnected=false;}]){
    const pending=Promise.withResolvers(),p=panel(()=>pending.promise),click=p.root.querySelector('button').dispatch('click');change(p);pending.resolve(value);await click;
    assert.equal(p.downloads.length,0);
    const delayed=Promise.withResolvers(),q=panel(()=>delayed.promise),input=q.root.querySelector('input');input.files=[new Blob([JSON.stringify(value)])];
    const reading=input.dispatch('change');await tick();change(q);delayed.resolve(workspaceBackupPreview(value));await reading;
    assert.doesNotMatch(q.root.textContent,/0 unresolved operation receipts/);
  }
});
test('non-owner/demo views and oversized or malformed files cannot invoke recovery APIs',async()=>{
  assert.equal(canInspectWorkspaceBackup({demo:{},workspace:{authentication:{mode:'cloudflare-access',permissions:{manage:true}}}}),false);
  assert.equal(canInspectWorkspaceBackup({workspace:{authentication:{mode:'cloudflare-access',permissions:{manage:false}}}}),false);
  const calls=[],p=panel(async(...args)=>calls.push(args));
  for(const file of [new Blob(['bad json']),{size:1024*1024+1,slice:()=>assert.fail('Oversized files must not be read')}]){
    const input=p.root.querySelector('input');input.files=[file];await input.dispatch('change');assert.match(p.root.textContent,/Could not validate this backup/);
  }
  assert.deepEqual(calls,[]);
});
