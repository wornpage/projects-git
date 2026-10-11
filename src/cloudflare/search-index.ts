import { createHash } from 'node:crypto';
import type { Workspace } from '../core/workflow.mjs';
import { ApiError } from './security.ts';

export interface SearchDocument {
  id: string;
  workspaceId: string;
  projectId: string;
  taskId: string;
  runId: string | null;
  headCommit: string | null;
  taskRevision: number;
  title: string;
  text: string;
}

/** Explicit allowlist: no checkout paths, fork credentials, diffs, command
 * outputs, raw provider receipts, or control state enter a search service. */
export function projectDocuments(workspace: Workspace, projectId: string): SearchDocument[] {
  if (!Object.hasOwn(workspace.projects ?? {}, projectId)) throw new ApiError(404, 'PROJECT_NOT_FOUND', 'Project is not in this workspace.');
  const documents: SearchDocument[] = [];
  const add = (value: Omit<SearchDocument, 'id' | 'workspaceId' | 'projectId'>) => {
    const id = createHash('sha256').update(JSON.stringify([workspace.id, projectId, value.taskId, value.runId, value.headCommit, value.taskRevision])).digest('hex');
    documents.push({ ...value, id, workspaceId: workspace.id, projectId });
  };
  for (const task of workspace.tasks.filter(task => task.projectId === projectId)) {
    const revisions = new Map((task.revisions ?? []).map(revision => [revision.revision, revision]));
    revisions.set(task.revision ?? 1, { revision: task.revision ?? 1, purpose: task.purpose, criteria: task.criteria, reason: 'Current requirements', at: task.createdAt });
    for (const revision of revisions.values()) {
      add({ taskId: task.id, runId: null, headCommit: null, taskRevision: revision.revision, title: task.title,
        text: [task.title, revision.purpose, ...revision.criteria, revision.reason].join('\n') });
    }
    for (const run of workspace.runs.filter(run => run.taskId === task.id && run.headCommit)) {
      const identities = new Map<string, { head: string; revision: number }>();
      const reviews = [...(run.reviewHistory ?? []), ...(run.review ? [run.review] : [])];
      for (const report of [...(run.evidenceHistory ?? []), ...(run.evidence ? [run.evidence] : [])]) {
        const revision = report.taskRevision ?? 1;
        identities.set(JSON.stringify([report.commit, revision]), { head: report.commit, revision });
      }
      for (const review of reviews) {
        const revision = review.taskRevision ?? 1;
        identities.set(JSON.stringify([review.headCommit, revision]), { head: review.headCommit, revision });
      }
      identities.set(JSON.stringify([run.headCommit, task.revision ?? 1]), { head: run.headCommit!, revision: task.revision ?? 1 });
      for (const { head, revision } of identities.values()) {
        const intent = revisions.get(revision);
        const notes = reviews
          .filter(review => review.headCommit === head && (review.taskRevision ?? 1) === revision).map(review => review.note);
        // A current summary/files list must never be attributed to a different historical commit.
        const candidateText = head === run.headCommit ? [run.summary, ...run.changedFiles] : [];
        add({ taskId: task.id, runId: run.id, headCommit: head, taskRevision: revision, title: task.title + ' — ' + run.label,
          text: [task.title, run.label, head, intent?.purpose ?? '', ...(intent?.criteria ?? []), ...candidateText, ...notes].join('\n') });
      }
    }
  }
  return documents;
}

type SearchRow = { body: string };
type Generation = { generation: number; document_count: number };
export class RetainedIndex {
  private db: D1DatabaseSession;
  constructor(db: D1Database) { this.db = db.withSession('first-primary'); }

  async generation(workspaceId: string, projectId: string): Promise<Generation | null> {
    return this.db.prepare('SELECT generation, document_count FROM search_generations WHERE workspace_id = ? AND project_id = ?').bind(workspaceId, projectId).first<Generation>();
  }

  async replace(workspaceId: string, projectId: string, generation: number, documents: SearchDocument[]): Promise<void> {
    if (!Number.isSafeInteger(generation) || generation < 0) throw new ApiError(400, 'INVALID_INDEX_GENERATION', 'Invalid index generation.');
    const ids = new Set<string>();
    for (const doc of documents) {
      if (doc.workspaceId !== workspaceId || doc.projectId !== projectId || ids.has(doc.id)) throw new ApiError(409, 'INDEX_SCOPE_MISMATCH', 'Index documents must have unique IDs within the requested project.');
      ids.add(doc.id);
    }
    const previous = await this.generation(workspaceId, projectId);
    if (previous && previous.generation > generation) return;
    const digest = createHash('sha256').update(JSON.stringify([...documents].sort((a, b) => a.id.localeCompare(b.id)))).digest('hex');
    await this.db.prepare('INSERT INTO search_builds(workspace_id, project_id, generation, digest) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING').bind(workspaceId, projectId, generation, digest).run();
    const build = await this.db.prepare('SELECT digest FROM search_builds WHERE workspace_id = ? AND project_id = ? AND generation = ?').bind(workspaceId, projectId, generation).first<{ digest: string }>();
    if (build?.digest !== digest) throw new ApiError(409, 'INDEX_GENERATION_CONFLICT', 'Index generations are immutable. Rebuild using a new coordinator generation.');
    // Equal-generation delivery can repair a partially missing derived index.
    // Batches stage immutable rows; the generation pointer publishes only after all rows exist.
    for (let offset = 0; offset < documents.length; offset += 40) {
      await this.db.batch(documents.slice(offset, offset + 40).map(doc => this.db.prepare(`
        INSERT INTO retained_documents(workspace_id, project_id, generation, document_id, task_id, run_id, head_commit, task_revision, body, search_text)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id,project_id,generation,document_id) DO NOTHING`)
        .bind(workspaceId, projectId, generation, doc.id, doc.taskId, doc.runId, doc.headCommit, doc.taskRevision, JSON.stringify(doc), doc.text.toLowerCase())));
    }
    const count = await this.db.prepare('SELECT count(*) AS n FROM retained_documents WHERE workspace_id = ? AND project_id = ? AND generation = ?').bind(workspaceId, projectId, generation).first<{ n: number }>();
    if (count?.n !== documents.length) throw new ApiError(409, 'INDEX_GENERATION_CONFLICT', 'This index generation contains a different document set. Rebuild from the coordinator.');
    await this.db.prepare(`INSERT INTO search_generations(workspace_id, project_id, generation, document_count) VALUES (?, ?, ?, ?)
      ON CONFLICT(workspace_id,project_id) DO UPDATE SET generation = excluded.generation, document_count = excluded.document_count
      WHERE excluded.generation >= search_generations.generation`).bind(workspaceId, projectId, generation, documents.length).run();
  }

