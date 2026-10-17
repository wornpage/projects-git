import test from 'node:test';
import assert from 'node:assert/strict';
import {installFakeDOM} from './helpers/fake-dom.mjs';
import {projectOperationalMetrics} from '../src/core/operational-metrics.mjs';
import {createProjectMetricsPanel,readMetrics,durationLabel} from '../public/ui/project-metrics.js';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function data(){return projectOperationalMetrics({revision:1,workspace:{id:'fixture',projects:{one:{id:'one'}},tasks:[],runs:[],events:[]},operations:{}},'one','2026-10-16T00:00:00.000Z');}
function panel(api){installFakeDOM();let generation=0;const context={selectedProject:'one',workspace:{projects:{one:{id:'one'}},authentication:{mode:'cloudflare-access'}}};
  const root=createProjectMetricsPanel({projectId:'one',getContext:()=>context,captureSession:()=>{const captured=generation;return()=>captured===generation;},api});
  return {root,context,changeSession:()=>generation++};}
test('unrecorded medians and dollar spend are visible instead of zeroes',async()=>{
  const calls=[],p=panel(async(...args)=>{calls.push(args);return data();});await tick();
  assert.match(p.root.textContent,/Not recorded/);assert.match(p.root.textContent,/Dollar spend: not recorded/);assert.doesNotMatch(p.root.textContent,/\$0/);
  assert.deepEqual(calls,[['/api/projects/one/metrics']]);await p.root.querySelector('button').dispatch('click');assert.equal(calls.length,2);
  assert.ok(calls.every(call=>call.length===1));
});
test('duration units preserve actual zero and reject an invalid measured value',()=>{
  assert.equal(durationLabel(null),'Not recorded');assert.equal(durationLabel(0),'0 ms');assert.equal(durationLabel(1500),'1.5 s');
  for(const value of [NaN,Infinity,-1,undefined])assert.throws(()=>durationLabel(value));
});
test('incomplete or contradictory metrics cannot render as a complete dashboard',()=>{
  for(const change of [d=>{delete d.phases.recovery;},d=>{d.phases.queue.observed=1;},d=>{d.phases.queue.medianMs=0;},
    d=>{d.usage.unknownUsageRequests++;},d=>{d.cost.actual=0;},d=>{d.scope='loaded-page';},d=>{d.modelProvenance.recordedRuns++;},
    d=>{d.phases.recovery.outcomes={failed:1};},d=>{delete d.usage.totalOverflow;},d=>{d.phases.queue.outcomes.private=0;}]){
    const value=data();change(value);assert.throws(()=>readMetrics(value,'one'),/incomplete/);
  }
});

test('measured failed outcomes and unsafe token totals stay visible',async()=>{
  const value=data();Object.assign(value.phases.recovery,{total:1,observed:1,medianMs:20,minimumMs:20,maximumMs:20,outcomes:{unconfirmed:1}});
  value.usage.totalOverflow=true;
  const p=panel(async()=>value);await tick();
  assert.match(p.root.textContent,/Measured outcomes: unconfirmed 1/);assert.match(p.root.textContent,/token total exceeded safe arithmetic limits/);
});
test('late metrics cannot replace another session, project or detached panel',async()=>{
  for(const change of [p=>p.changeSession(),p=>{p.context.selectedProject='other';},p=>{p.root.isConnected=false;},p=>{delete p.context.workspace.projects.one;}]){
    const result=Promise.withResolvers(),p=panel(()=>result.promise);await tick();change(p);result.resolve(data());await tick();
    assert.doesNotMatch(p.root.textContent,/Retained timing observations/);
  }
});
