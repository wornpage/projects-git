import test from 'node:test';
import assert from 'node:assert/strict';
import {installFakeDOM} from './helpers/fake-dom.mjs';
import {createWorkspaceRecoveryPanel} from '../public/ui/workspace-recovery.js';
import {createApiClient} from '../public/api-client.js';
import {buildWorkspaceBackup,workspaceBackupPreview} from '../src/core/workspace-backup.mjs';
import {initialSnapshot} from '../src/cloudflare/controller.ts';
const nodes=root=>[root,...(root.children??[]).flatMap(nodes)];
const button=(root,label)=>nodes(root).find(node=>node.tagName==='BUTTON'&&node.textContent===label);
async function fixture(fetchRequest){
  installFakeDOM();let generation=0;
  const archive=await buildWorkspaceBackup(initialSnapshot('original-source'),new Date().toISOString(),{capture:'coherent-sqlite-transaction',artifactSubscriptions:[],artifactSubscriptionAttempts:[],artifactEvents:[],artifactEventAttempts:[],artifactDeliveries:[]}),preview=workspaceBackupPreview(archive);
  const context={workspace:{id:'destination',authentication:{permissions:{manage:true}}}},downloads=[];
  const history={workspaceId:'destination',revision:7,restoreAllowed:true,current:{projects:0,tasks:0,runs:0,liveLedgerRows:0},imports:[],quarantinedNames:[]};
  const panel=createWorkspaceRecoveryPanel({getContext:()=>context,captureSession:()=>{const started=generation;return()=>started===generation;},
    canManage:()=>context.workspace.authentication.permissions.manage,api:createApiClient({fetchRequest}),downloadJson:(...args)=>downloads.push(args),getSelection:()=>({archive,preview})});
  return {root:panel.root,archive,preview,history,context,downloads,changeSession:()=>generation++};
}
async function fill(f){
  for(const [id,value] of [['restore-source-workspace',f.preview.sourceWorkspaceId],['restore-archive-digest',f.archive.sha256],['restore-history-confirmation','RESTORE HISTORY ONLY']]){
    const input=f.root.querySelector('#'+id);input.value=value;await input.dispatch('input');
  }
}
test('history restore requires explicit destination readback and typed pins; real API client sends exact DTO and stable key',async()=>{
  const calls=[];let f;f=await fixture(async(path,options)=>{
    calls.push({path,options});
    if(path.endsWith('recovery-imports'))return Response.json(f.history);
    if(path.endsWith('/restore'))return Response.json({workspaceId:'destination',recoveryImportId:f.archive.sha256,historical:true,restoresAuthority:false,resumesWork:false,codeAvailable:false});
    assert.fail('Unexpected request');
  });
  assert.deepEqual(calls,[]);assert.equal(button(f.root,'Restore history into this empty workspace'),undefined);
  await button(f.root,'Read destination and recovery history').dispatch('click');assert.match(f.root.textContent,/Destination revision 7/);
  await button(f.root,'Restore history into this empty workspace').dispatch('click');assert.equal(calls.length,1);
  await fill(f);await button(f.root,'Restore history into this empty workspace').dispatch('click');
  const sent=calls.find(call=>call.path.endsWith('/restore'));assert.equal(sent.options.method,'POST');assert.ok(sent.options.headers['Idempotency-Key']);
  assert.deepEqual(JSON.parse(sent.options.body),{archive:f.archive,expectedSha256:f.archive.sha256,expectedSourceWorkspaceId:'original-source',expectedWorkspaceId:'destination',expectedRevision:7,confirmation:'RESTORE HISTORY ONLY'});
  assert.equal(calls.filter(call=>call.path.endsWith('/restore')).length,1);
});

test('an unknown restore response is read back without automatically repeating mutation; original history remains downloadable',async()=>{
  const calls=[];let f,retained=false;f=await fixture(async(path,options)=>{
    calls.push({path,options});
    if(path.endsWith('/restore')){retained=true;throw Error('Response lost');}
    if(path.endsWith('/archive'))return Response.json(f.archive);
    if(path.endsWith('/'+f?.archive.sha256))return Response.json({id:f.archive.sha256,sourceWorkspaceId:'original-source',counts:f.preview.counts});
    if(path.endsWith('recovery-imports'))return Response.json({...f.history,imports:retained?[{id:f.archive.sha256,sourceWorkspaceId:'original-source',importedBy:'current-owner',importedAt:new Date().toISOString(),counts:f.preview.counts}]:[]});
    assert.fail('Unexpected request');
  });
  await button(f.root,'Read destination and recovery history').dispatch('click');await fill(f);await button(f.root,'Restore history into this empty workspace').dispatch('click');
  assert.match(f.root.textContent,/outcome is not confirmed/);assert.equal(calls.filter(call=>call.path.endsWith('/restore')).length,1);
  await button(f.root,'Read destination and recovery history').dispatch('click');assert.equal(button(f.root,'Retry same history restore request'),undefined);
  await button(f.root,'Read historical import').dispatch('click');await button(f.root,'Read all original historical records').dispatch('click');assert.match(f.root.textContent,/original-source/);
  await button(f.root,'Download original archive').dispatch('click');assert.deepEqual(f.downloads[0][0],f.archive);assert.equal(calls.filter(call=>call.path.endsWith('/restore')).length,1);
});

test('explicit retry retains the same DTO/key, and late session responses cannot update another owner view',async()=>{
  let f;const calls=[];f=await fixture(async(path,options)=>{
    calls.push({path,options});if(path.endsWith('recovery-imports'))return Response.json(f.history);throw Error('Unconfirmed');
  });
  await button(f.root,'Read destination and recovery history').dispatch('click');await fill(f);await button(f.root,'Restore history into this empty workspace').dispatch('click');
  await button(f.root,'Retry same history restore request').dispatch('click');const writes=calls.filter(call=>call.path.endsWith('/restore'));
  assert.equal(writes.length,2);assert.equal(writes[0].options.body,writes[1].options.body);assert.equal(writes[0].options.headers['Idempotency-Key'],writes[1].options.headers['Idempotency-Key']);
  const pending=Promise.withResolvers();let late;late=await fixture(()=>pending.promise);const reading=button(late.root,'Read destination and recovery history').dispatch('click');late.changeSession();pending.resolve(Response.json(late.history));await reading;
  assert.doesNotMatch(late.root.textContent,/Destination revision 7/);
});
