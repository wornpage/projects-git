-- Rebuildable projection only. Workflow decisions remain in Durable Objects.
CREATE TABLE search_builds (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  digest TEXT NOT NULL,
  PRIMARY KEY (workspace_id, project_id, generation)
);
CREATE TABLE search_generations (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  document_count INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, project_id)
);
CREATE TABLE retained_documents (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  document_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  run_id TEXT,
  head_commit TEXT,
  task_revision INTEGER NOT NULL,
  body TEXT NOT NULL,
  search_text TEXT NOT NULL,
  PRIMARY KEY (workspace_id, project_id, generation, document_id)
);
CREATE INDEX retained_documents_scope ON retained_documents(workspace_id, project_id, generation, task_id);
