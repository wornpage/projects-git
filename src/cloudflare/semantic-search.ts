import { createHash } from 'node:crypto';
import type { SearchDocument } from './search-index.ts';
import { ApiError } from './security.ts';

export const EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5';
const DIMENSIONS = 768;
const MAX_INPUT_BYTES = 480;
type Storage = Pick<DurableObjectStorage, 'sql' | 'transactionSync'>;
type Cached = { state: string; values_json: string | null };
// Wrangler currently generates the older VectorizeIndex mutation return type.
// We rely on readback, not either version's mutation receipt shape.
type VectorClient = Pick<Vectorize, 'getByIds' | 'query'> & {
  upsert(vectors: VectorizeVector[]): Promise<unknown>;
  deleteByIds(ids: string[]): Promise<unknown>;
};
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const searchScope = (workspaceId: string, projectId: string) => hash([workspaceId, projectId]);
export const vectorId = (scope: string, generation: number, documentId: string) => hash([scope, generation, documentId]);

export async function removeIndexedVectors(vectors: Pick<VectorClient, 'getByIds' | 'deleteByIds'>, workspaceId: string, projectId: string, rows: { generation: number; document_id: string }[]) {
  const scope = searchScope(workspaceId, projectId);
  const ids = rows.map(row => vectorId(scope, row.generation, row.document_id));
  await vectors.deleteByIds(ids);
  if ((await vectors.getByIds(ids)).length) throw new ApiError(503, 'VECTOR_CLEANUP_PENDING', 'Vector deletion is not visible yet. Cleanup IDs remain retained.');
}

// A bounded excerpt avoids implicit model truncation. Literal search retains all text.
export function embeddingExcerpt(text: string): string {
  let result = '', size = 0;
  for (const char of text) {
    const bytes = new TextEncoder().encode(char).length;
    if (size + bytes > MAX_INPUT_BYTES) break;
    result += char; size += bytes;
  }
  return result;
}

function vector(value: unknown): number[] {
  if (!Array.isArray(value) || value.length !== DIMENSIONS || !value.every(n => typeof n === 'number' && Number.isFinite(n)) || !value.some(n => n !== 0)) {
    throw new ApiError(502, 'INVALID_EMBEDDING', 'The embedding provider returned an invalid vector.');
  }
  return value;
}

/** Durable reservations prevent retries from repeating an uncertain model call.
 * No provider work is performed unless the operator enables it and sets a budget. */
export class SemanticSearch {
  private storage: Storage;
  private vectors: VectorClient;
  private embed: (text: string) => Promise<unknown>;
  private dailyLimit: number;
  constructor(storage: Storage, vectors: VectorClient, embed: (text: string) => Promise<unknown>, dailyLimit: number) {
    if (!Number.isSafeInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 1000) throw new ApiError(503, 'EMBEDDING_BUDGET_REQUIRED', 'Set a daily embedding call limit between 1 and 1000.');
    this.storage = storage; this.vectors = vectors; this.embed = embed; this.dailyLimit = dailyLimit;
    storage.sql.exec('CREATE TABLE IF NOT EXISTS search_embeddings (digest TEXT PRIMARY KEY, state TEXT NOT NULL, values_json TEXT, error_code TEXT)');
    storage.sql.exec('CREATE TABLE IF NOT EXISTS search_embedding_budget (day TEXT PRIMARY KEY, calls INTEGER NOT NULL)');
    storage.sql.exec('CREATE TABLE IF NOT EXISTS semantic_generations (project_id TEXT PRIMARY KEY, generation INTEGER NOT NULL)');
  }

  generation(projectId: string): number | null {
    return this.storage.sql.exec<{ generation: number }>('SELECT generation FROM semantic_generations WHERE project_id = ?', projectId).toArray()[0]?.generation ?? null;
  }

