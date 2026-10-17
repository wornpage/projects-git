import test from 'node:test';
import assert from 'node:assert/strict';
import {assertTrialWorkflowSnapshot,trialWorkflowUsage,trialCandidateSource} from '../src/cloudflare/trial-workflow.ts';
const workspaceId='trial-'+'a'.repeat(64),repo='sample-'+'a'.repeat(64);
const snapshot=()=>({workspace:{id:workspaceId,projects:{p:{repositoryName:repo,kind:'artifacts'}},tasks:[],runs:[]},repositories:{},operations:{},forks:{},jobs:{}});
test('trial source upload has one fixed file, a pinned head, and a byte rather than character limit',()=>{
  const input={source:'export const value = 1;',headCommit:'a'.repeat(40)};assert.deepEqual(trialCandidateSource(input),input);
  for(const value of [{...input,path:'../secret'}, {...input,headCommit:'main'}, {...input,source:'\0'}, {...input,source:'😀'.repeat(8193)}, {...input,source:'\ud800'}])assert.throws(()=>trialCandidateSource(value));
});
test('failed and retained work remains in trial quota denominators',()=>{
  const s=snapshot();s.workspace.runs=Array.from({length:10},(_,i)=>({id:String(i),status:'failed'}));assertTrialWorkflowSnapshot(s);assert.equal(trialWorkflowUsage(s).runs,10);
  s.workspace.runs.push({id:'extra',status:'rejected'});assert.throws(()=>assertTrialWorkflowSnapshot(s),{code:'TRIAL_WORKFLOW_LIMIT'});
});
test('active assignments, metadata growth, and unexpected repositories fail before a snapshot is saved',()=>{
  const active=snapshot();active.workspace.runs=[{status:'assigned'},{status:'running'}];assert.throws(()=>assertTrialWorkflowSnapshot(active),{code:'TRIAL_WORKFLOW_LIMIT'});
  const other=snapshot();other.repositories.task='another-trial';assert.throws(()=>assertTrialWorkflowSnapshot(other),{code:'TRIAL_REPOSITORY_FORBIDDEN'});
  const large=snapshot();large.extra='x'.repeat(4*1024*1024);assert.throws(()=>assertTrialWorkflowSnapshot(large),{code:'TRIAL_WORKFLOW_LIMIT'});
  const forged=snapshot();forged.forks.run={name:'foreign'};assert.throws(()=>assertTrialWorkflowSnapshot(forged),{code:'TRIAL_REPOSITORY_FORBIDDEN'});
  const model=snapshot();model.jobs.job={};assert.throws(()=>assertTrialWorkflowSnapshot(model),{code:'TRIAL_MODEL_UNAVAILABLE'});
});
