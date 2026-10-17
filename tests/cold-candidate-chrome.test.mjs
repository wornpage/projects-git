import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {compileFunction} from 'node:vm';
import {canInspectInstallation} from '../public/ui/installation.js';

test('cold candidate detail and record chrome waits for workspace data before querying selection',async()=>{
 const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
 const match=source.match(/function updateChrome\(\) \{([\s\S]*?)\n\}\s*function render\(/);assert.ok(match,'Chrome owner boundary changed');
 const parameters=['demo','actions','viewTitles','view','workspace','currentTask','currentRun','$','taskCreation','document','canInspectInstallation','getContext'];
 const update=compileFunction(match[1],parameters);
 for(const view of ['review','evidence']){
  const elements=new Map(),select=id=>{if(!elements.has(id))elements.set(id,{textContent:'',dataset:{},classList:{toggle(){}}});return elements.get(id);};
  let lookups=0;const unavailable=()=>{lookups++;throw Error('Selection cannot be read before the workspace loads.');};
  const title=view==='review'?'Candidate':'Candidate record';
  update(null,{busy:false},{[view]:[title,title,'Retained work']},view,null,unavailable,unavailable,select,{starting:false},{querySelectorAll:()=>[],querySelector:()=>null},canInspectInstallation,()=>({workspace:null,demo:false}));
  assert.equal(lookups,0);assert.equal(select('#page-title').textContent,title);assert.equal(select('#new-project').disabled,true);
  assert.equal(select('#main').dataset.view,view);
 }
});
