import test from 'node:test';
import assert from 'node:assert/strict';
import {trialConnectionDownload,createTrialConnections} from '../public/ui/trial-connections.js';
import {installFakeDOM} from './helpers/fake-dom.mjs';
test('connection downloads bind a current credential to the requested trial and role',()=>{
  const workspaceId='trial-'+'a'.repeat(64),result={token:'pgt1_'+'b'.repeat(64),principal:{provider:'trial-credential',workspaceId,kind:'agent',expiresAt:Math.floor(Date.now()/1000)+600}};
  const value=trialConnectionDownload(result,workspaceId,'agent','https://trial.example.test');assert.equal(value.role,'agent');assert.equal(value.workspaceId,workspaceId);
  for(const changed of [{...result,token:null},{...result,principal:{...result.principal,workspaceId:'other'}},{...result,principal:{...result.principal,kind:'reviewer'}},{...result,principal:{...result.principal,expiresAt:0}}])assert.throws(()=>trialConnectionDownload(changed,workspaceId,'agent','https://trial.example.test'));
});
const descendants=node=>[node,...node.children.flatMap(descendants)];
test('owner connection creation preserves the identity precondition and secret disappears on disposal',async()=>{
  const {document}=installFakeDOM();document.removeEventListener=()=>{};
  const workspaceId='trial-'+'a'.repeat(64),requests=[];
  const component=createTrialConnections({workspaceId,captureSession:()=>()=>true,origin:'https://trial.example.test',fetcher:async(path,options)=>{
    requests.push({path,options});return Response.json(path.endsWith('/session')?{identityKey:'b'.repeat(64)}:{token:'pgt1_'+'c'.repeat(64),principal:{provider:'trial-credential',kind:'agent',workspaceId,expiresAt:Math.floor(Date.now()/1000)+600}});
  }});
  component.node.querySelector('select').value='agent';
  const create=descendants(component.node).find(node=>node.tagName==='BUTTON'&&node.textContent==='Create / replace connection');await create.dispatch('click');
  assert.equal(requests[0].options.headers['X-Workspace-Id'],undefined);assert.equal(requests[1].options.headers['X-Workspace-Id'],workspaceId);
  assert.equal(requests[1].options.headers['X-Trial-Identity'],'b'.repeat(64));assert.ok(requests[1].options.headers['Idempotency-Key']);
  const download=descendants(component.node).find(node=>node.textContent==='Download private connection');assert.equal(download.hidden,false);
  component.dispose();assert.equal(download.hidden,true);
});
test('closing a connection panel discards a delayed credential response',async()=>{
  const {document}=installFakeDOM();document.removeEventListener=()=>{};let resolve;
  const pending=new Promise(done=>resolve=done),workspaceId='trial-'+'a'.repeat(64);
  const component=createTrialConnections({workspaceId,captureSession:()=>()=>true,origin:'https://trial.example.test',fetcher:async path=>path.endsWith('/session')?Response.json({identityKey:'b'.repeat(64)}):pending});
  component.node.querySelector('select').value='agent';
  const call=descendants(component.node).find(n=>n.tagName==='BUTTON'&&n.textContent==='Create / replace connection').dispatch('click');
  await new Promise(resolve=>setImmediate(resolve));component.dispose();
  resolve(Response.json({token:'pgt1_'+'c'.repeat(64),principal:{provider:'trial-credential',kind:'agent',workspaceId,expiresAt:Math.floor(Date.now()/1000)+600}}));await call;
  assert.equal(descendants(component.node).find(n=>n.textContent==='Download private connection').hidden,true);
});
