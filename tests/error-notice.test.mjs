import test from 'node:test';
import assert from 'node:assert/strict';
import {installFakeDOM} from './helpers/fake-dom.mjs';
import {el} from '../public/ui/dom.js';
import {createErrorNotice} from '../public/ui/error-notice.js';

function fixture(){
  installFakeDOM();document.body=el('body');
  const message=el('span',{id:'error-text'}),dismiss=el('button',{id:'dismiss-error'});
  const banner=el('div',{id:'error-banner'},message,dismiss),trigger=el('button',{id:'action'}),dialog=el('dialog',{id:'inspector-dialog'});
  document.body.append(trigger,dialog,banner);document.querySelectorAll=selector=>selector==='dialog'?[dialog]:[];
  const notice=createErrorNotice(document);return {message,dismiss,banner,trigger,dialog,notice};
}

test('visible errors preserve action focus and dismiss restores it without scrolling',()=>{
  const f=fixture();f.trigger.focus();f.notice.show('Publication failed');
  assert.equal(document.activeElement,f.trigger);assert.equal(f.banner.hidden,false);
  assert.equal(f.banner.parentElement,document.body);assert.equal(f.message.textContent,'Publication failed');
  f.dismiss.focus();f.notice.clear();assert.equal(f.banner.hidden,true);assert.equal(document.activeElement,f.trigger);
});

test('the same notice follows the active modal and returns to the page on close',()=>{
  const f=fixture();f.dialog.showModal();f.notice.show('Request failed');
  assert.equal(f.banner.parentElement,f.dialog);f.dialog.close();assert.equal(f.banner.parentElement,document.body);
  assert.equal(f.banner.hidden,false);
});

test('a rerendered trigger is resolved by ID and error text is never interpreted as markup',()=>{
  const f=fixture();f.notice.show('<img src=x onerror=alert(1)>','action');
  f.trigger.isConnected=false;const replacement=el('button',{id:'action'});document.body.append(replacement);
  assert.equal(f.message.textContent,'<img src=x onerror=alert(1)>');assert.equal(f.message.children.length,0);
  f.dismiss.focus();f.notice.clear();assert.equal(document.activeElement,replacement);
});
