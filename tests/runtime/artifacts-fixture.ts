import { DurableObject, RpcTarget, WorkerEntrypoint } from 'cloudflare:workers';
import { createHash } from 'node:crypto';

// Test-only provider contract. Synthetic Git objects and inert credentials;
// production code never imports this module and no remote binding is configured.
const BASE = 'a'.repeat(40), HEAD = 'b'.repeat(40), OLD_TREE = 'c'.repeat(40), NEW_TREE = 'd'.repeat(40);
const source = `export function checkoutTotal(items) {
  if (!Array.isArray(items)) throw new TypeError('Cart must be an array');
  let total = 0;
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError('Item must be a record');
    if (!Number.isSafeInteger(item.unitCents) || item.unitCents < 0) throw new RangeError('Invalid price');
    if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0) throw new RangeError('Invalid quantity');
    const line = item.unitCents * item.quantity;
    if (!Number.isSafeInteger(line) || !Number.isSafeInteger(total + line)) throw new RangeError('Unsafe total');
    total += line;
  }
  return total;
}`;
const oldSource = 'export const checkoutTotal = () => 0;';
const python = 'import sys\nprint(sum(map(int, sys.stdin.read().split())))\n';
const blobHash = (source: string) => createHash('sha1').update(`blob ${new TextEncoder().encode(source).length}\0`).update(source).digest('hex');
const OLD_BLOB = blobHash(oldSource), NEW_BLOB = blobHash(source), PYTHON_BLOB = blobHash(python);
interface Repo { name: string; description: string | null; tokens: { id: string; state: string; scope: string }[] }

export class ArtifactsFixtureStore extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS repos (name TEXT PRIMARY KEY, data TEXT NOT NULL)');
    for (const name of ['starter', 'browser-starter']) this.ctx.storage.sql.exec('INSERT OR IGNORE INTO repos (name, data) VALUES (?, ?)', name, JSON.stringify({ name, description: 'Local Artifacts contract fixture', tokens: [] }));
  }
  read(name: string): Repo {
    const row = this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM repos WHERE name = ?', name).toArray()[0];
    if (!row) throw Object.assign(new Error('Fixture repository missing'), { code: 'NOT_FOUND' });
    return JSON.parse(row.data);
  }
  write(repo: Repo) { this.ctx.storage.sql.exec('INSERT OR REPLACE INTO repos (name, data) VALUES (?, ?)', repo.name, JSON.stringify(repo)); }
  info(name: string) {
    const repo = this.read(name);
    return { id: name, name, description: repo.description, defaultBranch: 'main', remote: `https://artifacts.example.test/fixture/${name}.git`,
      readOnly: false, createdAt: '2026-10-04T00:00:00Z', updatedAt: '2026-10-04T00:00:00Z', lastPushAt: null, source: null };
  }
  fork(sourceName: string, name: string, description: string) {
    this.read(sourceName);
    if (this.ctx.storage.sql.exec('SELECT name FROM repos WHERE name = ?', name).toArray().length) throw Object.assign(new Error('Fixture fork exists'), { code: 'ALREADY_EXISTS' });
    this.write({ name, description, tokens: [{ id: 'fixture-initial', state: 'active', scope: 'write' }] });
    return { ...this.info(name), token: 'fixture-initial' };
  }
  tokens(name: string) { const tokens = this.read(name).tokens; return { total: tokens.length, tokens }; }
  createToken(name: string, scope: string, ttl: number) {
    const repo = this.read(name), id = crypto.randomUUID();
    repo.tokens.push({ id, scope, state: 'active' }); this.write(repo);
    return { id, scope, plaintext: 'inert-fixture-' + id, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() };
  }
  revokeToken(name: string, id: string) {
    const repo = this.read(name), token = repo.tokens.find(token => token.id === id);
    if (!token) return false;
    token.state = 'revoked'; this.write(repo); return true;
  }
}

class FixtureRepo extends RpcTarget {
  constructor(private store: DurableObjectStub<ArtifactsFixtureStore>, private name: string) { super(); }
  info() { return this.store.info(this.name); }
  fork(name: string, options: { description: string }) { return this.store.fork(this.name, name, options.description); }
  listTokens() { return this.store.tokens(this.name); }
  createToken(scope = 'write', ttl = 900) { return this.store.createToken(this.name, scope, ttl); }
  revokeToken(id: string) { return this.store.revokeToken(this.name, id); }
  readCommit(hash: string) {
    return [BASE, HEAD].includes(hash) ? { hash, treeHash: hash === BASE ? OLD_TREE : NEW_TREE, parents: hash === BASE ? [] : [BASE],
      message: 'Synthetic local fixture commit', author: { name: 'Fixture', email: 'fixture@example.test' }, committer: { name: 'Fixture', email: 'fixture@example.test' }, authoredAt: 1, committedAt: 1 } : null;
  }
  readTree(hash: string) { return [OLD_TREE, NEW_TREE].includes(hash) ? [{ name: 'checkout.mjs', mode: '100644', type: 'blob', hash: hash === OLD_TREE ? OLD_BLOB : NEW_BLOB }, { name: 'sum.py', mode: '100644', type: 'blob', hash: PYTHON_BLOB }] : null; }
  readBlob(hash: string) { return [OLD_BLOB, NEW_BLOB, PYTHON_BLOB].includes(hash) ? new Blob([hash === OLD_BLOB ? oldSource : hash === NEW_BLOB ? source : python]) : null; }
  log({ ref }: { ref: string }) { return ref === 'main' ? [this.readCommit(BASE)] : ref.startsWith('agents/') ? [this.readCommit(HEAD)] : []; }
}

export class ArtifactsFixture extends WorkerEntrypoint<{ FIXTURE_REPOS: DurableObjectNamespace<ArtifactsFixtureStore> }> {
  async get(name: string) {
    const store = this.env.FIXTURE_REPOS.getByName('local-contract-fixture');
    await store.info(name);
    return new FixtureRepo(store, name);
  }
}
