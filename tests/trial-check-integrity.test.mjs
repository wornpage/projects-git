import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkerChecks} from '../src/cloudflare/sandbox.ts';
import {trialWorkflowFixture,correctCheckout} from './helpers/trial-workflow.mjs';
import {checkoutCases} from '../fixtures/checkout-cases.mjs';

const observations=checkoutCases.flatMap(group=>group.trials.map(trial=>trial.throws?{threw:true}:{threw:false,value:trial.value}));
const forged=JSON.stringify(JSON.stringify(observations));
for(const [name,pollute] of [
  ['Response.json',`Response.json=()=>new Response(${forged});`],
  ['Array.prototype.map',`Array.prototype.map=function(){return JSON.parse(${forged});};`],
  ['Object.prototype.toJSON',`Object.prototype.toJSON=function(){return JSON.parse(${forged});};`],
  ['global Response and finite',`globalThis.Response=class{constructor(){return new OriginalResponse(${forged});}};Number.isFinite=()=>true;`],
  ['inherited response then',`Object.prototype.then=function(resolve){delete Object.prototype.then;resolve(new Response(${forged}));};`],
])test('guest '+name+' pollution cannot forge independent workerd observations',async t=>{
  const f=await trialWorkflowFixture(t);
  const source='const OriginalResponse=Response;'+pollute+'export function checkoutTotal(){return 0;}';
  const result=await new WorkerChecks(f.env.TRIAL_LOADER).verify(source,'a'.repeat(40));
  assert.equal(result.total,16);assert.notEqual(result.passed,result.total);assert.equal(result.exitCode,1);
});

test('trusted primitive serialization retains all 16 genuine workerd results',async t=>{
  const f=await trialWorkflowFixture(t),result=await new WorkerChecks(f.env.TRIAL_LOADER).verify(correctCheckout,'b'.repeat(40));
  assert.equal(result.passed,16);assert.equal(result.total,16);assert.equal(result.exitCode,0);
});