  async embedding(scope: string, text: string): Promise<number[]> {
    const excerpt = embeddingExcerpt(text);
    if (!excerpt.trim()) throw new ApiError(400, 'EMPTY_SEMANTIC_QUERY', 'Enter a search phrase.');
    const digest = hash([EMBEDDING_MODEL, 'mean', scope, excerpt]);
    const previous = this.storage.sql.exec<Cached>('SELECT state, values_json FROM search_embeddings WHERE digest = ?', digest).toArray()[0];
    if (previous?.state === 'ready') return vector(JSON.parse(previous.values_json!));
    if (previous) throw new ApiError(409, 'EMBEDDING_ATTEMPT_RETAINED', 'An earlier embedding attempt is pending, failed or uncertain. It will not be repeated automatically.');
    this.storage.transactionSync(() => {
      const day = new Date().toISOString().slice(0, 10);
      this.storage.sql.exec('INSERT INTO search_embedding_budget(day, calls) VALUES (?, 0) ON CONFLICT DO NOTHING', day);
      const reservation = this.storage.sql.exec<{ calls: number }>('UPDATE search_embedding_budget SET calls = calls + 1 WHERE day = ? AND calls < ? RETURNING calls', day, this.dailyLimit).toArray();
      if (!reservation.length) throw new ApiError(429, 'EMBEDDING_BUDGET_EXHAUSTED', 'The daily embedding call limit is exhausted. Literal search remains available.');
      this.storage.sql.exec("INSERT INTO search_embeddings(digest, state) VALUES (?, 'started')", digest);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([this.embed(excerpt), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ApiError(504, 'EMBEDDING_TIMEOUT', 'Embedding did not finish within 30 seconds. The attempt is retained.')), 30_000);
      })]);
      if (!response || typeof response !== 'object' || !('data' in response) || !Array.isArray(response.data) || response.data.length !== 1) throw new ApiError(502, 'INVALID_EMBEDDING', 'The provider must return exactly one embedding.');
      const values = vector(response.data[0]);
      this.storage.sql.exec("UPDATE search_embeddings SET state = 'ready', values_json = ? WHERE digest = ?", JSON.stringify(values), digest);
      return values;
    } catch {
      this.storage.sql.exec("UPDATE search_embeddings SET state = 'failed', error_code = 'EMBEDDING_FAILED' WHERE digest = ?", digest);
      throw new ApiError(502, 'EMBEDDING_FAILED', 'Embedding failed or timed out; the attempt is retained without automatic regeneration.');
    } finally { if (timer) clearTimeout(timer); }
  }

  async index(workspaceId: string, projectId: string, generation: number, docs: SearchDocument[]): Promise<void> {
    const scope = searchScope(workspaceId, projectId);
    if (docs.some(doc => doc.workspaceId !== workspaceId || doc.projectId !== projectId)) throw new ApiError(409, 'INDEX_SCOPE_MISMATCH', 'Semantic documents must belong to the selected project.');
    let pending = false;
    for (let offset = 0; offset < docs.length; offset += 20) {
      const batch = docs.slice(offset, offset + 20);
      const ids = batch.map(doc => vectorId(scope, generation, doc.id));
      const existing = await this.vectors.getByIds(ids);
      // Namespace is optional in Vectorize response payloads. Require scoped
      // metadata and our derived ID; refuse a conflicting echo when supplied.
      const valid = (item: VectorizeVector, id: string) => item.id === id && (item.namespace === undefined || item.namespace === scope) && item.metadata?.scope === scope && item.metadata?.generation === generation;
      const missing = batch.filter((doc, i) => !existing.some(item => valid(item, ids[i]) && item.metadata?.documentId === doc.id));
      if (missing.length) {
        const values: VectorizeVector[] = [];
        for (const doc of missing) values.push({ id: vectorId(scope, generation, doc.id), namespace: scope, values: await this.embedding(scope, doc.text), metadata: { scope, generation, documentId: doc.id } });
        await this.vectors.upsert(values);
        const readback = await this.vectors.getByIds(ids);
        if (!batch.every((doc, i) => readback.some(item => valid(item, ids[i]) && item.metadata?.documentId === doc.id))) pending = true;
      }
    }
    // Stage every batch before yielding for eventual visibility. Otherwise a
    // project can spend one delivery attempt per batch and exhaust its retries.
    if (pending) throw new ApiError(503, 'VECTOR_INDEX_PENDING', 'Vectorize has not made this generation visible yet. Cached embeddings will be reused on delivery retry.');
    this.storage.sql.exec('INSERT INTO semantic_generations(project_id, generation) VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET generation = max(semantic_generations.generation, excluded.generation)', projectId, generation);
  }

  async search(workspaceId: string, projectId: string, generation: number, query: string) {
    if (this.generation(projectId) !== generation) throw new ApiError(409, 'SEMANTIC_INDEX_NOT_CURRENT', 'Semantic indexing is not ready for the current history index. Use literal search or rebuild the index.');
    if (new TextEncoder().encode(query).byteLength > MAX_INPUT_BYTES) throw new ApiError(400, 'SEMANTIC_QUERY_LIMIT', 'Use a shorter search phrase (up to 480 UTF-8 bytes).');
    const scope = searchScope(workspaceId, projectId);
    const values = await this.embedding(scope, query);
    const result = await this.vectors.query(values, { namespace: scope, topK: 20, returnMetadata: 'all', filter: { scope, generation } });
    const ids = new Set<string>();
    return result.matches.filter(match => {
      const id = match.metadata?.documentId;
      if (match.namespace !== undefined && match.namespace !== scope || match.metadata?.scope !== scope || match.metadata?.generation !== generation || typeof id !== 'string' || match.id !== vectorId(scope, generation, id) || !Number.isFinite(match.score) || ids.has(id)) return false;
      ids.add(id); return true;
    }).map(match => ({ documentId: match.metadata!.documentId as string, score: match.score }));
  }
}