  async search(workspaceId: string, projectId: string, query: string, offset = 0) {
    if (query.length > 200 || !Number.isSafeInteger(offset) || offset < 0 || offset > 100_000) throw new ApiError(400, 'INVALID_SEARCH', 'Search accepts up to 200 characters and a bounded result offset.');
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length > 20) throw new ApiError(400, 'INVALID_SEARCH', 'Search accepts at most 20 words.');
    const generation = await this.generation(workspaceId, projectId);
    if (!generation) return { generation: null, total: 0, matched: 0, items: [] as SearchDocument[], nextOffset: null };
    const where = 'workspace_id = ? AND project_id = ? AND generation = ?' + terms.map(() => ' AND instr(search_text, ?) > 0').join('');
    const args = [workspaceId, projectId, generation.generation, ...terms];
    const count = await this.db.prepare('SELECT count(*) AS n FROM retained_documents WHERE ' + where).bind(...args).first<{ n: number }>();
    const rows = await this.db.prepare('SELECT body FROM retained_documents WHERE ' + where + ' ORDER BY task_id, document_id LIMIT 20 OFFSET ?').bind(...args, offset).all<SearchRow>();
    const items = rows.results.map(row => JSON.parse(row.body) as SearchDocument);
    if (items.some(doc => doc.workspaceId !== workspaceId || doc.projectId !== projectId)) throw new ApiError(500, 'INDEX_SCOPE_MISMATCH', 'Stored search document scope is inconsistent.');
    if ((await this.generation(workspaceId, projectId))?.generation !== generation.generation) throw new ApiError(409, 'INDEX_CHANGED', 'The index changed during search. Refresh results.');
    return { generation: generation.generation, total: generation.document_count, matched: count?.n ?? 0, items,
      nextOffset: offset + items.length < (count?.n ?? 0) ? offset + items.length : null };
  }

  async documents(workspaceId: string, projectId: string, generation: number, ids: string[]): Promise<SearchDocument[]> {
    if (!ids.length) return [];
    if (ids.length > 20) throw new ApiError(400, 'SEARCH_RESULT_LIMIT', 'At most 20 semantic results may be resolved.');
    const rows = await this.db.prepare('SELECT body FROM retained_documents WHERE workspace_id = ? AND project_id = ? AND generation = ? AND document_id IN (' + ids.map(() => '?').join(',') + ')').bind(workspaceId, projectId, generation, ...ids).all<SearchRow>();
    const docs = rows.results.map(row => JSON.parse(row.body) as SearchDocument);
    if (docs.some(doc => doc.workspaceId !== workspaceId || doc.projectId !== projectId || !ids.includes(doc.id))) throw new ApiError(500, 'INDEX_SCOPE_MISMATCH', 'Stored semantic result scope is inconsistent.');
    if ((await this.generation(workspaceId, projectId))?.generation !== generation) throw new ApiError(409, 'INDEX_CHANGED', 'The index changed during search. Refresh results.');
    return ids.flatMap(id => docs.filter(doc => doc.id === id));
  }

  async cleanup(workspaceId: string, projectId: string, removeVectors: (rows: { generation: number; document_id: string }[]) => Promise<void>): Promise<boolean> {
    const current = await this.generation(workspaceId, projectId);
    if (!current) return false;
    const rows = await this.db.prepare('SELECT generation, document_id FROM retained_documents WHERE workspace_id = ? AND project_id = ? AND generation < ? LIMIT 100').bind(workspaceId, projectId, current.generation).all<{ generation: number; document_id: string }>();
    if (rows.results.length) {
      // Keep the durable IDs until remote deletion is observed, so an interrupted
      // cleanup can retry without losing the information needed to remove vectors.
      await removeVectors(rows.results);
      await this.db.batch(rows.results.map(row => this.db.prepare('DELETE FROM retained_documents WHERE workspace_id = ? AND project_id = ? AND generation = ? AND document_id = ?').bind(workspaceId, projectId, row.generation, row.document_id)));
    }
    await this.db.prepare(`DELETE FROM search_builds WHERE workspace_id = ? AND project_id = ? AND generation < ?
      AND NOT EXISTS (SELECT 1 FROM retained_documents d WHERE d.workspace_id = search_builds.workspace_id AND d.project_id = search_builds.project_id AND d.generation = search_builds.generation)`)
      .bind(workspaceId, projectId, current.generation).run();
    const remaining = await this.db.prepare('SELECT count(*) n FROM retained_documents WHERE workspace_id = ? AND project_id = ? AND generation < ?').bind(workspaceId, projectId, current.generation).first<{ n: number }>();
    return Boolean(remaining?.n);
  }
}
