import type { HostedSnapshot, SnapshotStore } from './controller.ts';
import { initialSnapshot, migrateSnapshot } from './controller.ts';
import { ApiError } from './security.ts';
import { parseWorkspacePage } from '../../public/workspace-page.js';
import { MAX_ACTIVE_RUNS } from '../core/workflow.mjs';
import {selectCatalogEntries,parseProjectCatalog,ProjectCatalogError} from '../../public/project-catalog.js';

type Storage = Pick<DurableObjectStorage, 'sql' | 'transactionSync'>;
type RecordRow = { kind: string; id: string; position: number; data: string };
type Header = { revision: number; data: string };
export interface BackupLedgers {
  capture: 'coherent-sqlite-transaction';
  artifactSubscriptions: {repositoryName:string;fingerprint:string;phase:string;subscriptionId:string|null;attemptId:string}[];
  artifactSubscriptionAttempts: {id:string;repositoryName:string;startedAt:string;finishedAt:string|null;status:string;errorCode:string|null}[];
  artifactEvents: {eventKey:string;status:string;attemptId:string;event:{subscriptionId:string;repositoryName:string;ref:string;before:string;after:string;timestamp:string};
    result:{key:string;state:string;headCommit?:string|null;repositoryName?:string;ref?:string;runIds?:string[];projectIds?:string[]}|null}[];
  artifactEventAttempts: {attemptId:string;eventKey:string;startedAt:string;finishedAt:string|null;status:string;errorCode:string|null}[];
  artifactDeliveries: {messageId:string;eventKey:string}[];
}
export interface BackupCapture {snapshot:HostedSnapshot;backupLedgers:BackupLedgers}
export type IndexState = { project_id: string; revision: number; delivered_revision: number; indexed_revision: number; attempts: number; next_attempt_at: number; error_code: string | null; automatic: number };
const mapKinds = ['repositories', 'forks', 'operations', 'jobs', 'checkPolicies', 'recoveryImports'] as const;
const historyKinds = { tasks: ['revisions', 'ownerHistory', 'baseHistory'], runs: ['evidenceHistory', 'reviewHistory'] } as const;
const MAX_RECORD_BYTES = 1_900_000;
const backupTables=['artifact_subscriptions','artifact_subscription_attempts','artifact_events','artifact_event_attempts','artifact_deliveries'] as const;

function backupLedgerError(message:string):never {throw new ApiError(503,'BACKUP_LEDGER_UNAVAILABLE',message);}
function parsedRecord(value:string,label:string):Record<string,unknown>{
  let parsed:unknown;try{parsed=JSON.parse(value);}catch{backupLedgerError('Retained '+label+' JSON is invalid.');}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))backupLedgerError('Retained '+label+' JSON has an unsupported shape.');
  return parsed as Record<string,unknown>;
}
function exact(value:Record<string,unknown>,keys:string[],label:string):void{
  if(Object.keys(value).sort().join(',')!==[...keys].sort().join(','))backupLedgerError('Retained '+label+' has unsupported fields.');
}
const commit=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const eventId=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9-]{16,64}$/.test(value);
const repository=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value);
const branch=(value:unknown):value is string=>typeof value==='string'&&/^refs\/heads\/[A-Za-z0-9._/-]{1,250}$/.test(value)&&!value.includes('..')&&!value.includes('//')&&!/[/.]$/.test(value);
function safeEvent(eventText:string):BackupLedgers['artifactEvents'][number]['event']{
  const event=parsedRecord(eventText,'artifact event');
  exact(event,['accountId','subscriptionId','namespace','repositoryName','ref','before','after','timestamp'],'artifact event');
  const {subscriptionId,repositoryName,ref,before,after,timestamp}=event;
  if(!eventId(subscriptionId)||!repository(repositoryName)||!branch(ref)||!commit(before)||!commit(after)
    ||typeof timestamp!=='string'||timestamp.length>32||!Number.isFinite(Date.parse(timestamp)))backupLedgerError('Retained artifact event values are invalid.');
  return {subscriptionId:subscriptionId as string,repositoryName:repositoryName as string,ref:ref as string,before:before as string,after:after as string,timestamp:timestamp as string};
}
function safeEventResult(resultText:string|null):BackupLedgers['artifactEvents'][number]['result']{
  if(resultText===null)return null;
  const result=parsedRecord(resultText,'artifact event result'),allowed=['key','state','headCommit','repositoryName','ref','runIds','projectIds'];
  if(Object.keys(result).some(key=>!allowed.includes(key)))backupLedgerError('Retained artifact event result has unsupported fields.');
  if(typeof result.key!=='string'||!/^[a-f0-9]{64}$/.test(result.key)||!['unowned-ref','observed','superseded-notification'].includes(String(result.state))
    ||result.headCommit!==undefined&&result.headCommit!==null&&!commit(result.headCommit)
    ||result.repositoryName!==undefined&&!repository(result.repositoryName)||result.ref!==undefined&&!branch(result.ref)
    ||result.runIds!==undefined&&(!Array.isArray(result.runIds)||result.runIds.some(value=>typeof value!=='string'))
    ||result.projectIds!==undefined&&(!Array.isArray(result.projectIds)||result.projectIds.some(value=>typeof value!=='string')))
    backupLedgerError('Retained artifact event result values are invalid.');
  exact(result,result.state==='unowned-ref'?['key','state']:allowed,'artifact event result');
  return result as BackupLedgers['artifactEvents'][number]['result'];
}

