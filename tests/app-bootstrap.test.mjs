import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {canInspectInstallation} from '../public/ui/installation.js';

const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const start=source.indexOf('function updateChrome()');
const end=source.indexOf('\nfunction render(',start);
assert.ok(start>=0&&end>start,'The real browser chrome updater must be available to this harness.');
const update=source.slice(start,end);

for(const view of ['review','evidence'])test(`cold ${view} deep link renders its loading chrome without reading unloaded work`,()=>{
  const nodes=new Map();
  const $=selector=>{
    if(!nodes.has(selector))nodes.set(selector,{textContent:'',classList:{toggle(){}},setAttribute(){},removeAttribute(){}});
    return nodes.get(selector);
  };
  const title=view==='review'?'Changes & checks':'Candidate record';
  runInNewContext(update+'\nupdateChrome();',{
    $,document:{querySelectorAll:()=>[],querySelector:()=>null},workspace:null,view,demo:false,actions:{busy:false},taskCreation:{starting:false},
    canInspectInstallation,getContext:()=>({workspace:null,demo:false}),
    viewTitles:{[view]:[title,title,'Load the selected work.']},
    currentTask(){throw new Error('Task data is not loaded.');},
    currentRun(){throw new Error('Candidate data is not loaded.');},
  });
  assert.equal($('#page-title').textContent,title);
  assert.equal($('#new-project').disabled,true);
});
