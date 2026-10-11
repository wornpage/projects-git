import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore } from '../src/cloudflare/workspace-store.ts';
import { initialSnapshot } from '../src/cloudflare/controller.ts';

function sqlite() {
  const db = new DatabaseSync(':memory:');
  const writes = [];
  const storage = {
    sql: { exec(sql, ...args) {
      if (/^(INSERT|UPDATE|DELETE|DROP)/.test(sql)) writes.push(sql);
      const rows = db.prepare(sql).all(...args).map(row => ({ ...row }));
      return { toArray: () => rows, one() { assert.equal(rows.length, 1); return rows[0]; } };
    } },
    transactionSync(fn) {
      db.exec('BEGIN');
      try { const value = fn(); db.exec('COMMIT'); return value; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
  return { db, storage, writes };
}

function populated() {
  const state = initialSnapshot('store-test');
  state.revision = 4;
  state.workspace.sessionsValidAfter = 1791244800;
  state.workspace.reviewerNames = { 'configured-reviewer': 'Independent review agent' };
  state.workspace.projects.p = { id: 'p', name: 'Example', mainCommit: 'a'.repeat(40) };
  state.workspace.tasks = [{ id: 't', projectId: 'p', title: 'Keep records', revision: 2, revisions: [{ revision: 1, purpose: 'Before' }, { revision: 2, purpose: 'After' }], ownerHistory: [] }];
  state.workspace.runs = [{ id: 'r', taskId: 't', headCommit: 'b'.repeat(40), evidenceHistory: [{ taskRevision: 1, output: 'earlier result' }], reviewHistory: [{ note: 'Human note' }] }];
  state.workspace.events = [{ id: 'event', message: 'Retain exact order' }];
  state.operations.once = { kind: 'checks', fingerprint: 'exact', state: 'complete', itemId: 'r' };
  state.forks.r = { name: 'fork', remote: 'https://example.test/git/fork.git' };
  state.repositories.t = 'repo';
  state.checkPolicies.t = { revision: 2, command: 'test' };
  return state;
}

function legacy(db, snapshot) {
  db.exec('CREATE TABLE snapshot (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL)');
  db.prepare('INSERT INTO snapshot VALUES (1, ?, ?)').run(snapshot.revision, JSON.stringify(snapshot));
  db.exec('CREATE TABLE attempts (run_id TEXT PRIMARY KEY, receipt TEXT NOT NULL)');
  db.prepare('INSERT INTO attempts VALUES (?, ?)').run('r', '{"retained":true}');
}

test('migration preserves all workflow data, history, idempotency and receipts, then removes the old active layout', t => {
  const { db, storage } = sqlite(); t.after(() => db.close());
  const snapshot = populated(); legacy(db, snapshot);
  const store = new WorkspaceStore(storage, snapshot.workspace.id);
  assert.deepEqual(store.read(), snapshot);
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name = 'snapshot'").get().n, 0);
  assert.equal(db.prepare('SELECT receipt FROM attempts').get().receipt, '{"retained":true}');
  assert.equal(db.prepare('SELECT count(*) n FROM search_outbox').get().n, 1);
  assert.deepEqual(new WorkspaceStore(storage, 'store-test').read(), snapshot, 'Restart is idempotent');
});

test('failed migration rolls back every new table and preserves the original snapshot', t => {
  const { db, storage } = sqlite(); t.after(() => db.close());
  const snapshot = populated(); snapshot.workspace.runs[0].diff = 'x'.repeat(1_900_001); legacy(db, snapshot);
  assert.throws(() => new WorkspaceStore(storage, 'store-test'), { code: 'WORKSPACE_RECORD_LIMIT' });
  assert.equal(db.prepare('SELECT data FROM snapshot').get().data, JSON.stringify(snapshot));
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name = 'workspace_header'").get().n, 0);
});

test('total retained data and report histories exceed the former whole-workspace ceiling safely', t => {
  const { db, storage } = sqlite(); t.after(() => db.close());
  const snapshot = populated(); legacy(db, snapshot);
  const store = new WorkspaceStore(storage, 'store-test');
  const next = store.read();
  next.workspace.runs[0].evidenceHistory = Array.from({ length: 15 }, (_, i) => ({ taskRevision: i + 1, output: 'x'.repeat(150_000) }));
  next.revision++;
  assert.ok(JSON.stringify(next).length > 2_000_000);
  store.write(next, 4);
  assert.deepEqual(store.read(), next);
  const largest = db.prepare('SELECT max(length(data)) n FROM workspace_records').get().n;
  assert.ok(largest < 160_000, 'Report history is split across records, not packed into the candidate row');
});

test('revision conflicts and oversized records leave both workflow state and outbox unchanged', t => {
  const { db, storage } = sqlite(); t.after(() => db.close());
  const snapshot = populated(); legacy(db, snapshot);
  const store = new WorkspaceStore(storage, 'store-test');
  const stale = store.read(), next = store.read(); next.revision++;
  next.workspace.tasks[0].title = 'Changed'; store.write(next, 4);
  stale.revision++;
  assert.throws(() => store.write(stale, 4), { code: 'STATE_CONFLICT' });
  const oversized = store.read(); oversized.revision++; oversized.workspace.runs[0].diff = 'x'.repeat(1_900_001);
  assert.throws(() => store.write(oversized, 5), { code: 'WORKSPACE_RECORD_LIMIT' });
  assert.deepEqual(store.read(), next);
  assert.equal(db.prepare('SELECT revision FROM search_outbox WHERE project_id = ?').get('p').revision, 5);
});

test('writes touch changed records only and commit indexing intent atomically', t => {
  const { db, storage, writes } = sqlite(); t.after(() => db.close());
  legacy(db, populated()); const store = new WorkspaceStore(storage, 'store-test');
  writes.length = 0;
  const next = store.read(); next.revision++; next.workspace.tasks[0].title = 'One change';
  store.write(next, 4);
  assert.equal(writes.filter(sql => sql.startsWith('INSERT INTO workspace_records')).length, 1);
  assert.equal(db.prepare('SELECT revision FROM search_outbox').get().revision, 5);
  db.exec("CREATE TRIGGER fail_outbox BEFORE UPDATE ON search_outbox BEGIN SELECT RAISE(ABORT, 'Injected interruption'); END");
  const interrupted = store.read(); interrupted.revision++; interrupted.workspace.tasks[0].title = 'Must roll back';
  assert.throws(() => store.write(interrupted, 5), /Injected interruption/);
  assert.deepEqual(store.read(), next);
});

test('workspace identity cannot be rebound on restart or write', t => {
  const { db, storage } = sqlite(); t.after(() => db.close());
  const store = new WorkspaceStore(storage, 'store-test');
  assert.throws(() => new WorkspaceStore(storage, 'another'), { code: 'WORKSPACE_ID_MISMATCH' });
  const next = store.read(); next.revision++; next.workspace.id = 'another';
  assert.throws(() => store.write(next, 0), { code: 'WORKSPACE_ID_MISMATCH' });
  assert.equal(store.read().workspace.id, 'store-test');
});

test('index delivery is bounded, coalesces newer work and stale failures cannot overwrite a newer intent', t => {
  const { db, storage } = sqlite(); t.after(() => db.close());
  legacy(db, populated()); const store = new WorkspaceStore(storage, 'store-test');
  for (let attempt = 0; attempt < 4; attempt++) {
    assert.equal(store.pendingIndex(Number.MAX_SAFE_INTEGER).length, 1);
    store.delivered('p', 4, 0);
  }
  assert.equal(store.pendingIndex(Number.MAX_SAFE_INTEGER).length, 0);
  assert.equal(store.nextIndexAttempt(), null);
  const next = store.read(); next.revision++; next.workspace.tasks[0].title = 'New work'; store.write(next, 4);
  assert.equal(store.indexState('p').attempts, 0);
  store.indexFailure('p', 4, 'INDEX_FAILED', true);
  assert.equal(store.indexState('p').error_code, null);
  store.indexed('p', 4);
  assert.equal(store.pendingIndex(Number.MAX_SAFE_INTEGER).length, 1, 'Old completion cannot acknowledge newer intent');
  store.indexed('p', 5);
  assert.equal(store.pendingIndex(Number.MAX_SAFE_INTEGER).length, 0);
});

test('explicit rebuild advances immutable generation and stale rebuild guards refuse replay', t => {
  const { db, storage } = sqlite(); t.after(() => db.close());
  legacy(db, populated()); const store = new WorkspaceStore(storage, 'store-test');
  store.indexed('p', 4);
  const before = store.read();
  assert.equal(store.rebuild('p', 4).revision, 5);
  assert.deepEqual(store.read().workspace, before.workspace, 'Rebuilding search changes no workflow decision');
  assert.equal(store.read().revision, 5);
  assert.throws(() => store.rebuild('p', 4), { code: 'INDEX_REVISION_CONFLICT' });
});

test('verification waiters wake on committed revisions and can abort without polling',async t=>{
  const {db,storage}=sqlite();t.after(()=>db.close());legacy(db,populated());const store=new WorkspaceStore(storage,'store-test');
  const abort=new AbortController();let woke=false;const waiting=store.waitForChange(4,abort.signal).then(()=>woke=true);
  await Promise.resolve();assert.equal(woke,false);const next=store.read();next.revision++;store.write(next,4);await waiting;assert.equal(woke,true);
  await store.waitForChange(4,abort.signal);
  const cancellation=new AbortController(),pending=store.waitForChange(5,cancellation.signal);cancellation.abort(new Error('Admission cancelled'));
  await assert.rejects(pending,/Admission cancelled/);
});
