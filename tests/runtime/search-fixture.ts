import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';

// Deterministic local contract fixture, never an embedding-quality benchmark.
type FixtureEnv = Env & { SEARCH_FIXTURES: DurableObjectNamespace<SearchFixtureStore>; FIXTURE_VECTOR_VISIBILITY_DELAY_MS?: string };
export class SearchFixtureStore extends DurableObject<FixtureEnv> {
  constructor(ctx: DurableObjectState, env: FixtureEnv) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS vectors (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
    if (!ctx.storage.sql.exec<{ name: string }>('PRAGMA table_info(vectors)').toArray().some(column => column.name === 'visible_at')) {
      ctx.storage.sql.exec('ALTER TABLE vectors ADD COLUMN visible_at INTEGER NOT NULL DEFAULT 0');
    }
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS calls (id INTEGER PRIMARY KEY, total INTEGER NOT NULL)');
    ctx.storage.sql.exec('INSERT INTO calls VALUES (1, 0) ON CONFLICT DO NOTHING');
  }
  recordCall() { this.ctx.storage.sql.exec('UPDATE calls SET total = total + 1 WHERE id = 1'); }
  upsert(items: VectorizeVector[]) {
    const delay = Number(this.env.FIXTURE_VECTOR_VISIBILITY_DELAY_MS ?? '0');
    if (!Number.isSafeInteger(delay) || delay < 0 || delay > 2000) throw new Error('Fixture vector visibility delay must be between 0 and 2000 ms.');
    const visibleAt = Date.now() + delay;
    for (const item of items) this.ctx.storage.sql.exec('INSERT INTO vectors (id, data, visible_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, visible_at = excluded.visible_at', item.id, JSON.stringify(item), visibleAt);
    return { mutationId: crypto.randomUUID() };
  }
  getByIds(ids: string[]): VectorizeVector[] {
    return ids.flatMap(id => this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM vectors WHERE id = ? AND visible_at <= ?', id, Date.now()).toArray().map(row => {
      const { namespace, ...response } = JSON.parse(row.data);
      return response;
    }));
  }
  query(values: number[], options: VectorizeQueryOptions) {
    const records = this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM vectors WHERE visible_at <= ?', Date.now()).toArray().map(row => JSON.parse(row.data) as VectorizeVector);
    const matches = records.filter(item => item.namespace === options.namespace && item.metadata?.scope === options.filter?.scope && item.metadata?.generation === options.filter?.generation)
      .map(item => {
        const { namespace, ...response } = item;
        return { ...response, score: Array.from(item.values).reduce((sum, n, i) => sum + n * values[i], 0) };
      }).sort((a, b) => b.score - a.score).slice(0, options.topK);
    return { matches, count: matches.length };
  }
  deleteByIds(ids: string[]) { for (const id of ids) this.ctx.storage.sql.exec('DELETE FROM vectors WHERE id = ?', id); return { mutationId: crypto.randomUUID() }; }
}
export class SearchFixture extends WorkerEntrypoint<FixtureEnv> {
  private store() { return this.env.SEARCH_FIXTURES.getByName('fixture'); }
  async run(model: string, input: { text: string[] }) {
    if (model !== '@cf/baai/bge-base-en-v1.5' || input.text.length !== 1) throw new Error('Unexpected fixture embedding contract');
    await this.store().recordCall();
    const values = Array(768).fill(0) as number[];
    for (const word of input.text[0].toLowerCase().split(/\W+/).filter(Boolean)) {
      let index = 0; for (const char of word) index = (index * 31 + char.charCodeAt(0)) % 768;
      values[index] += 1;
    }
    const norm = Math.sqrt(values.reduce((sum, n) => sum + n * n, 0));
    return { data: [values.map(n => n / norm)] };
  }
  upsert(items: VectorizeVector[]) { return this.store().upsert(items); }
  getByIds(ids: string[]) { return this.store().getByIds(ids); }
  query(values: number[], options: VectorizeQueryOptions) { return this.store().query(values, options); }
  deleteByIds(ids: string[]) { return this.store().deleteByIds(ids); }
}
