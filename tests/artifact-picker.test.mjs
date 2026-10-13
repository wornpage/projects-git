import test from 'node:test';
import assert from 'node:assert/strict';
import {installFakeDOM} from './helpers/fake-dom.mjs';
import {createArtifactPicker} from '../public/ui/artifact-picker.js';

const settle=()=>new Promise(resolve=>setImmediate(resolve));
const page=(names=['alpha','beta'],cursor=null,total=names.length)=>({workspaceId:'workspace',repositories:names.map(name=>({name})),total,nextCursor:cursor});
const head=(name,baseCommit='a'.repeat(40))=>({workspaceId:'workspace',name,defaultBranch:'release/next',baseCommit});
function fixture({provider='cloudflare-artifacts',manage=true,demo=false}={}){
  const dom=installFakeDOM(),{$}=dom,calls=[],saves=[];
  const context={workspace:{id:'workspace',provider,authentication:{principal:{id:'owner',kind:manage?'owner':'agent'},permissions:{manage}},capabilities:{repositoryCatalog:manage,inspectRepository:provider==='local-git'}},demo};
  let locked=false;
  $('#task-launcher').open=true;$('#task-source').value='repository';$('#repository-source-fields').hidden=false;
  const picker=createArtifactPicker({getContext:()=>context,isLocked:()=>locked,saveSession:()=>saves.push({name:$('#repository-path').value,base:$('#repository-base').value}),api:path=>new Promise((resolve,reject)=>calls.push({path,resolve,reject}))});
  const update=()=>picker.update();
  const choose=async name=>{$('#artifact-repository-select').value=name;await $('#artifact-repository-select').dispatch('change');};
  return {...dom,context,calls,saves,update,choose,lock:value=>{locked=value;update();}};
}

test('hosted discovery loads names and an exact base before allowing confirmation',async()=>{
  const f=fixture();f.update();await settle();assert.equal(f.calls[0].path,'/api/repositories');
  assert.equal(f.$('#repository-next').disabled,true);assert.equal(f.$('#repository-manual-fields').hidden,true);
  f.calls[0].resolve(page());await settle();await f.choose('alpha');
  assert.equal(f.calls[1].path,'/api/repositories/head?name=alpha');assert.equal(f.$('#repository-base').value,'');assert.equal(f.$('#repository-next').disabled,true);
  f.calls[1].resolve(head('alpha'));await settle();assert.equal(f.$('#repository-base').value,'a'.repeat(40));assert.equal(f.$('#repository-next').disabled,false);
  assert.match(f.$('#artifact-base-status').textContent,/release\/next/);assert.equal(f.$('#repository-base').readonly,true);
  assert.deepEqual(f.saves.at(-1),{name:'alpha',base:'a'.repeat(40)});
  await f.$('#repository-back').dispatch('click');assert.equal(document.activeElement,f.$('#artifact-repository-select'));
});

for(const failure of [false,true])test(`a late earlier selection ${failure?'failure':'success'} cannot replace the newer base`,async()=>{
  const f=fixture();f.update();await settle();f.calls[0].resolve(page());await settle();
  await f.choose('alpha');await f.choose('beta');f.calls[2].resolve(head('beta','b'.repeat(40)));await settle();
  if(failure)f.calls[1].reject(Error('Old request failed'));else f.calls[1].resolve(head('alpha'));
  await settle();assert.equal(f.$('#repository-path').value,'beta');assert.equal(f.$('#repository-base').value,'b'.repeat(40));assert.equal(f.$('#artifact-picker-error').hidden,true);
});

test('a response cannot change a locked creation request or a different workspace',async()=>{
  const f=fixture();f.update();await settle();f.calls[0].resolve(page());await settle();await f.choose('alpha');
  f.lock(true);const count=f.saves.length;f.calls[1].resolve(head('alpha'));await settle();assert.equal(f.saves.length,count);assert.equal(f.$('#repository-base').value,'');
  f.$('#repository-path').value='';f.context.workspace.id='other';f.lock(false);await settle();
  const pending=f.calls.at(-1);pending.resolve(page());await settle();assert.match(f.$('#artifact-picker-error').textContent,/invalid/);assert.equal(f.$('#repository-next').disabled,true);
});

