import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SemanticSearch, searchScope, vectorId, embeddingExcerpt, removeIndexedVectors } from '../src/cloudflare/semantic-search.ts';

function setup(t, { limit = 100, provider, omitNamespace = false } = {}) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const storage = { sql: { exec(sql, ...args) {
    const rows = db.prepare(sql).all(...args).map(row => ({ ...row }));
    return { toArray: () => rows, one: () => { assert.equal(rows.length, 1); return rows[0]; } };
  } }, transactionSync(fn) {
    db.exec('BEGIN'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
  } };
  let calls = 0, upserts = 0, visible = true, injected = [];
  const records = new Map();
  const responseVector = item => {
    if (!omitNamespace) return item;
    const { namespace, ...response } = item;
    return response;
  };
  const vectors = {
    async getByIds(ids) { return visible ? ids.flatMap(id => records.has(id) ? [responseVector(records.get(id))] : []) : []; },
    async upsert(items) { upserts++; for (const item of items) records.set(item.id, structuredClone(item)); return { mutationId: 'fixture' }; },
    async query(values, options) {
      assert.equal(options.filter.scope, options.namespace);
      return { matches: [...records.values()].filter(item => item.namespace === options.namespace && item.metadata.generation === options.filter.generation).map(item => ({ ...responseVector(item), score: 0.8 })).concat(injected), count: records.size };
    },
    async deleteByIds(ids) { for (const id of ids) records.delete(id); },
  };
  const embed = async text => { calls++; return provider ? provider(text) : { data: [Array.from({ length: 768 }, (_, i) => i === 0 ? 1 : 0)] }; };
  const semantic = new SemanticSearch(storage, vectors, embed, limit);
  return { semantic, db, storage, vectors, embed, records, calls: () => calls, upserts: () => upserts, visibility(value) { visible = value; }, inject(items) { injected = items; } };
}
const docs = [{ id: 'doc', workspaceId: 'w', projectId: 'p', taskId: 't', runId: 'r', headCommit: 'a'.repeat(40), taskRevision: 2, title: 'Keyboard access', text: 'Manual keyboard copying' }];

test('documented Vectorize responses can omit namespace echoes while retaining exact scope and identity', async t => {
  const s = setup(t, { omitNamespace: true });
  await s.semantic.index('w', 'p', 1, docs);
  assert.equal(s.semantic.generation('p'), 1);
  await s.semantic.index('w', 'p', 1, docs);
  assert.equal(s.upserts(), 1, 'A missing optional echo does not trigger a repeated upsert.');
  assert.deepEqual(await s.semantic.search('w', 'p', 1, 'Find work'), [{ documentId: 'doc', score: 0.8 }]);
  const { namespace, ...good } = [...s.records.values()][0];
  s.inject([
    { ...good, score: 0.99, namespace: 'foreign' },
    { ...good, score: 0.99, metadata: { ...good.metadata, scope: 'foreign' } },
    { ...good, score: 0.99, metadata: { ...good.metadata, generation: 0 } },
    { ...good, score: 0.99, id: vectorId(namespace, 1, 'forged') },
  ]);
  assert.deepEqual(await s.semantic.search('w', 'p', 1, 'Find work'), [{ documentId: 'doc', score: 0.8 }]);
});

test('duplicate indexing, queries and process reconstruction reuse durable embeddings', async t => {
  const s = setup(t);
  await s.semantic.index('w', 'p', 1, docs);
  await s.semantic.index('w', 'p', 1, docs);
  assert.equal(s.calls(), 1); assert.equal(s.upserts(), 1);
  assert.deepEqual(await s.semantic.search('w', 'p', 1, 'Find manual copying'), [{ documentId: 'doc', score: 0.8 }]);
  const restarted = new SemanticSearch(s.storage, s.vectors, s.embed, 100);
  await restarted.search('w', 'p', 1, 'Find manual copying');
  assert.equal(s.calls(), 2, 'Each distinct document/query excerpt invokes the provider at most once');
});

test('eventual Vectorize visibility is pending, then retry reuses the same embeddings', async t => {
  const s = setup(t); s.visibility(false);
  await assert.rejects(s.semantic.index('w', 'p', 1, docs), { code: 'VECTOR_INDEX_PENDING' });
  assert.equal(s.semantic.generation('p'), null);
  s.visibility(true);
  await s.semantic.index('w', 'p', 1, docs);
  assert.equal(s.calls(), 1);
  assert.equal(s.semantic.generation('p'), 1);
});

