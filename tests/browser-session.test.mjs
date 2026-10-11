import test from 'node:test';
import assert from 'node:assert/strict';
import {createBrowserSession} from '../public/browser-session.js';

function fixture() {
  const data = new Map(), warnings = [];
  const maps = {drafts: new Map(), disclosures: new Map(), assignmentRequests: new Map(), operationRequests: new Map(),projectSelections:new Map()};
  const storage = {getItem: key => data.get(key), setItem: (key, value) => data.set(key, value)};
  const session = createBrowserSession({...maps, storage: () => storage, onWarning: value => warnings.push(value)});
  return {...maps, data, storage, session, warnings};
}
const workspace = {id:'one', projects:{project: {id:'project'}}, tasks:[{id:'task',projectId:'project'}],runs:[]};
const composer = {source:'project:project', name:'', repo:'', base:'', tasks:[{title:'Saved', purpose:'Purpose', criteria:'One\nTwo', owner:'Owner'}], pending:null};

test('hosted assignment retry retains its exact selected agent across reload',()=>{
  const f=fixture(),agentClientId='1'.repeat(32)+'.access',requestId=crypto.randomUUID();
  const state={...workspace,authentication:{principal:{issuer:'https://fixture.cloudflareaccess.com',kind:'owner',id:'owner'},agentClientIds:[agentClientId]}};
  f.session.enter(state);f.assignmentRequests.set('task',{label:'Agent',requestId,agentClientId});f.session.save(composer);
  f.session.enter({...state,id:'other'});f.session.enter(state);
  assert.deepEqual(f.assignmentRequests.get('task'),{label:'Agent',requestId,agentClientId});
});

test('authenticated drafts and operation IDs cannot cross principal boundaries in the same workspace',()=>{
  const f=fixture(),owner={...workspace,authentication:{mode:'cloudflare-access',principal:{issuer:'https://team.cloudflareaccess.com',kind:'owner',id:'owner'}}};
  f.session.enter(owner);f.drafts.set('draft',{runId:'run',note:'Owner note',reviewer:'Verified owner'});f.session.save(composer);
  const agent={...owner,authentication:{...owner.authentication,principal:{...owner.authentication.principal,kind:'agent',id:'agent'}}};
  f.session.enter(agent);assert.equal(f.drafts.size,0);assert.equal(f.operationRequests.size,0);
  f.session.enter({...owner,authentication:{...owner.authentication,principal:{...owner.authentication.principal,issuer:'https://another.cloudflareaccess.com'}}});assert.equal(f.drafts.size,0);
  f.session.enter(owner);assert.equal(f.drafts.get('draft').note,'Owner note');
  f.session.enter(workspace);assert.equal(f.drafts.size,0);
});

test('saved drafts, request IDs and composer survive reload without saving credentials', () => {
  const f = fixture(); f.session.enter(workspace);
  f.drafts.set('context', {runId:'run', note:'Inspected', reviewer:'User', comparisonKey:'[]'});
  const requestId=crypto.randomUUID(), path='/api/runs/' + crypto.randomUUID() + '/checks';
  f.assignmentRequests.set('task', {requestId, label:'Agent'});
  f.operationRequests.set(path, {requestId, fingerprint:'a'.repeat(64)});
  f.disclosures.set('panel', true);
  for(let i=0;i<310;i++) f.disclosures.set('other-' + i, false);
  const savedComposer={...composer, pending:{source:'project', projectId:'project', requestId, tasks:[{title:'Exact body', purpose:'Purpose', owner:'Owner', criteria:['One','Two']}]}};
  f.session.save(savedComposer);
  assert.equal(f.data.size,1);
  const raw = JSON.parse(f.data.get('projects-git-ui:one'));
  assert.deepEqual(Object.keys(raw),['drafts','disclosures','assignments','operations','projects','composer','reviewerName']);
  assert.equal(raw.disclosures.length,300);
  f.session.enter({...workspace,id:'two'});
  assert.equal(f.drafts.size,0); assert.equal(f.assignmentRequests.size,0);
  const saved = f.session.enter(workspace);
  assert.deepEqual(saved.composer.pending,savedComposer.pending);
  assert.deepEqual(f.drafts.get('context'), {runId:'run', note:'Inspected', reviewer:'User', comparisonKey:'[]'});
  assert.equal(f.operationRequests.get(path).requestId,requestId);
  assert.equal(f.assignmentRequests.get('task').requestId,requestId);
  assert.deepEqual(f.session.enter(workspace),{changed:false});
});

