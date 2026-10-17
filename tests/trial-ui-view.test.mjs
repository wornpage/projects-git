import test from 'node:test';
import assert from 'node:assert/strict';
import {renderTrial} from '../public/trial/view.js';
import {installFakeDOM} from './helpers/fake-dom.mjs';

const nodes=root=>[root,...(root.children??[]).flatMap(nodes)];
const identity={email:'alex@example.test',policy:{durationMs:604800000}};
const trial={expiresAt:'2026-10-24T12:00:00.000Z'};
const actions={reserve(){},refresh(){},prepareSample(){},confirmClose(){},cancelClose(){},close(){}};

test('unavailable and ended signup states offer no workspace entry, renewal or implicit mutation',()=>{
  installFakeDOM();
  for(const phase of ['expired','closed','capacity','failed','signedOut','blocked']){
    const root=document.createElement('div'),announcement=document.createElement('p');
    renderTrial(root,announcement,{phase,identity:null,trial:null,error:'PRIVATE_PROVIDER_TEXT'},actions);
    const links=nodes(root).filter(node=>node.tagName==='A');
    assert.ok(!links.some(node=>node.attrs.href?.startsWith('/workspace')));
    assert.doesNotMatch(root.textContent,/PRIVATE_PROVIDER_TEXT|Renew trial|Reserve trial/);
    if(phase!=='signedOut')assert.ok(links.some(node=>node.attrs.href==='https://git-demo.projectsdemo.org/?view=projects'),'The public example remains a real link, independent of sample setup state.');
  }
});

test('close confirmation preserves the warning and cancellation restores trigger focus',()=>{
  installFakeDOM();const root=document.createElement('div'),announcement=document.createElement('p');
  renderTrial(root,announcement,{phase:'confirm-close',identity,trial,error:null},actions);
  const dialog=nodes(root).find(node=>node.tagName==='DIALOG');assert.equal(dialog.open,true);
  assert.match(dialog.textContent,/retained records will not be deleted/);
  assert.equal(nodes(dialog).find(node=>node.textContent==='Keep trial').attrs.autofocus,'');
  renderTrial(root,announcement,{phase:'admitted',identity,trial,error:null},actions);
  assert.equal(document.activeElement.id,'close-trial');
});

test('sample preparation is explicit and uncertain states offer inspection before any resume',async()=>{
  installFakeDOM();const root=document.createElement('div'),announcement=document.createElement('p');let preparations=0,reads=0;
  const handlers={...actions,prepareSample:()=>preparations++,refresh:()=>reads++};
  const render=sample=>renderTrial(root,announcement,{phase:'admitted',identity,trial,error:null,sample},handlers);
  render({phase:'not-started',result:{retryable:true},error:null});assert.equal(preparations,0);await root.querySelector('#prepare-sample').dispatch('click');assert.equal(preparations,1);
  render({phase:'unknown',result:null,error:'PRIVATE_PROVIDER_TEXT'});assert.equal(root.querySelector('#prepare-sample'),null);assert.equal(root.querySelector('#resume-sample'),null);
  assert.doesNotMatch(root.textContent,/PRIVATE_PROVIDER_TEXT/);await root.querySelector('#check-sample-status').dispatch('click');assert.equal(reads,1);
  render({phase:'failed',result:{retryable:true},error:null});await root.querySelector('#resume-sample').dispatch('click');assert.equal(preparations,2);
  render({phase:'failed',result:{retryable:false},error:null});assert.equal(root.querySelector('#resume-sample'),null);assert.match(root.textContent,/operator attention/);
});

test('only a confirmed ready sample offers its private project link and full provenance',()=>{
  installFakeDOM();const root=document.createElement('div'),announcement=document.createElement('p');
  const result={repository:{projectId:'11111111-1111-4111-8111-111111111111',name:'sample-'+'b'.repeat(64),baseCommit:'c'.repeat(40)}};
  for(const phase of ['checking','saving','preparing','unavailable','unknown','failed','blocked']){
    renderTrial(root,announcement,{phase:'admitted',identity,trial,error:null,sample:{phase,result:{retryable:false},error:null}},actions);
    assert.equal(root.querySelector('#open-sample'),null);assert.ok(!root.textContent.includes('c'.repeat(40)));
  }
  renderTrial(root,announcement,{phase:'admitted',identity,trial,error:null,sample:{phase:'ready',result,error:null}},actions);
  assert.equal(root.querySelector('#open-sample').attrs.href,'/workspace/?view=queue&project='+result.repository.projectId);
  assert.match(root.textContent,/starter code, not completed agent work/);assert.match(root.textContent,/No model credits, coding runs, exports or automatic cleanup/);
  assert.ok(root.textContent.includes(result.repository.baseCommit));assert.equal(document.activeElement.id,'sample-heading');
});
