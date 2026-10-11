import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { projectDocuments, RetainedIndex } from '../src/cloudflare/search-index.ts';
import { createWorkspace, createTask, assignRun, startRun, completeRun, reviewRun, reviseTask } from '../src/core/workflow.mjs';

function fixture() {
  return { id: 'workspace', projects: { p: { name: 'Main' }, other: { name: 'Other' } },
    tasks: [{ id: 'task', projectId: 'p', title: 'Retain code', purpose: 'Keyboard access', criteria: ['Selectable instructions'], revision: 2,
      revisions: [{ revision: 1, purpose: 'Clipboard only', criteria: ['Copy instructions'], reason: 'Original' }] },
      { id: 'hidden', projectId: 'other', title: 'Secret other project', purpose: 'Separate', criteria: [] }],
    runs: [{ id: 'run', taskId: 'task', label: 'UI', summary: 'Keyboard fallback', changedFiles: ['agent-panel.js'], headCommit: 'b'.repeat(40),
      diff: 'DO_NOT_INDEX_DIFF', checkout: '/private/path', execution: { credential: 'DO_NOT_INDEX_CREDENTIAL' },
      evidence: { taskRevision: 2, commit: 'b'.repeat(40), output: 'DO_NOT_INDEX_OUTPUT' },
      evidenceHistory: [{ taskRevision: 1, commit: 'a'.repeat(40) }],
      reviewHistory: [{ taskRevision: 1, headCommit: 'a'.repeat(40), note: 'Earlier rejected approach' }] }], events: [] };
}

// Real SQLite statements/transactions; only the D1 transport surface is adapted.
function database(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(readFileSync(new URL('../migrations/search/0001_retained_work.sql', import.meta.url), 'utf8'));
  let batches = 0, failBatch = Infinity;
  const prepare = (sql, args = []) => ({
    bind: (...args) => prepare(sql, args),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => db.prepare(sql).run(...args),
  });
  const session = { prepare, async batch(statements) {
    if (++batches === failBatch) throw new Error('Injected D1 transport failure');
    db.exec('BEGIN');
    try { for (const statement of statements) await statement.run(); db.exec('COMMIT'); }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  } };
  return { db, index: new RetainedIndex({ withSession: mode => { assert.equal(mode, 'first-primary'); return session; } }), failNextBatch: () => { failBatch = batches + 1; } };
}

test('projection pins historical requirements and commits and excludes other projects and private execution fields', () => {
  const workspace = fixture(), before = structuredClone(workspace);
  const docs = projectDocuments(workspace, 'p');
  assert.equal(docs.length, 4);
  assert.equal(new Set(docs.map(doc => doc.id)).size, 4);
  assert.doesNotMatch(JSON.stringify(docs), /DO_NOT_INDEX|private\/path|Secret other/);
  const old = docs.find(doc => doc.headCommit === 'a'.repeat(40));
  assert.equal(old.taskRevision, 1);
  assert.match(old.text, /Earlier rejected approach/);
  assert.doesNotMatch(old.text, /Keyboard fallback|agent-panel/);
  assert.match(docs.find(doc => doc.headCommit === 'b'.repeat(40)).text, /Keyboard fallback/);
  assert.deepEqual(workspace, before);
  assert.throws(() => projectDocuments(workspace, '__proto__'), { code: 'PROJECT_NOT_FOUND' });
});

test('unverified rejection notes remain searchable after a real requirements revision and when archived', async t => {
  const { index } = database(t);
  const workspace = createWorkspace({ id: 'workspace' });
  workspace.projects = { p: { id: 'p', name: 'Project' } };
  const task = createTask(workspace, { title: 'Candidate history', purpose: 'Keep useful notes', criteria: ['Retain decisions'], baseCommit: 'a'.repeat(40), owner: 'QA' });
  task.projectId = 'p';
  const run = assignRun(workspace, task.id, { agent: 'Fixture', label: 'Candidate', branch: 'agent/history' });
  startRun(workspace, run.id);
  completeRun(workspace, run.id, { headCommit: 'b'.repeat(40), changedFiles: ['notes.txt'], diff: '+notes', summary: 'A retained alternative' });
  reviewRun(workspace, run.id, { decision: 'reject', note: 'unique-rejection-before-checks', reviewer: 'QA', headCommit: run.headCommit, taskRevision: 1 });
  assert.equal(run.evidence, null);
  reviseTask(workspace, task.id, { expectedRevision: 1, purpose: 'Keep prior decisions after clarification', criteria: ['Retain decisions', 'Keep historical intent'], reason: 'Clarification' });
  const currentReview = structuredClone(run.review);
  for (const archived of [false, true]) {
    if (archived) { run.reviewHistory = [run.review]; run.review = null; }
    const documents = projectDocuments(workspace, 'p');
    const historical = documents.filter(doc => doc.text.includes('unique-rejection-before-checks'));
    assert.equal(historical.length, 1);
    assert.equal(historical[0].taskRevision, 1);
    assert.equal(historical[0].headCommit, run.headCommit);
    await index.replace(workspace.id, 'p', archived ? 3 : 2, documents);
    assert.equal((await index.search(workspace.id, 'p', 'unique-rejection-before-checks')).matched, 1);
  }
  assert.deepEqual(run.reviewHistory[0], currentReview, 'Projection preserves the original decision');
});