test('closing the dialog suppresses late errors and reopening retries only a read',async()=>{
  const f=fixture();f.update();await settle();const first=f.calls[0];f.$('#task-launcher').close();first.reject(Error('Hidden failure'));await settle();
  assert.equal(f.$('#artifact-picker-error').textContent,'');f.$('#task-launcher').open=true;f.update();await settle();assert.equal(f.calls.length,2);assert.equal(f.calls[1].path,'/api/repositories');
});

test('paging retains the full total, previous cursors and the current selection',async()=>{
  const f=fixture();f.update();await settle();f.calls[0].resolve(page(['alpha'],'second',3));await settle();
  await f.choose('alpha');f.calls[1].resolve(head('alpha'));await settle();
  await f.$('#artifact-next').dispatch('click');assert.equal(f.calls[2].path,'/api/repositories?cursor=second');f.calls[2].resolve(page(['beta','gamma'],null,3));await settle();
  assert.match(f.$('#artifact-catalog-status').textContent,/2 on this page · 3 repositories/);assert.equal(f.$('#artifact-repository-select').value,'alpha');
  await f.$('#artifact-previous').dispatch('click');assert.equal(f.calls[3].path,'/api/repositories');f.calls[3].resolve(page(['alpha'],'second',3));await settle();assert.equal(f.$('#artifact-previous').disabled,true);
});

test('empty repositories and provider failures remain explicit and cannot advance',async()=>{
  const f=fixture();f.update();await settle();f.calls[0].resolve(page(['empty']));await settle();await f.choose('empty');f.calls[1].resolve(head('empty',null));await settle();
  assert.match(f.$('#artifact-base-status').textContent,/has no commit/);assert.equal(f.$('#repository-next').disabled,true);
  await f.$('#artifact-refresh-base').dispatch('click');f.calls[2].reject(Error('Repository is still importing'));await settle();assert.match(f.$('#artifact-picker-error').textContent,/importing/);assert.equal(f.$('#repository-next').disabled,true);
});

test('a failed list refresh preserves the chosen base but blocks confirmation until a successful read',async()=>{
  const f=fixture();f.update();await settle();f.calls[0].resolve(page());await settle();await f.choose('alpha');f.calls[1].resolve(head('alpha'));await settle();
  await f.$('#artifact-refresh').dispatch('click');f.calls[2].reject(Error('Listing unavailable'));await settle();
  assert.equal(f.$('#repository-base').value,'a'.repeat(40));assert.equal(f.$('#repository-next').disabled,true);assert.equal(f.$('#artifact-picker-error').hidden,false);
  await f.$('#artifact-refresh').dispatch('click');f.calls[3].resolve(page());await settle();assert.equal(f.$('#repository-next').disabled,false);
});

test('zero namespace repositories clears a saved base and does not manufacture an option',async()=>{
  const f=fixture();f.$('#repository-path').value='deleted';f.$('#repository-base').value='a'.repeat(40);f.update();await settle();
  assert.equal(f.calls.length,2);f.calls[0].resolve(page([]));await settle();f.calls[1].resolve(head('deleted'));await settle();
  assert.equal(f.$('#artifact-empty').hidden,false);assert.equal(f.$('#repository-path').value,'');assert.equal(f.$('#repository-base').value,'');assert.equal(f.$('#repository-next').disabled,true);
});

test('local, sample and restricted contexts do not query the Artifacts namespace',async()=>{
  for(const options of [{provider:'local-git'},{manage:false},{demo:true}]){
    const f=fixture(options);f.update();await settle();assert.equal(f.calls.length,0);
    if(options.provider==='local-git'){assert.equal(f.$('#repository-manual-fields').hidden,false);assert.equal(f.$('#artifact-picker-field').hidden,true);assert.equal(f.$('#repository-base').attrs.readonly,undefined);}
  }
  const f=fixture();f.$('#task-source').value='sample';f.update();await settle();assert.equal(f.calls.length,0);
});