function encode(value: unknown): string {
  const data = JSON.stringify(value);
  if (new TextEncoder().encode(data).byteLength > MAX_RECORD_BYTES) {
    throw new ApiError(413, 'WORKSPACE_RECORD_LIMIT', 'One retained record exceeds 1.9 MB. Split this record before saving; earlier records are unchanged.');
  }
  return data;
}

function split(snapshot: HostedSnapshot): { header: string; records: RecordRow[] } {
  const { workspace, ...header } = snapshot;
  const { tasks, runs, events, projects, ...workspaceHeader } = workspace;
  const records: RecordRow[] = [];
  const add = (kind: string, id: string, position: number, value: unknown) => records.push({ kind, id, position, data: encode(value) });
  for (const [kind, entries] of [['tasks', tasks], ['runs', runs]] as const) {
    const ids = new Set<string>();
    entries.forEach((entry, position) => {
      if (ids.has(entry.id)) throw new ApiError(409, 'DUPLICATE_RECORD', 'Duplicate retained record ID.');
      ids.add(entry.id);
      const value: Record<string, unknown> = { ...entry };
      for (const field of historyKinds[kind]) {
        if (Array.isArray(value[field])) {
          (value[field] as unknown[]).forEach((item, index) => add(kind + '.' + field, JSON.stringify([entry.id, index]), index, item));
          value[field] = [];
        }
      }
      add(kind, entry.id, position, value);
    });
  }
  // Event IDs are retained, while position preserves the original ordering.
  events.forEach((event, position) => add('events', String(position), position, event));
  Object.entries(projects ?? {}).forEach(([id, project], position) => add('projects', id, position, project));
  for (const kind of mapKinds) {
    Object.entries(snapshot[kind] ?? {}).forEach(([id, value], position) => add(kind, id, position, value));
    delete header[kind];
  }
  return { header: encode({ ...header, workspace: workspaceHeader }), records };
}

/** The sole hosted workflow store. Migration and revision-guarded writes are
 * transactional. Search delivery cannot change these authoritative records. */
export class WorkspaceStore implements SnapshotStore {
  private storage: Storage;
  private changeWaiters = new Set<() => void>();
  private accessWriters = new Set<string>();

  // This store lives with one coordinator instance. A restart loses the live
  // owner, while its SQL receipt still requires an explicit guarded recovery.
  lockProjectAccess(projectId:string):()=>void {
    if(this.accessWriters.has(projectId))throw new ApiError(409,'PROJECT_ACCESS_IN_PROGRESS','This repository access change is still running. Inspect the saved outcome before explicitly retrying.');
    this.accessWriters.add(projectId);let held=true;
    return()=>{if(held){held=false;this.accessWriters.delete(projectId);}};
  }