test('61 delayed-visibility documents stage in one delivery and publish on the next without regeneration', async t => {
  const s = setup(t);
  const batch = Array.from({ length: 61 }, (_, i) => ({ ...docs[0], id: 'doc-' + i, text: 'Distinct retained change ' + i }));
  s.visibility(false);
  await assert.rejects(s.semantic.index('w', 'p', 1, batch), { code: 'VECTOR_INDEX_PENDING' });
  assert.equal(s.records.size, 61, 'Pending visibility must not prevent later batches from being staged');
  assert.equal(s.upserts(), 4);
  assert.equal(s.calls(), 61);
  assert.equal(s.semantic.generation('p'), null, 'Unobserved vectors cannot publish a generation');
  s.visibility(true);
  const restarted = new SemanticSearch(s.storage, s.vectors, s.embed, 100);
  await restarted.index('w', 'p', 1, batch);
  assert.equal(restarted.generation('p'), 1);
  assert.equal(s.calls(), 61, 'The retry uses retained embeddings');
  assert.equal(s.upserts(), 4, 'Visible vectors do not require resubmission');
});

test('a foreign document in a later batch is rejected before any embedding or vector write', async t => {
  const s = setup(t);
  const batch = Array.from({ length: 21 }, (_, i) => ({ ...docs[0], id: 'doc-' + i, projectId: i === 20 ? 'other' : 'p' }));
  await assert.rejects(s.semantic.index('w', 'p', 1, batch), { code: 'INDEX_SCOPE_MISMATCH' });
  assert.equal(s.calls(), 0);
  assert.equal(s.upserts(), 0);
});

test('failed and uncertain embedding attempts do not regenerate on retries or restart', async t => {
  let complete;
  const s = setup(t, { provider: () => new Promise(resolve => { complete = resolve; }) });
  const attempt = s.semantic.embedding('scope', 'work');
  await assert.rejects(s.semantic.embedding('scope', 'work'), { code: 'EMBEDDING_ATTEMPT_RETAINED' });
  const restart = new SemanticSearch(s.storage, s.vectors, s.embed, 100);
  await assert.rejects(restart.embedding('scope', 'work'), { code: 'EMBEDDING_ATTEMPT_RETAINED' });
  complete({ data: [[]] });
  await assert.rejects(attempt, { code: 'EMBEDDING_FAILED' });
  await assert.rejects(restart.embedding('scope', 'work'), { code: 'EMBEDDING_ATTEMPT_RETAINED' });
  assert.equal(s.calls(), 1);
});

test('finite budget is reserved before provider I/O and caches remain usable after exhaustion', async t => {
  const s = setup(t, { limit: 1 });
  await s.semantic.embedding('scope', 'one');
  await assert.rejects(s.semantic.embedding('scope', 'two'), { code: 'EMBEDDING_BUDGET_EXHAUSTED' });
  await s.semantic.embedding('scope', 'one');
  assert.equal(s.calls(), 1);
  assert.equal(s.db.prepare('SELECT calls FROM search_embedding_budget').get().calls, 1);
});

test('foreign, stale, duplicate and forged vector matches never escape project scope', async t => {
  const s = setup(t);
  await s.semantic.index('w', 'p', 1, docs);
  const scope = searchScope('w', 'p'), good = [...s.records.values()][0];
  s.inject([
    { ...good, score: 0.99, namespace: searchScope('other', 'p') },
    { ...good, score: 0.99, metadata: { ...good.metadata, generation: 0 } },
    { ...good, score: 0.99, id: vectorId(scope, 1, 'forged') },
    { ...good, score: 0.99 },
  ]);
  assert.deepEqual(await s.semantic.search('w', 'p', 1, 'Find work'), [{ documentId: 'doc', score: 0.8 }]);
  await assert.rejects(s.semantic.search('w', 'p', 2, 'Find work'), { code: 'SEMANTIC_INDEX_NOT_CURRENT' });
  await assert.rejects(s.semantic.index('w', 'other', 1, docs), { code: 'INDEX_SCOPE_MISMATCH' });
});

test('embedding excerpts have a UTF-8 byte bound and preserve whole Unicode characters', () => {
  const excerpt = embeddingExcerpt('😀'.repeat(300));
  assert.equal(new TextEncoder().encode(excerpt).length, 480);
  assert.equal(excerpt, '😀'.repeat(120));
});

test('vector cleanup refuses unconfirmed deletion and uses project/generation-qualified IDs', async t => {
  const s = setup(t);
  await s.semantic.index('w', 'p', 1, docs);
  await s.semantic.index('w', 'p', 2, docs);
  await s.semantic.index('w', 'other', 1, docs.map(doc => ({ ...doc, projectId: 'other' })));
  await assert.rejects(removeIndexedVectors({ ...s.vectors, deleteByIds: async () => ({ mutationId: 'pending' }) }, 'w', 'p', [{ generation: 1, document_id: 'doc' }]), { code: 'VECTOR_CLEANUP_PENDING' });
  await removeIndexedVectors(s.vectors, 'w', 'p', [{ generation: 1, document_id: 'doc' }]);
  assert.equal(s.records.size, 2);
  assert.ok(s.records.has(vectorId(searchScope('w', 'p'), 2, 'doc')));
  assert.ok(s.records.has(vectorId(searchScope('w', 'other'), 1, 'doc')));
});