test('D1 search scopes workspace/project and preserves counts, literal matching and exact identities', async t => {
  const { index } = database(t), docs = projectDocuments(fixture(), 'p');
  await index.replace('workspace', 'p', 2, docs);
  const result = await index.search('workspace', 'p', 'keyboard fallback');
  assert.equal(result.total, 4); assert.equal(result.matched, 1); assert.equal(result.items[0].runId, 'run');
  assert.equal(result.items[0].taskRevision, 2); assert.equal(result.items[0].headCommit, 'b'.repeat(40));
  assert.equal((await index.search('workspace', 'p', "%' OR 1=1 --")).matched, 0);
  assert.equal((await index.search('wrong-workspace', 'p', '')).total, 0);
  assert.equal((await index.search('workspace', 'other', '')).total, 0);
  await assert.rejects(index.replace('workspace', 'other', 3, docs), { code: 'INDEX_SCOPE_MISMATCH' });
});

test('duplicate delivery is idempotent, old delivery cannot replace newer results, equal-generation edits refuse', async t => {
  const { index, db } = database(t), docs = projectDocuments(fixture(), 'p');
  await index.replace('workspace', 'p', 2, docs);
  await index.replace('workspace', 'p', 2, docs);
  assert.equal(db.prepare('SELECT count(*) n FROM retained_documents').get().n, 4);
  const changed = structuredClone(docs); changed[0].text = 'Newly searchable';
  await assert.rejects(index.replace('workspace', 'p', 2, changed), { code: 'INDEX_GENERATION_CONFLICT' });
  await index.replace('workspace', 'p', 3, changed);
  await index.replace('workspace', 'p', 2, docs);
  assert.equal((await index.search('workspace', 'p', 'Newly')).generation, 3);
  assert.equal((await index.search('workspace', 'p', 'Newly')).matched, 1);
});

test('incomplete generation never becomes searchable and a retry completes the same build', async t => {
  const { index, failNextBatch } = database(t), docs = projectDocuments(fixture(), 'p');
  await index.replace('workspace', 'p', 1, docs);
  const changed = structuredClone(docs); changed[0].text = 'New generation';
  failNextBatch();
  await assert.rejects(index.replace('workspace', 'p', 2, changed), /Injected D1/);
  assert.equal((await index.search('workspace', 'p', '')).generation, 1);
  await index.replace('workspace', 'p', 2, changed);
  assert.equal((await index.search('workspace', 'p', 'New generation')).matched, 1);
});

test('bounded paging reports full denominator and reaches every document without repetition', async t => {
  const { index } = database(t), doc = projectDocuments(fixture(), 'p')[0];
  const docs = Array.from({ length: 53 }, (_, i) => ({ ...doc, id: 'document-' + String(i).padStart(2, '0') }));
  await index.replace('workspace', 'p', 1, docs);
  const seen = new Set(); let offset = 0;
  do {
    const page = await index.search('workspace', 'p', '', offset);
    assert.equal(page.total, 53); assert.equal(page.matched, 53); assert.ok(page.items.length <= 20);
    for (const item of page.items) { assert.ok(!seen.has(item.id)); seen.add(item.id); }
    offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(seen.size, 53);
});

test('cleanup is scoped, bounded and restartable, retaining IDs until vector deletion succeeds', async t => {
  const { index, db } = database(t), doc = projectDocuments(fixture(), 'p')[0];
  const old = Array.from({ length: 150 }, (_, i) => ({ ...doc, id: 'old-' + i }));
  await index.replace('workspace', 'p', 1, old);
  await index.replace('workspace', 'p', 2, [doc]);
  const foreign = { ...doc, projectId: 'other' };
  await index.replace('workspace', 'other', 1, [foreign]);
  await assert.rejects(index.cleanup('workspace', 'p', async () => { throw new Error('Delete unconfirmed'); }), /Delete unconfirmed/);
  assert.equal(db.prepare('SELECT count(*) n FROM retained_documents WHERE project_id = ? AND generation = 1').get('p').n, 150);
  const deleted = [];
  assert.equal(await index.cleanup('workspace', 'p', async rows => { deleted.push(...rows); }), true);
  assert.equal(deleted.length, 100);
  assert.equal(await index.cleanup('workspace', 'p', async rows => { deleted.push(...rows); }), false);
  assert.equal(deleted.length, 150);
  assert.equal((await index.search('workspace', 'p', '')).total, 1);
  assert.equal((await index.search('workspace', 'other', '')).total, 1);
});