  waitForChange(revision: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.identity().revision !== revision) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => { this.changeWaiters.delete(changed); signal.removeEventListener('abort', aborted); };
      const changed = () => { cleanup(); resolve(); };
      const aborted = () => { cleanup(); reject(signal.reason); };
      this.changeWaiters.add(changed); signal.addEventListener('abort', aborted, { once: true });
    });
  }
  constructor(storage: Storage, workspaceId: string) {
    this.storage = storage;
    storage.transactionSync(() => {
      storage.sql.exec('CREATE TABLE IF NOT EXISTS workspace_header (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL, data TEXT NOT NULL)');
      storage.sql.exec('CREATE TABLE IF NOT EXISTS workspace_records (kind TEXT NOT NULL, id TEXT NOT NULL, position INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind, id))');
      storage.sql.exec('CREATE INDEX IF NOT EXISTS workspace_records_order ON workspace_records(kind, position)');
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS search_outbox (
        project_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, delivered_revision INTEGER NOT NULL DEFAULT -1,
        indexed_revision INTEGER NOT NULL DEFAULT -1, attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0, error_code TEXT)`);
      if(!storage.sql.exec<{name:string}>('PRAGMA table_info(search_outbox)').toArray().some(column=>column.name==='automatic'))
        storage.sql.exec('ALTER TABLE search_outbox ADD COLUMN automatic INTEGER NOT NULL DEFAULT 1');
      const legacyExists = storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'snapshot'").toArray().length > 0;
      const existing = storage.sql.exec<Header>('SELECT revision, data FROM workspace_header WHERE id = 1').toArray();
      if (!existing.length) {
        const legacy = legacyExists ? storage.sql.exec<Header>('SELECT revision, data FROM snapshot WHERE id = 1').toArray()[0] : undefined;
        const snapshot: HostedSnapshot = legacy ? JSON.parse(legacy.data) : initialSnapshot(workspaceId);
        if (snapshot.workspace.id !== workspaceId) throw new ApiError(409, 'WORKSPACE_ID_MISMATCH', 'Stored workspace identity differs from configuration.');
        if (legacy && snapshot.revision !== legacy.revision) throw new ApiError(409, 'SNAPSHOT_REVISION_MISMATCH', 'Stored snapshot revision is inconsistent.');
        if (migrateSnapshot(snapshot)) snapshot.revision++;
        const parts = split(snapshot);
        storage.sql.exec('INSERT INTO workspace_header(id, revision, data) VALUES (1, ?, ?)', snapshot.revision, parts.header);
        for (const row of parts.records) this.put(row);
        for (const id of Object.keys(snapshot.workspace.projects ?? {})) this.dirty(id, snapshot.revision);
      } else {
        if (legacyExists) throw new ApiError(409, 'AMBIGUOUS_WORKSPACE_STORAGE', 'Both workflow storage layouts exist. Inspect the retained database before continuing.');
        const header = JSON.parse(existing[0].data);
        if (header.workspace.id !== workspaceId) throw new ApiError(409, 'WORKSPACE_ID_MISMATCH', 'Stored workspace identity differs from configuration.');
      }
      // Hard cutover: the old table is removed only inside the successful migration transaction.
      if (legacyExists) storage.sql.exec('DROP TABLE snapshot');
      storage.sql.exec("CREATE INDEX IF NOT EXISTS workspace_project_records ON workspace_records(kind, json_extract(data, '$.projectId'), position)");
      storage.sql.exec("CREATE INDEX IF NOT EXISTS workspace_task_records ON workspace_records(kind, json_extract(data, '$.taskId'), position)");
      storage.sql.exec("CREATE INDEX IF NOT EXISTS workspace_operation_state ON workspace_records(kind, json_extract(data, '$.state'))");
    });
  }

  private put(row: RecordRow): void {
    this.storage.sql.exec(`INSERT INTO workspace_records(kind, id, position, data) VALUES (?, ?, ?, ?)
      ON CONFLICT(kind,id) DO UPDATE SET position = excluded.position, data = excluded.data`, row.kind, row.id, row.position, row.data);
  }

  identity() {
    const row = this.storage.sql.exec<Header>('SELECT revision, data FROM workspace_header WHERE id = 1').one();
    const {id,authentication,sessionsValidAfter} = JSON.parse(row.data).workspace;
    const empty = !this.storage.sql.exec("SELECT 1 FROM workspace_records WHERE kind IN ('tasks','runs','operations') LIMIT 1").toArray().length;
    return {id,authentication,sessionsValidAfter,revision:row.revision,empty};
  }

  hasSchedulingCandidates(): boolean {
    return this.storage.sql.exec("SELECT 1 FROM workspace_records WHERE (kind = 'jobs' AND json_extract(data, '$.status') = 'queued') OR (kind = 'projects' AND json_extract(data, '$.automaticMergePolicy.enabled') = 1) LIMIT 1").toArray().length > 0;
  }

  operation(key: string): HostedSnapshot['operations'][string] | undefined {
    const row = this.storage.sql.exec<{data:string}>("SELECT data FROM workspace_records WHERE kind = 'operations' AND id = ?",key).toArray()[0];
    return row ? JSON.parse(row.data) : undefined;
  }

  project(id: string): NonNullable<HostedSnapshot['workspace']['projects']>[string] | undefined {
    const row = this.storage.sql.exec<{data:string}>("SELECT data FROM workspace_records WHERE kind = 'projects' AND id = ?",id).toArray()[0];
    return row ? JSON.parse(row.data) : undefined;
  }

  readCatalog(request: ReturnType<typeof parseProjectCatalog>) {
    const identity=this.identity();
    if(request.at!==null&&request.at!==identity.revision)throw new ApiError(409,'PROJECT_CATALOG_CHANGED','Projects changed while paging. Search again for the current list.');
    const entries=this.storage.sql.exec<{id:string;name:string}>("SELECT id,json_extract(data,'$.name') AS name FROM workspace_records WHERE kind='projects'").toArray();
    let selection;
    try {selection=selectCatalogEntries(entries,request,identity.revision);}
    catch(error){if(error instanceof ProjectCatalogError)throw new ApiError(error.status,error.code,error.message);throw error;}
    const items=selection.ids.map((id:string)=>{
      const entry=entries.find(item=>item.id===id)!;
      const taskCount=this.storage.sql.exec<{n:number}>("SELECT count(*) AS n FROM workspace_records WHERE kind='tasks' AND json_extract(data,'$.projectId')=?",id).one().n;
      const candidateCount=this.storage.sql.exec<{n:number}>("SELECT count(*) AS n FROM workspace_records r JOIN workspace_records t ON t.kind='tasks' AND t.id=json_extract(r.data,'$.taskId') WHERE r.kind='runs' AND json_extract(t.data,'$.projectId')=?",id).one().n;
      return {id,name:entry.name,taskCount,candidateCount};
    });
    return {workspaceId:identity.id,...selection.page,items};
  }

  /** SQL selects complete projects, so prerequisites and review denominators are never partial. */
  readPage(request: NonNullable<ReturnType<typeof parseWorkspacePage>>) {
    const header = this.storage.sql.exec<Header>('SELECT revision, data FROM workspace_header WHERE id = 1').one();
    if (request.at !== null && request.at !== header.revision) throw new ApiError(409,'WORKSPACE_PAGE_CHANGED','The workspace changed. Refresh this page before continuing.');
    const total = this.storage.sql.exec<{n:number}>("SELECT count(*) AS n FROM workspace_records WHERE kind = 'projects'").one().n;
    const taskId = request.run ? this.storage.sql.exec<{taskId:string}>("SELECT json_extract(data, '$.taskId') AS taskId FROM workspace_records WHERE kind = 'runs' AND id = ?",request.run).toArray()[0]?.taskId : request.task;
    const projectId = taskId ? this.storage.sql.exec<{projectId:string}>("SELECT json_extract(data, '$.projectId') AS projectId FROM workspace_records WHERE kind = 'tasks' AND id = ?",taskId).toArray()[0]?.projectId : request.project;
    let offset = request.offset;
    if (request.task || request.project || request.run) {
      const project = this.storage.sql.exec<{position:number}>("SELECT position FROM workspace_records WHERE kind = 'projects' AND id = ?",projectId??'').toArray()[0];
      if (!project) throw new ApiError(404,'PROJECT_NOT_FOUND','The requested project or task is unavailable in this workspace.');
      offset = this.storage.sql.exec<{n:number}>("SELECT count(*) AS n FROM workspace_records WHERE kind = 'projects' AND (position < ? OR (position = ? AND id < ?))",project.position,project.position,projectId).one().n;
    }
    if (offset > 0 && offset >= total) throw new ApiError(409,'WORKSPACE_PAGE_CHANGED','This project page no longer exists. Return to the first page.');
    const rows = this.storage.sql.exec<RecordRow>("SELECT kind,id,position,data FROM workspace_records WHERE kind = 'projects' ORDER BY position,id LIMIT ? OFFSET ?",request.limit,offset).toArray();
    const ids = rows.map(row=>row.id);
    const select = (where:string,...args:unknown[]) => this.storage.sql.exec<RecordRow>('SELECT kind,id,position,data FROM workspace_records WHERE '+where+' ORDER BY kind,position',...args).toArray();
    const tasks = select("kind = 'tasks' AND json_extract(data, '$.projectId') IN (SELECT value FROM json_each(?))",JSON.stringify(ids));
    const taskIds = JSON.stringify(tasks.map(row=>row.id));
    const runs = select("kind = 'runs' AND json_extract(data, '$.taskId') IN (SELECT value FROM json_each(?))",taskIds);
    const runIds = JSON.stringify(runs.map(row=>row.id));
    rows.push(...tasks,...runs,
      ...select("kind IN ('tasks.revisions','tasks.ownerHistory','tasks.baseHistory') AND json_extract(id, '$[0]') IN (SELECT value FROM json_each(?))",taskIds),
      ...select("kind IN ('runs.evidenceHistory','runs.reviewHistory') AND json_extract(id, '$[0]') IN (SELECT value FROM json_each(?))",runIds),
      ...select("kind = 'operations' AND (json_extract(data, '$.state') = 'pending' OR (json_extract(data, '$.kind') = 'review-inference' AND json_extract(data, '$.itemId') IN (SELECT value FROM json_each(?))))",runIds),
      ...select("kind = 'events' AND (json_extract(data, '$.projectId') IN (SELECT value FROM json_each(?)) OR json_extract(data, '$.taskId') IN (SELECT value FROM json_each(?)) OR json_extract(data, '$.runId') IN (SELECT value FROM json_each(?)) OR (json_extract(data, '$.projectId') IS NULL AND json_extract(data, '$.taskId') IS NULL AND json_extract(data, '$.runId') IS NULL))",JSON.stringify(ids),taskIds,runIds));
    const snapshot = this.assemble(header,rows);
    const counts = Object.fromEntries(this.storage.sql.exec<{kind:string;n:number}>("SELECT kind,count(*) AS n FROM workspace_records WHERE kind IN ('projects','tasks','runs','operations') GROUP BY kind").toArray().map(row=>[row.kind,row.n]));
    const page = {offset,limit:request.limit,totalProjects:total,revision:header.revision,nextOffset:offset+request.limit<total?offset+request.limit:null,previousOffset:offset?Math.max(0,offset-request.limit):null,
      taskNumbers:Object.fromEntries(tasks.map(row=>[row.id,row.position+1])),workspaceTotals:{projects:total,tasks:counts.tasks??0,runs:counts.runs??0},scope:'loaded-projects'};
    // Read-only projections cannot accidentally be saved as a complete workspace.
    Object.defineProperty(snapshot,'page',{value:page,enumerable:true});
    const runCounts = this.storage.sql.exec<{status:string;agent:string;n:number}>("SELECT json_extract(data, '$.status') AS status,json_extract(data, '$.agent') AS agent,count(*) AS n FROM workspace_records WHERE kind = 'runs' GROUP BY status,agent").toArray();
    const running = runCounts.filter(row=>row.status==='running').reduce((n,row)=>n+row.n,0);
    const reserved = runCounts.filter(row=>row.status==='assigned'&&row.agent!=='model').reduce((n,row)=>n+row.n,0)+Object.values(snapshot.operations).filter(op=>op.state==='pending'&&op.reservesExecution).length;
    const capacity = {limit:MAX_ACTIVE_RUNS,running,reserved,occupied:running+reserved,queued:runCounts.filter(row=>row.status==='assigned'&&row.agent==='model').reduce((n,row)=>n+row.n,0),
      verification:{limit:2,occupied:Object.values(snapshot.operations).filter(op=>op.state==='pending'&&['checks','merge','model-check'].includes(op.kind)).length,
        waiting:this.storage.sql.exec<{n:number}>("SELECT count(*) AS n FROM workspace_records WHERE kind = 'jobs' AND json_extract(data, '$.status') = 'running' AND json_extract(data, '$.phase') = 'waiting-check'").one().n}};
    return {snapshot,page,capacity,operationReceipts:counts.operations??0};
  }

  private dirty(projectId: string, revision: number, automatic=true): void {
    this.storage.sql.exec(`INSERT INTO search_outbox(project_id, revision, automatic, error_code) VALUES (?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET revision = excluded.revision, attempts = 0, next_attempt_at = 0, automatic = excluded.automatic, error_code = excluded.error_code`,
      projectId, revision,automatic?1:0,automatic?null:'INDEX_REBUILD_REQUIRED');
  }

  indexState(projectId: string): IndexState | null {
    return this.storage.sql.exec<IndexState>('SELECT * FROM search_outbox WHERE project_id = ?', projectId).toArray()[0] ?? null;
  }

  pendingIndex(now = Date.now()): IndexState[] {
    return this.storage.sql.exec<IndexState>('SELECT * FROM search_outbox WHERE automatic = 1 AND indexed_revision < revision AND attempts < 4 AND next_attempt_at <= ? ORDER BY revision LIMIT 10', now).toArray();
  }

  nextIndexAttempt(): number | null {
    return this.storage.sql.exec<{ due: number | null }>('SELECT min(next_attempt_at) AS due FROM search_outbox WHERE automatic = 1 AND indexed_revision < revision AND attempts < 4').one().due;
  }

  delivered(projectId: string, revision: number, now = Date.now()): void {
    this.storage.sql.exec('UPDATE search_outbox SET delivered_revision = ?, attempts = attempts + 1, next_attempt_at = ?, error_code = NULL WHERE project_id = ? AND revision = ?', revision, now + 600_000, projectId, revision);
  }

  indexFailure(projectId: string, revision: number, code: string, terminal = false): void {
    if (!/^[A-Z_]{1,80}$/.test(code)) throw new ApiError(500, 'INVALID_INDEX_ERROR', 'Index errors must use a sanitized code.');
    this.storage.sql.exec('UPDATE search_outbox SET error_code = ?, attempts = CASE WHEN ? THEN 4 ELSE attempts + 1 END, next_attempt_at = ? WHERE project_id = ? AND revision = ? AND indexed_revision < revision', code, terminal ? 1 : 0, Date.now() + 60_000, projectId, revision);
  }

  cleanupFailure(projectId: string, failed: boolean): void {
    this.storage.sql.exec("UPDATE search_outbox SET error_code = CASE WHEN ? THEN 'INDEX_CLEANUP_FAILED' WHEN error_code = 'INDEX_CLEANUP_FAILED' THEN NULL ELSE error_code END WHERE project_id = ?", failed ? 1 : 0, projectId);
  }

  indexed(projectId: string, revision: number): void {
    this.storage.sql.exec('UPDATE search_outbox SET indexed_revision = max(indexed_revision, ?), error_code = CASE WHEN revision <= ? THEN NULL ELSE error_code END WHERE project_id = ?', revision, revision, projectId);
  }

  rebuild(projectId: string, expectedRevision: number): IndexState {
    return this.storage.transactionSync(() => {
      const snapshot = this.read();
      if (!Object.hasOwn(snapshot.workspace.projects ?? {}, projectId)) throw new ApiError(404, 'PROJECT_NOT_FOUND', 'Project is not in this workspace.');
      const current = this.indexState(projectId);
      if (current?.revision !== expectedRevision) throw new ApiError(409, 'INDEX_REVISION_CONFLICT', 'Index state changed. Read its current revision before requesting a rebuild.');
      // Advance the source revision even without a workflow change so a rebuild
      // never rewrites an already-published immutable index generation.
      const header = this.storage.sql.exec<Header>('SELECT revision, data FROM workspace_header WHERE id = 1').one();
      this.storage.sql.exec('UPDATE workspace_header SET revision = ? WHERE id = 1', header.revision + 1);
      this.dirty(projectId, header.revision + 1);
      return this.indexState(projectId)!;
    });
  }

  read(): HostedSnapshot {
    const header = this.storage.sql.exec<Header>('SELECT revision, data FROM workspace_header WHERE id = 1').one();
    const rows = this.storage.sql.exec<RecordRow>('SELECT kind, id, position, data FROM workspace_records ORDER BY kind, position').toArray();
    return this.assemble(header,rows);
  }

  /** One read transaction captures workflow records and the separate provider-effect
   * ledgers. The returned ledgers are export-only data and are never persisted in
   * the workspace snapshot. Missing canonical tables are an explicit operator error. */
  captureBackup(): BackupCapture {
    return this.storage.transactionSync(() => {
      const present=new Set(this.storage.sql.exec<{name:string}>("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('artifact_subscriptions','artifact_subscription_attempts','artifact_events','artifact_event_attempts','artifact_deliveries')").toArray().map(row=>row.name));
      const missing=backupTables.filter(name=>!present.has(name));
      if(missing.length)backupLedgerError('Workspace backup requires the canonical coordinator ledger tables: '+missing.join(', ')+'.');
      const snapshot=this.read();
      const subscriptions=this.storage.sql.exec<{repository:string;fingerprint:string;phase:string;subscription_id:string|null;attempt_id:string}>(
        'SELECT repository,fingerprint,phase,subscription_id,attempt_id FROM artifact_subscriptions ORDER BY repository').toArray();
      const subscriptionAttempts=this.storage.sql.exec<{id:string;repository:string;started_at:string;finished_at:string|null;status:string;error_code:string|null}>(
        'SELECT id,repository,started_at,finished_at,status,error_code FROM artifact_subscription_attempts ORDER BY started_at,id').toArray();
      const events=this.storage.sql.exec<{event_key:string;event:string;status:string;attempt_id:string;result:string|null}>(
        'SELECT event_key,event,status,attempt_id,result FROM artifact_events ORDER BY event_key').toArray();
      const eventAttempts=this.storage.sql.exec<{attempt_id:string;event_key:string;started_at:string;finished_at:string|null;status:string;error_code:string|null}>(
        'SELECT attempt_id,event_key,started_at,finished_at,status,error_code FROM artifact_event_attempts ORDER BY started_at,attempt_id').toArray();
      const deliveries=this.storage.sql.exec<{message_id:string;event_key:string}>(
        'SELECT message_id,event_key FROM artifact_deliveries ORDER BY message_id').toArray();
      const backupLedgers:BackupLedgers={capture:'coherent-sqlite-transaction',
        artifactSubscriptions:subscriptions.map(row=>({repositoryName:row.repository,fingerprint:row.fingerprint,phase:row.phase,subscriptionId:row.subscription_id,attemptId:row.attempt_id})),
        artifactSubscriptionAttempts:subscriptionAttempts.map(row=>({id:row.id,repositoryName:row.repository,startedAt:row.started_at,finishedAt:row.finished_at,status:row.status,errorCode:row.error_code})),
        artifactEvents:events.map(row=>({eventKey:row.event_key,status:row.status,attemptId:row.attempt_id,event:safeEvent(row.event),result:safeEventResult(row.result)})),
        artifactEventAttempts:eventAttempts.map(row=>({attemptId:row.attempt_id,eventKey:row.event_key,startedAt:row.started_at,finishedAt:row.finished_at,status:row.status,errorCode:row.error_code})),
        artifactDeliveries:deliveries.map(row=>({messageId:row.message_id,eventKey:row.event_key}))};
      return {snapshot,backupLedgers};
    });
  }

  private assemble(header:Header,rows:RecordRow[]): HostedSnapshot {
    const snapshot: HostedSnapshot = JSON.parse(header.data);
    snapshot.revision = header.revision;
    snapshot.workspace.tasks = []; snapshot.workspace.runs = []; snapshot.workspace.events = []; snapshot.workspace.projects = {};
    for (const kind of mapKinds) snapshot[kind] = {};
    const tasks = new Map<string, Record<string, unknown>>(), runs = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
      if (row.kind.includes('.')) continue;
      const value = JSON.parse(row.data);
      if (row.kind === 'tasks') { snapshot.workspace.tasks.push(value); tasks.set(row.id, value); }
      else if (row.kind === 'runs') { snapshot.workspace.runs.push(value); runs.set(row.id, value); }
      else if (row.kind === 'events') snapshot.workspace.events.push(value);
      else if (row.kind === 'projects') Object.defineProperty(snapshot.workspace.projects, row.id, { value, enumerable: true, writable: true, configurable: true });
      else if ((mapKinds as readonly string[]).includes(row.kind)) Object.defineProperty(snapshot[row.kind as typeof mapKinds[number]], row.id, { value, enumerable: true, writable: true, configurable: true });
      else throw new ApiError(500, 'UNKNOWN_STORED_RECORD', 'Unknown retained workflow record kind.');
    }
    for (const row of rows) {
      if (!row.kind.includes('.')) continue;
      const [kind, field] = row.kind.split('.');
      if (!(kind === 'tasks' || kind === 'runs') || !(historyKinds[kind] as readonly string[]).includes(field)) throw new ApiError(500, 'UNKNOWN_STORED_HISTORY', 'Unknown retained history kind.');
      const [id, index] = JSON.parse(row.id);
      const parent = (kind === 'tasks' ? tasks : runs).get(id);
      if (!parent || !Array.isArray(parent[field])) throw new ApiError(500, 'ORPHANED_HISTORY', 'A retained history record has no parent.');
      parent[field][index] = JSON.parse(row.data);
    }
    return snapshot;
  }

  write(snapshot: HostedSnapshot, expectedRevision: number, options={automaticIndex:true}): void {
    if (Object.hasOwn(snapshot,'page') || Object.hasOwn(snapshot.workspace,'page')) throw new ApiError(409,'PARTIAL_WORKSPACE_WRITE','A workspace page cannot replace durable workflow state.');
    if (snapshot.revision !== expectedRevision + 1) throw new ApiError(409, 'STATE_CONFLICT', 'A save must advance exactly one revision.');
    const parts = split(snapshot);
    this.storage.transactionSync(() => {
      const header = this.storage.sql.exec<Header>('SELECT revision, data FROM workspace_header WHERE id = 1').one();
      if (header.revision !== expectedRevision) throw new ApiError(409, 'STATE_CONFLICT', 'The workspace changed; retry the same operation.');
      if (JSON.parse(header.data).workspace.id !== snapshot.workspace.id) throw new ApiError(409, 'WORKSPACE_ID_MISMATCH', 'Workspace identity cannot change.');
      const old = new Map(this.storage.sql.exec<RecordRow>('SELECT kind, id, position, data FROM workspace_records').toArray().map(row => [JSON.stringify([row.kind, row.id]), row]));
      const dirty = new Set<string>();
      const taskProjects = new Map(snapshot.workspace.tasks.map(task => [task.id, task.projectId]));
      const runProjects = new Map(snapshot.workspace.runs.map(run => [run.id, taskProjects.get(run.taskId)]));
      for (const row of old.values()) if (row.kind === 'tasks' && !taskProjects.has(row.id)) taskProjects.set(row.id, JSON.parse(row.data).projectId);
      for (const row of old.values()) if (row.kind === 'runs' && !runProjects.has(row.id)) runProjects.set(row.id, taskProjects.get(JSON.parse(row.data).taskId));
      const mark = (row: RecordRow) => {
        const value = JSON.parse(row.data);
        const id = row.kind === 'projects' ? row.id : row.kind === 'tasks' ? value.projectId : row.kind === 'runs' ? taskProjects.get(value.taskId)
          : row.kind.startsWith('tasks.') ? taskProjects.get(JSON.parse(row.id)[0]) : row.kind.startsWith('runs.') ? runProjects.get(JSON.parse(row.id)[0]) : null;
        if (id) dirty.add(id);
      };
      for (const row of parts.records) {
        const key = JSON.stringify([row.kind, row.id]);
        const previous = old.get(key);
        if(row.kind==='recoveryImports'&&previous&&previous.data!==row.data)throw new ApiError(409,'RECOVERY_IMPORT_IMMUTABLE','Retained recovery archives and provenance cannot be changed.');
        if (!previous || previous.data !== row.data || previous.position !== row.position) { this.put(row); mark(row); }
        old.delete(key);
      }
      // Removal is explicit, never an ignored stale row. Project removal is not a workflow operation.
      for (const row of old.values()) {
        if (row.kind === 'operations') throw new ApiError(409,'OPERATION_RECEIPT_REMOVAL','Retained operation identities cannot be forgotten or reused.');
        if(row.kind==='recoveryImports')throw new ApiError(409,'RECOVERY_IMPORT_IMMUTABLE','Retained recovery archives cannot be removed.');
        this.storage.sql.exec('DELETE FROM workspace_records WHERE kind = ? AND id = ?', row.kind, row.id);
        mark(row);
      }
      this.storage.sql.exec('UPDATE workspace_header SET revision = ?, data = ? WHERE id = 1', snapshot.revision, parts.header);
      for (const id of dirty) this.dirty(id, snapshot.revision,options.automaticIndex);
    });
    for (const waiter of [...this.changeWaiters]) waiter();
  }
}
