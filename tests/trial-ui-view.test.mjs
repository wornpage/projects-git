import test from 'node:test';
import assert from 'node:assert/strict';
import {renderTrial} from '../public/trial/view.js';
import {installFakeDOM} from './helpers/fake-dom.mjs';

const nodes=root=>[root,...(root.children??[]).flatMap(nodes)];
const identity={email:'alex@example.test',policy:{durationMs:604800000}};
const trial={expiresAt:'2026-10-24T12:00:00.000Z'};
const actions={reserve(){},refresh(){},confirmClose(){},cancelClose(){},close(){}};

test('unavailable and ended signup states offer no workspace entry, renewal or implicit mutation',()=>{
  installFakeDOM();
  for(const phase of ['expired','closed','capacity','failed','signedOut','blocked']){
    const root=document.createElement('div'),announcement=document.createElement('p');
    renderTrial(root,announcement,{phase,identity:null,trial:null,error:'PRIVATE_PROVIDER_TEXT'},actions);
    const links=nodes(root).filter(node=>node.tagName==='A');
    assert.ok(!links.some(node=>node.attrs.href?.startsWith('/workspace')));
    assert.doesNotMatch(root.textContent,/PRIVATE_PROVIDER_TEXT|Renew trial|Reserve trial/);
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