test('project selection is restored only within its actual task and workspace',()=>{
  const f=fixture(),state={...workspace,projects:{...workspace.projects,other:{id:'other'}},
    tasks:[...workspace.tasks,{id:'other-task',projectId:'other'}],runs:[{id:'run',taskId:'task'}]};
  f.session.enter(state);f.projectSelections.set('project',{taskId:'task',runId:'run'});f.session.save(null);
  f.session.enter({...state,id:'two'});assert.equal(f.projectSelections.size,0);
  f.session.enter(state);assert.deepEqual(f.projectSelections.get('project'),{taskId:'task',runId:'run'});
  f.data.set('projects-git-ui:one',JSON.stringify({projects:[['project',{taskId:'other-task',runId:'run'}],['missing',{taskId:'task',runId:'run'}]]}));
  f.session.enter({...state,id:'two'});f.session.enter(state);assert.equal(f.projectSelections.size,0);
});

test('malformed map entries and drafts from missing projects are not restored', () => {
  const f=fixture();
  f.data.set('projects-git-ui:one',JSON.stringify({assignments:[null,['task',null],['missing',{requestId:crypto.randomUUID(),label:'Agent'}]],
    operations:{bad:'shape'}, drafts:[null,['bad',{runId:'run',note:1,reviewer:'User'}],['good',{runId:'run',note:'Keep',reviewer:'User'}]],
    composer:{...composer,source:'project:missing'},disclosures:[['good',true],['bad','true']]}));
  assert.equal(f.session.enter(workspace).composer,null);
  assert.equal(f.drafts.size,1); assert.equal(f.assignmentRequests.size,0); assert.equal(f.operationRequests.size,0);
  assert.deepEqual([...f.disclosures],[['good',true]]);
});

test('unavailable storage reports a warning while leaving in-memory review text intact', () => {
  const f=fixture(); f.storage.getItem=()=>{throw new Error('disabled');};
  assert.equal(f.session.enter(workspace).changed,true); assert.equal(f.session.warning,true);
  f.drafts.set('context',{runId:'run',note:'Keep this text',reviewer:'User'});
  f.storage.setItem=()=>{throw new Error('quota');}; f.session.save(composer);
  assert.equal(f.drafts.get('context').note,'Keep this text'); assert.equal(f.warnings.length,2);
  f.storage.getItem=()=>null; f.session.enter({...workspace,id:'two'}); assert.equal(f.session.warning,false);
});

test('reviewer name is explicitly entered, bounded and scoped to the workspace tab', () => {
  const f=fixture();f.session.enter(workspace);
  assert.equal(f.session.getReviewerName(),'');
  f.session.rememberReviewerName('  Reviewer One  ');f.session.save(composer);
  assert.equal(f.session.getReviewerName(),'Reviewer One');
  f.session.enter({...workspace,id:'two'});assert.equal(f.session.getReviewerName(),'');
  f.session.rememberReviewerName('Reviewer Two');f.session.save(null);
  f.session.enter(workspace);assert.equal(f.session.getReviewerName(),'Reviewer One');
  assert.throws(()=>f.session.rememberReviewerName('x'.repeat(101)),/100/);
  f.session.rememberReviewerName('');f.session.save(composer);
  f.session.enter({...workspace,id:'two'});f.session.enter(workspace);assert.equal(f.session.getReviewerName(),'');
});

test('malformed saved reviewer names are ignored without losing valid review drafts', () => {
  const f=fixture();f.data.set('projects-git-ui:one',JSON.stringify({reviewerName:{token:'not-a-name'},drafts:[['saved',{runId:'run',note:'Keep',reviewer:'Explicit name'}]]}));
  f.session.enter(workspace);assert.equal(f.session.getReviewerName(),'');assert.equal(f.drafts.get('saved').reviewer,'Explicit name');
});
