import test from 'node:test';
import assert from 'node:assert/strict';
import {createRetainedSearch} from '../public/ui/retained-search.js';

// Execute the production async handlers with controlled transport promises.
// DOM rendering and result projection have separate browser/selector coverage.
function fixture() {
  const project = { id: 'project' };
  const state = { remote: { index: { revision: 1 }, generation: 1, items: [] }, request: 0, draft: 'old', query: 'old', mode: 'literal', loading: false, error: '' };
  const calls = [], announcements = [], renders = [], errors = [];
  const context = {
    workspace: { id: 'workspace', projects:{[project.id]:project}, tasks:[],runs:[] }, retainedSearches: new Map([[project.id, state]]), view: 'history',
    currentProject: () => project, render:()=>renders.push(context.view), announce: text => announcements.push(text), showError:message=>errors.push(message), indexedSearchResults: () => [],
    URLSearchParams, api: (path, body) => new Promise((resolve, reject) => calls.push({ path, body, resolve, reject })),
  };
  Object.assign(context,createRetainedSearch({...context,getContext:()=>context}));
  return { context, state, project, calls, announcements, renders, errors,
    rebuild: () => context.rebuildSearch(project, state),
    clearAndSearch: () => { state.draft = ''; state.query = ''; state.remote = null; state.mode = 'literal'; return context.loadIndexedSearch(project, state); } };
}
const response = { generation: 2, items: [], total: 0, matched: 0, nextOffset: null, mode: 'literal', index: { revision: 2 } };

test('a delayed rebuild rejection cannot overwrite a newer successful Clear/search', async () => {
  const f = fixture(), old = f.rebuild();
  const current = f.clearAndSearch();
  f.calls[1].resolve(response); await current;
  f.calls[0].reject(new Error('Stale rebuild failed')); await old;
  assert.equal(f.state.error, '');
  assert.equal(f.state.remote.generation, 2);
  assert.equal(f.state.loading, false);
  assert.equal(f.calls.length, 2);
});

for (const success of [true, false]) test(`superseded rebuild ${success ? 'success' : 'failure'} cannot stop or replace an in-flight search`, async () => {
  const f = fixture(), old = f.rebuild();
  const current = f.clearAndSearch();
  if (success) f.calls[0].resolve({ revision: 2 });
  else f.calls[0].reject(new Error('Stale rebuild failed'));
  await old;
  assert.equal(f.state.loading, true, 'Loading belongs to the newer request');
  assert.equal(f.state.error, '');
  assert.equal(f.calls.length, 2, 'Old success cannot launch another follow-up search');
  f.calls[1].resolve(response); await current;
  assert.equal(f.state.loading, false);
});

test('rebuild completion after workspace replacement cannot start a search or mutate the old state', async () => {
  const f = fixture(), old = f.rebuild();
  f.context.workspace = { id: 'other' };
  f.context.retainedSearches.clear();
  const before = structuredClone(f.state);
  f.calls[0].resolve({ revision: 2 }); await old;
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.state, before);
});

test('a current rebuild failure remains visible and releases its own loading state', async () => {
  const f = fixture(), work = f.rebuild();
  f.calls[0].reject(new Error('Current rebuild failed')); await work;
  assert.equal(f.state.error, 'Current rebuild failed');
  assert.equal(f.state.loading, false);
});

test('a current rebuild refreshes results and leaves state ownership to its follow-up search', async () => {
  const f = fixture(), work = f.rebuild();
  f.calls[0].resolve({ revision: 2 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 2);
  assert.equal(f.state.loading, true);
  f.calls[1].resolve(response); await work;
  assert.equal(f.state.remote.generation, 2);
  assert.equal(f.state.error, '');
  assert.equal(f.state.loading, false);
});

test('current project history search redraws results and clears the visible loading state',async()=>{
 const f=fixture(),work=f.clearAndSearch();assert.deepEqual(f.renders,['history']);
 f.calls[0].resolve(response);await work;
 assert.equal(f.state.loading,false);assert.deepEqual(f.renders,['history','history']);assert.deepEqual(f.announcements,['0 indexed results shown.']);
});

test('history errors are visible there while late completion cannot redraw an individual candidate record',async()=>{
 const f=fixture(),failed=f.clearAndSearch();f.calls[0].reject(new Error('History unavailable'));await failed;
 assert.deepEqual(f.errors,['History unavailable']);assert.deepEqual(f.renders,['history','history']);
 const later=f.clearAndSearch();const count=f.renders.length;f.context.view='evidence';f.calls[1].resolve(response);await later;
 assert.equal(f.renders.length,count);assert.deepEqual(f.announcements,[]);assert.equal(f.state.loading,false);
});
