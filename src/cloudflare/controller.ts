import { createWorkspace, reviseTask, setTaskOwner, updateTaskBase, recordGitCandidate, coordination, MAX_ACTIVE_RUNS, assignRun, startRun, completeRun, verifyRun, reviewRun, codeReviewContext, recordCodeReview, recordFindingDecision, assignReviewers, mergeRun, failRun, metrics, WorkflowError } from "../core/workflow.mjs";
import type { Workspace, Evidence, Review, Task, Project, Run, AuthenticatedIdentity, CodeReviewFinding } from "../core/workflow.mjs";
import { taskBriefs, projectName, queueProjectTasks, eligibleQueuedTasks, queueIdle, bindQueuedBase, requireProjectAdmission, setProjectPolicy } from '../core/project-work.mjs';
import { executionLimits, runEditingAgent } from '../core/agent.mjs';
import type { ExecutionLimits, ExecutionReceipt, ModelProvider } from '../core/agent.mjs';
import type { ArtifactGit } from './git-transport.mjs';
import { buildTaskHandoff } from '../core/handoff.mjs';
import { buildProjectArchive, readProjectArchive } from '../core/project-archive.mjs';
import { ApiError, commitId, digest, text } from "./security.ts";
import { exactCommit, inspectResult, safeRemote, branchHead, readArtifactSnapshot } from "./artifacts.ts";
import type { ArtifactSnapshot } from './artifacts.ts';
import { Buffer } from 'node:buffer';
import { readCheckDefinition, requirementsDigest, digest as definitionDigest } from '../core/check-definition.mjs';
import { verifyArtifactCandidate } from './repository-checks.ts';
import type { CheckPolicy, RepositoryCheckRuntime } from './repository-checks.ts';
import { checkoutCases } from '../../fixtures/checkout-cases.mjs';
import { hostedMergeStateByRun, mergeEvidence, mergeEvidenceChanged, retainMergeEvidence } from '../core/merge-lifecycle.mjs';
import { assertAuthority, assertSession, ownerBinding } from './access.ts';
import type { HostedAuthority, AccessPrincipal } from './access.ts';
import { automaticApprovalEligible, approveRunByPolicy } from '../core/workflow.mjs';
import { setAutomaticMergePolicy } from '../core/project-work.mjs';
import { automaticMergePolicyCurrent, independentReviewStatus } from '../../public/review-boundary.js';
import {parseWorkspacePage} from '../../public/workspace-page.js';

const sampleTask = { title: 'Make checkout totals trustworthy', owner: 'Cloudflare coordinator', purpose: 'Calculate exact integer-cent totals and reject invalid inputs and unsafe totals.',
  criteria: ['Use safe integer cents.', 'Reject invalid quantities and prices.', 'Preserve valid inputs and reject unsafe totals.'] };

function validateFindingLocations(findings: CodeReviewFinding[], head: ArtifactSnapshot, base?: ArtifactSnapshot): void {
  for (const finding of findings) {
    const snapshot = finding.location.side === 'head' ? head : base;
    const file = snapshot?.files.find(item => item.name === finding.location.path);
    if (!file) throw new ApiError(422, 'INVALID_REVIEW_LOCATION', 'A finding points outside the committed source for its selected side.');
    let contents: string;
    try { contents = new TextDecoder('utf-8', {fatal: true, ignoreBOM: false}).decode(Buffer.from(file.base64, 'base64')); }
    catch { throw new ApiError(422, 'INVALID_REVIEW_LOCATION', 'A finding needs a UTF-8 source file with countable lines.'); }
    const lines = contents.split('\n');
    if (lines.at(-1) === '') lines.pop();
    if (finding.location.endLine > lines.length) throw new ApiError(422, 'INVALID_REVIEW_LOCATION', 'A finding points beyond the committed file.');
    finding.oid = file.oid;
  }
}

interface Operation {
  report?: Evidence;
  idleResult?: { idle: boolean; reason: string; waitingTaskIds: string[] };
  fingerprint: string;
  kind: "task" | "assign" | "claim" | "model" | "merge" | "checks" | "base-update" | "model-check" | "review-inference" | "restore";
  reservesExecution?: boolean;
  state: "pending" | "complete" | "failed";
  itemId?: string;
  resourceName?: string;
  marker?: string;
  attemptId?: string;
  executorAttemptId?: string;
  leaseUntil?: number;
  baseCommit?: string;
  projectId?: string;
  taskId?: string;
  taskIds?: string[];
  cancelled?: boolean;
  pendingCommit?: string;
  sourceRunId?: string;
  errorCode?: string;
  timestamp?: number;
  contextId?: string;
  assignmentId?: string;
  reviewerId?: string;
  reviewerIssuer?: string;
  model?: string;
  startedAt?: string;
}
interface HostedJob { status: 'queued' | 'running' | 'finished' | 'failed'; task: Task; limits: ExecutionLimits; phase: string; pendingCommit?: string; attemptId?: string }
export interface HostedRuntime {
  ensureSubscription?: (repositoryName:string,validate:()=>void)=>Promise<void>;
  checks: { verify(source: string, commit: string, signal?: AbortSignal, attemptId?: string): Promise<Evidence> };
  cancelVerification?: (attemptId: string, profile: 'commands' | 'checkout', checkCount: number) => Promise<void>;
  repositoryChecks?: RepositoryCheckRuntime;
  git: ArtifactGit;
  provider?: ModelProvider;
  modelName?: string;
  repository?: string;
  saveReceipt(runId: string, receipt: ExecutionReceipt): Promise<void>;
}
export interface HostedSnapshot {
  revision: number;
  workspace: Workspace;
  repositories: Record<string, string>;
  forks: Record<string, { name: string; remote: string }>;
  operations: Record<string, Operation>;
  jobs?: Record<string, HostedJob>;
  checkPolicies?: Record<string, CheckPolicy>;
}
export interface WorkspaceCapacity {limit:number;running:number;reserved:number;occupied:number;queued:number;verification:{limit:number;occupied:number;waiting:number}}
export interface SnapshotPage {
  snapshot: HostedSnapshot;
  capacity: WorkspaceCapacity;
  operationReceipts: number;
  page: {offset:number;limit:number;totalProjects:number;revision:number;nextOffset:number|null;previousOffset:number|null;
    taskNumbers:Record<string,number>;workspaceTotals:{projects:number;tasks:number;runs:number};scope:string};
}
export interface SnapshotStore {
  read(): HostedSnapshot;
  operation(key: string): Operation | undefined;
  project(id: string): Project | undefined;
  readPage(request: NonNullable<ReturnType<typeof parseWorkspacePage>>): SnapshotPage;
  identity(): Pick<Workspace, 'id' | 'authentication' | 'sessionsValidAfter'> & { revision: number; empty: boolean };
  write(snapshot: HostedSnapshot, expectedRevision: number, options?:{automaticIndex:boolean}): void;
  waitForChange?(revision: number, signal: AbortSignal): Promise<void>;
}

function executionReservations(snapshot: HostedSnapshot): number {
  return snapshot.workspace.runs.filter(run => run.status === 'assigned' && run.agent !== 'model').length
    + Object.values(snapshot.operations).filter(operation => operation.state === 'pending' && operation.reservesExecution).length;
}
function executionOccupancy(snapshot: HostedSnapshot): number {
  return snapshot.workspace.runs.filter(run => run.status === 'running').length + executionReservations(snapshot);
}
function verificationOccupancy(snapshot: HostedSnapshot, except?: string): number {
  return Object.entries(snapshot.operations).filter(([key, operation]) => key !== except && ['checks', 'merge', 'model-check'].includes(operation.kind) && operation.state === 'pending').length;
}

export function initialSnapshot(id: string): HostedSnapshot {
  return { revision: 0, workspace: { ...createWorkspace({ id, name: "Projects Git", provider: "cloudflare-artifacts" }), projects: {} }, repositories: {}, forks: {}, operations: {}, jobs: {}, checkPolicies: {} };
}

// Upgrade the persisted task-only prototype once, without contacting a provider.
// mainCommit is the last recorded baseline; claims refresh the real default head.
export function migrateSnapshot(snapshot: HostedSnapshot): boolean {
  let changed = false;
  if (!snapshot.checkPolicies) {
    snapshot.checkPolicies = {};
    // Earlier releases supported only this contract. Keep retained decisions explicit.
    for (const task of snapshot.workspace.tasks) task.verificationProfile = 'checkout';
    changed = true;
  }
  if (snapshot.workspace.projects) { if (changed) snapshot.workspace.version++; return changed; }
  if (Object.values(snapshot.operations).some(op => op.kind === 'assign' && op.state === 'pending' && !op.itemId)) throw new ApiError(409, 'PROJECT_MIGRATION_REQUIRED', 'Finish the pending fork assignment with the previous version before upgrading. Its recovery record is retained.');
  snapshot.workspace.projects = {};
  for (const task of snapshot.workspace.tasks) {
    const repository = snapshot.repositories[task.id];
    if (!repository) throw new ApiError(409, 'PROJECT_MIGRATION_REQUIRED', 'A retained task is missing its repository mapping. Restore that mapping before opening the workspace.');
    let project = Object.values(snapshot.workspace.projects).find(item => item.repositoryName === repository);
    if (!project) {
      project = { id: task.id, name: repository, repositoryName: repository, kind: 'artifacts', mainCommit: task.baseCommit, acceptingWork: true, policyVersion: 1, owner: task.owner };
      snapshot.workspace.projects[project.id] = project;
    }
    if (task.mergedCommit) project.mainCommit = task.mergedCommit;
    task.projectId = project.id; task.repositoryKey = project.id; task.repositoryName = repository; task.origin = 'artifacts';
  }
  for (const run of snapshot.workspace.runs) if (run.agent !== 'model') {
    run.origin = 'external-agent';
    if (snapshot.forks[run.id]) run.checkoutState = 'ready';
  }
  for (const job of Object.values(snapshot.jobs ?? {})) job.task.projectId = snapshot.workspace.tasks.find(task => task.id === job.task.id)?.projectId;
  snapshot.workspace.version++;
  return true;
}

function repositoryName(value: unknown): string {
  const name = text(value, "Repository", 100);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) throw new ApiError(400, "INVALID_REPOSITORY", "Use an Artifacts repository name, not a URL.");
  return name;
}

function core<T>(operation: () => T): T {
  try { return operation(); }
  catch (error) {
    if (error instanceof WorkflowError) throw new ApiError(error.status, error.code, error.message);
    throw error;
  }
}

async function coreAsync<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) { return core(() => { throw error; }); }
}

function report(input: unknown, headCommit: string): Evidence {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ApiError(400, "REPORT_REQUIRED", "Supply a harness report with its individual checks.");
  const body = input as Record<string, unknown>;
  if (!Array.isArray(body.checks) || !body.checks.length || body.checks.length > 100) throw new ApiError(400, "INVALID_REPORT", "A harness report needs 1 to 100 checks.");
  const checks = body.checks.map((value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "INVALID_REPORT", "Each check must be an object.");
    const check = value as Record<string, unknown>;
    if (typeof check.passed !== "boolean" || typeof check.detail !== "string" || check.detail.length > 2_000) throw new ApiError(400, "INVALID_REPORT", "Each check needs a boolean result and bounded detail.");
    return { name: text(check.name, "Check name", 200), passed: check.passed, detail: check.detail };
  });
  const passed = checks.filter((check) => check.passed).length;
  if (body.total !== checks.length || body.passed !== passed) throw new ApiError(422, "DENOMINATOR_MISMATCH", "Report counts must match its individual checks.");
  if (!Number.isInteger(body.exitCode) || typeof body.exitCode !== "number" || body.exitCode < 0 || body.exitCode > 255) throw new ApiError(400, "INVALID_REPORT", "Supply a process exit code from 0 to 255.");
  if (typeof body.output !== "string" || body.output.length > 16_000) throw new ApiError(400, "INVALID_REPORT", "Report output is limited to 16,000 characters.");
  if (body.commit !== undefined && body.commit !== headCommit) throw new ApiError(409, "STALE_REPORT", "The report must name the exact submitted commit.");
  return { verified: false, source: "hosted-harness-report", commit: headCommit, checks, passed, total: checks.length,
    command: text(body.command, "Harness command", 1_000), exitCode: body.exitCode, output: body.output, verifiedAt: new Date().toISOString() };
}

export class HostedController {
  private store: SnapshotStore;
  private artifacts: Artifacts;
  private authority: HostedAuthority;
  private runtime?: HostedRuntime;
  constructor(store: SnapshotStore, artifacts: Artifacts, authority: HostedAuthority, runtime?: HostedRuntime) {
    this.store = store;
    this.artifacts = artifacts;
    this.authority = structuredClone(authority);
    const identity = store.identity();
    assertAuthority(this.authority, identity.id);
    this.runtime = runtime;
    if (authority.principal.kind === 'owner' && !identity.authentication && identity.empty) {
      const snapshot = store.read();
      snapshot.workspace.authentication = ownerBinding(authority.policy);
      this.save(snapshot);
    }
    this.checkBinding();
  }

  private checkBinding(): void {
    const state = this.store.identity();
    assertAuthority(this.authority, state.id);
    assertSession(this.authority.principal, state.sessionsValidAfter);
    const expected = ownerBinding(this.authority.policy);
    if (state.authentication && (['provider', 'issuer', 'audience', 'subject', 'workspaceId'] as const).some(key => state.authentication![key] !== expected[key])) throw new ApiError(403, 'WORKSPACE_OWNER_MISMATCH', 'The configured owner does not match this retained workspace.');
    if (!state.authentication && this.authority.principal.kind !== 'owner') throw new ApiError(409, 'OWNER_ADOPTION_REQUIRED', 'The owner must explicitly adopt this retained workspace.');
  }

  private requireOwner(): void {
    this.checkBinding();
    if (!['owner', 'system'].includes(this.authority.principal.kind)) throw new ApiError(403, 'OWNER_REQUIRED', 'Only the authenticated owner can perform this operation.');
    if (!this.store.identity().authentication) throw new ApiError(409, 'OWNER_ADOPTION_REQUIRED', 'Explicitly adopt the retained workspace before changing it.');
  }

  private requireAssignment(runId: string): void {
    this.checkBinding();
    const run = this.store.read().workspace.runs.find(item => item.id === runId);
    if (!run) throw new ApiError(404, 'RUN_NOT_FOUND', 'Assignment not found in this workspace.');
    const actor = this.authority.principal;
    if (actor.kind === 'reviewer') throw new ApiError(403, 'REVIEWER_READ_ONLY', 'Reviewers cannot modify assignments.');
    if (actor.kind === 'agent' && (!run.agentIdentity || run.agentIdentity.id !== actor.id || run.agentIdentity.issuer !== actor.issuer || run.agentIdentity.workspaceId !== actor.workspaceId)) {
      throw new ApiError(403, 'ASSIGNMENT_FORBIDDEN', 'This assignment belongs to another authenticated client.');
    }
    if (!this.store.read().workspace.authentication) throw new ApiError(409, 'OWNER_ADOPTION_REQUIRED', 'Adopt the retained workspace before changing it.');
  }

  private operationKey(requestKey: string): Promise<string> {
    const actor = this.authority.principal;
    return digest(JSON.stringify([actor.workspaceId, actor.issuer, actor.kind, actor.id, requestKey]));
  }

  revokeSessions(input: Record<string, unknown>) {
    this.requireOwner();
    if (this.authority.principal.kind !== 'owner') throw new ApiError(403, 'OWNER_REQUIRED', 'Only the authenticated owner may revoke sessions.');
    if (Object.keys(input).length) throw new ApiError(400, 'INVALID_REVOCATION', 'The server chooses the revocation cutoff; send an empty object.');
    const snapshot = this.store.read();
    const validAfter = Math.max(snapshot.workspace.sessionsValidAfter ?? 0, Math.floor(Date.now() / 1000));
    snapshot.workspace.sessionsValidAfter = validAfter;
    for (const project of Object.values(snapshot.workspace.projects ?? {})) if (project.automaticMergePolicy?.enabled) {
      core(() => setAutomaticMergePolicy(snapshot.workspace, project.id, { enabled: false, expectedVersion: project.automaticMergePolicy!.version }, this.authority.principal as AccessPrincipal));
    }
    snapshot.workspace.version++;
    snapshot.workspace.events.push({ id: crypto.randomUUID(), at: new Date().toISOString(), type: 'workspace.sessions-revoked', taskId: null, runId: null, message: 'Owner revoked all workspace sessions issued at or before ' + new Date(validAfter * 1000).toISOString() + '. External credentials require separate revocation.' });
    this.save(snapshot);
    // The caller is now revoked too. Return only a receipt, not workspace data.
    return { workspaceId: snapshot.workspace.id, sessionsValidAfter: validAfter, signInRequired: true };
  }

  adoptOwner() {
    this.checkBinding();
    if (this.authority.principal.kind !== 'owner') throw new ApiError(403, 'OWNER_REQUIRED', 'Only the authenticated owner may adopt a workspace.');
    const snapshot = this.store.read();
    if (snapshot.workspace.authentication) return this.workspace();
    if (Object.values(snapshot.operations).some(op => op.state === 'pending') || snapshot.workspace.runs.some(run => ['assigned', 'running'].includes(run.status)) || Object.values(snapshot.jobs ?? {}).some(job => ['queued', 'running'].includes(job.status))) {
      throw new ApiError(409, 'ADOPTION_OPERATIONS_PENDING', 'Reconcile retained work with the previous private deployment before adopting its identity policy.');
    }
    for (const run of snapshot.workspace.runs) if (run.status === 'accepted' && !run.review?.identity) {
      if (run.review) { run.reviewHistory ??= []; run.reviewHistory.push(run.review); }
      run.review = null; run.status = 'awaiting_review';
      const task = snapshot.workspace.tasks.find(item => item.id === run.taskId)!;
      task.acceptedRunId = null; task.status = 'review';
    }
    snapshot.workspace.authentication = ownerBinding(this.authority.policy);
    snapshot.workspace.version++;
    snapshot.workspace.events.push({ id: crypto.randomUUID(), at: new Date().toISOString(), type: 'workspace.owner-authenticated', taskId: null, runId: null, message: 'Workspace bound to its configured Access owner. Historical attribution remains unchanged; unmerged legacy acceptances require renewed review.' });
    this.save(snapshot); return this.workspace();
  }

  workspace(snapshot = this.store.read(), globalCapacity?: WorkspaceCapacity) {
    this.checkBinding();
    if (this.authority.principal.kind === 'reviewer') throw new ApiError(403, 'REVIEWER_READ_ONLY', 'Use the sealed candidate review context.');
    const state = snapshot.workspace;
    const reviewRequests = Object.fromEntries(state.runs.map(run => [run.id, this.reviewRequestState(state, run)]));
    const presentation = {...state, reviewRequests};
    const canManage = this.authority.principal.kind === 'owner';
    const mergeStateByRun = hostedMergeStateByRun(snapshot.operations);
    const activeMergeIntents = Object.values(mergeStateByRun).filter(value => value === 'running').length;
    const recoveryRequiredMergeIntents = Object.values(mergeStateByRun).filter(value => value === 'recovery-required').length;
    return { ...state, reviewerNames: canManage ? state.reviewerNames : undefined,
      reviewRequests,
      sampleTask, metrics: metrics(state), coordination: Object.fromEntries(state.runs.map(run => [run.id, coordination(presentation, run.id)])),
      authentication: { mode: 'cloudflare-access', principal: this.authority.principal, adoptionRequired: !state.authentication,
        permissions: { manage: this.authority.principal.kind === 'owner', review: this.authority.principal.kind === 'owner', merge: this.authority.principal.kind === 'owner' },
        agentClientIds: this.authority.principal.kind === 'owner' ? this.authority.policy.agentClientIds : [],
        reviewerClientIds: this.authority.principal.kind === 'owner' ? this.authority.policy.reviewerClientIds ?? [] : [],
        reviewerSubjects: this.authority.principal.kind === 'owner' ? this.authority.policy.reviewerSubjects ?? [] : [] },
      capacity: globalCapacity ?? { limit: MAX_ACTIVE_RUNS, running: state.runs.filter(run => run.status === 'running').length,
        reserved: executionReservations(snapshot),
        occupied: executionOccupancy(snapshot),
        queued: state.runs.filter(run => run.status === 'assigned' && run.agent === 'model').length,
        verification: { limit: 2, occupied: verificationOccupancy(snapshot), waiting: Object.values(snapshot.jobs ?? {}).filter(job => job.status === 'running' && job.phase === 'waiting-check').length } },
      capabilities: { repository: canManage, demo: false, model: canManage && Boolean(this.runtime?.provider && this.runtime.repository), merge: canManage && Boolean(this.runtime), verify: canManage && Boolean(this.runtime), repositoryChecks: canManage && Boolean(this.runtime?.repositoryChecks), baseUpdate: canManage && Boolean(this.runtime), revise: canManage, handoff: true, coordination: true, dependencies: true, providerVerified: false },
      mergeStateByRun,
      reviewInferences: canManage ? Object.values(snapshot.operations).filter(op=>op.kind==='review-inference').map(op=>({
        runId:op.itemId,attemptId:op.attemptId,reviewerId:op.reviewerId,model:op.model,contextId:op.contextId,
        state:op.state,startedAt:op.startedAt??null})) : [],
      recovery: { pendingMergeIntents: activeMergeIntents + recoveryRequiredMergeIntents, activeMergeIntents, recoveryRequiredMergeIntents },
      execution: { kind: 'cloudflare-artifacts', model: this.runtime?.modelName ?? null, inference: Boolean(this.runtime?.provider) } };
  }

  private save(snapshot: HostedSnapshot): void {
    const current = this.store.identity();
    assertAuthority(this.authority, current.id);
    assertSession(this.authority.principal, current.sessionsValidAfter);
    const serialized = JSON.stringify(snapshot);
    if (this.authority.forbiddenSecrets?.some(secret => secret && serialized.includes(secret))) throw new ApiError(400, "SECRET_IN_STATE", "Credentials cannot be saved as workflow data.");
    const revision = snapshot.revision;
    snapshot.revision += 1;
    this.store.write(snapshot, revision);
  }

  async handoff(taskId: string) {
    this.checkBinding();
    if (this.authority.principal.kind === 'reviewer') throw new ApiError(403, 'REVIEWER_READ_ONLY', 'Use the sealed candidate review context.');
    try { return await buildTaskHandoff(this.store.read().workspace, taskId); }
    catch (error) {
      if (error instanceof WorkflowError) throw new ApiError(error.status, error.code, error.message);
      throw error;
    }
  }

  async exportProject(projectId: string) {
    this.requireOwner();
    const snapshot = this.store.read(), project = snapshot.workspace.projects?.[projectId];
    if (!project) throw new ApiError(404, 'PROJECT_NOT_FOUND', 'Project not found.');
    const taskIds = new Set(snapshot.workspace.tasks.filter(task => task.projectId === projectId).map(task => task.id));
    const runIds = new Set(snapshot.workspace.runs.filter(run => taskIds.has(run.taskId)).map(run => run.id));
    if (Object.values(snapshot.operations).some(op => op.state === 'pending' && (op.projectId === projectId
      || taskIds.has(op.taskId ?? '') || taskIds.has(op.itemId ?? '') || runIds.has(op.itemId ?? '')))
      || Object.values(snapshot.jobs ?? {}).some(job => taskIds.has(job.task.id) && ['queued', 'running'].includes(job.status)))
      throw new ApiError(409, 'PROJECT_OPERATION_PENDING', 'Reconcile pending operations before exporting this project.');
    const archive = await coreAsync(() => buildProjectArchive(snapshot.workspace, projectId, new Date().toISOString(), snapshot.checkPolicies));
    using repo = await this.artifacts.get(project.repositoryName);
    await branchHead(repo, archive.payload.project.defaultBranch, project.mainCommit);
    this.requireOwner();
    if (this.store.read().revision !== snapshot.revision) throw new ApiError(409, 'STALE_EXPORT', 'The workspace changed during export. Read the current revision.');
    return archive;
  }

  projectHistory(projectId: string) {
    this.requireOwner();
    const project = this.store.read().workspace.projects?.[projectId];
    if (!project) throw new ApiError(404, 'PROJECT_NOT_FOUND', 'Project not found.');
    return {projectId, restoredFrom: project.restoredFrom ?? null, historical: true,
      boundary: 'Imported records are historical, untrusted attribution. They grant no current verification, approval or credentials.',
      tasks: structuredClone(project.restoredHistory ?? []), checkPolicies: structuredClone(project.restoredCheckPolicies ?? [])};
  }

  async restoreProject(input: Record<string, unknown>, requestKey: string) {
    this.requireOwner();
    if (Object.keys(input).sort().join(',') !== 'archive,expectedSha256,projectName,repo')
      throw new ApiError(422, 'INVALID_RESTORE', 'Supply archive, expectedSha256, projectName and repo only.');
    const archive = await coreAsync(() => readProjectArchive(JSON.stringify(input.archive), text(input.expectedSha256, 'Archive digest', 64)));
    const repoName = repositoryName(input.repo), name = core(() => projectName(input.projectName));
    const key = await this.operationKey(requestKey), fingerprint = await digest(JSON.stringify([archive.sha256, repoName, name]));
    let snapshot = this.store.read();
    const prior = this.checkOperation(snapshot.operations[key], fingerprint, 'restore');
    if (prior?.state === 'complete') {await this.ensureProjectSubscription(prior.projectId!);return {projectId: prior.projectId!, replayed: true, workspace: this.workspace()};}
    if (Object.values(snapshot.workspace.projects ?? {}).some(project => project.repositoryName === repoName))
      throw new ApiError(409, 'PROJECT_EXISTS', 'Restore into an unconnected repository. Existing projects are preserved.');
    using repo = await this.artifacts.get(repoName);
    const info = await repo.info();
    if (info.defaultBranch !== archive.payload.project.defaultBranch) throw new ApiError(409, 'RESTORE_BRANCH_MISMATCH', 'Restored default branch differs from the archive.');
    // Only inspect independently restored Git objects. Archive data never supplies credentials or executes commands.
    for (const hash of archive.payload.commits) await exactCommit(repo, hash);
    await branchHead(repo, info.defaultBranch, archive.payload.project.mainCommit);
    this.requireOwner();
    snapshot = this.store.read();
    const concurrent = this.checkOperation(snapshot.operations[key], fingerprint, 'restore');
    if (concurrent?.state === 'complete') {await this.ensureProjectSubscription(concurrent.projectId!);return {projectId: concurrent.projectId!, replayed: true, workspace: this.workspace()};}
    if (Object.values(snapshot.workspace.projects ?? {}).some(project => project.repositoryName === repoName))
      throw new ApiError(409, 'PROJECT_EXISTS', 'Another operation connected this repository. Existing projects are preserved.');
    const projectId = crypto.randomUUID(), at = new Date().toISOString();
    const project: Project = {id: projectId, name, repositoryName: repoName, mainCommit: archive.payload.project.mainCommit,
      defaultBranch: info.defaultBranch, kind: 'artifacts', acceptingWork: false, policyVersion: 1,
      owner: this.authority.principal.displayName, codeConnected: true,
      restoredFrom: {archiveSha256: archive.sha256, workspaceId: archive.payload.workspace.id, projectId: archive.payload.project.id, at},
      restoredHistory: [...archive.payload.history, ...archive.payload.current], restoredCheckPolicies: archive.payload.checkPolicies};
    snapshot.workspace.projects![projectId] = project;
    snapshot.operations[key] = {kind: 'restore', fingerprint, state: 'complete', projectId};
    snapshot.workspace.version++;
    snapshot.workspace.events.push({id: crypto.randomUUID(), at, type: 'project.restored', projectId, taskId: null, runId: null,
      message: `${name}: restored ${project.restoredHistory!.length} historical task records. New work is paused; earlier decisions are not current approval.`});
    this.save(snapshot);
    await this.ensureProjectSubscription(projectId);
    return {projectId, replayed: false, workspace: this.workspace()};
  }

  private checkOperation(operation: Operation | undefined, fingerprint: string, kind: Operation["kind"]): Operation | undefined {
    if (operation && (operation.fingerprint !== fingerprint || operation.kind !== kind)) throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "This idempotency key was already used with different input.");
    return operation;
  }

  private taskResult(operation: Operation, replayed: boolean) {
    const page = this.store.readPage({limit:1,offset:0,at:null,project:operation.projectId!,task:null,run:null});
    const workspace = {...this.workspace(page.snapshot,page.capacity),page:page.page,operationReceipts:page.operationReceipts};
    return { projectId: operation.projectId!, taskId: operation.itemId!, taskIds: operation.taskIds!, workspace, replayed };
  }

  private async ensureProjectSubscription(projectId:string):Promise<void>{
    const repository=this.store.project(projectId)?.repositoryName;
    if(!repository)throw new ApiError(404,'PROJECT_NOT_FOUND','The subscription needs an owned project.');
    await this.runtime?.ensureSubscription?.(repository,()=>{
      this.checkBinding();
      if(this.store.project(projectId)?.repositoryName!==repository)throw new ApiError(409,'SUBSCRIPTION_OWNER_CHANGED','The owned project changed during registration.');
    });
  }

  async createTasks(input: Record<string, unknown>, requestKey: string, profile: 'commands' | 'checkout' = 'commands') {
    this.requireOwner();
    if (!['repository', 'project'].includes(String(input.source))) throw new ApiError(422, 'PROJECT_SOURCE_REQUIRED', 'Choose an existing project or connect committed Artifacts code.');
    const briefs = core(() => taskBriefs(input));
    for (const brief of briefs) {
      brief.owner = text(brief.owner, 'Task owner', 100);
      brief.title = text(brief.title, 'Title', 180); brief.purpose = text(brief.purpose, 'Purpose', 4000);
      if (!Array.isArray(brief.criteria)) throw new ApiError(422, 'INVALID_CRITERIA', 'Supply acceptance criteria for each task.');
      brief.criteria = brief.criteria.map(item => text(item, 'Criterion', 500));
    }
    const repository = input.source === 'repository' ? repositoryName(input.repo) : undefined;
    const baseCommit = repository ? commitId(input.baseCommit) : undefined;
    const name = repository ? core(() => projectName(input.projectName)) : undefined;
    const projectId = repository ? undefined : text(input.projectId, 'Project ID', 36);
    const key = await this.operationKey(requestKey);
    const fingerprint = await digest(JSON.stringify({ source: input.source, repository, baseCommit, name, projectId, briefs }));
    this.requireOwner();
    const receipt = this.store.operation(key);
    if (receipt?.cancelled) throw new ApiError(410, 'REQUEST_CANCELLED', 'This task request was released. Use a new request ID.');
    const prior = this.checkOperation(receipt, fingerprint, "task");
    if (prior?.state === "complete") {await this.ensureProjectSubscription(prior.projectId!);return this.taskResult(prior, true);}
    let snapshot = this.store.read();
    let project: Project;
    if (repository) {
      if (Object.values(snapshot.workspace.projects!).some(item => item.repositoryName === repository)) throw new ApiError(409, 'PROJECT_EXISTS', 'This repository already belongs to a project. Select that project to queue tasks.');
      project = { id: crypto.randomUUID(), name: name!, repositoryName: repository, mainCommit: baseCommit!, kind: 'artifacts', acceptingWork: true, policyVersion: 1, owner: briefs[0].owner };
      core(() => queueProjectTasks(structuredClone(snapshot.workspace), project, briefs));
      using repo = await this.artifacts.get(repository);
      await exactCommit(repo, baseCommit!);
      const info = await repo.info();
      project.defaultBranch = info.defaultBranch;
      await branchHead(repo, info.defaultBranch, baseCommit!);
    } else {
      const found = snapshot.workspace.projects![projectId!];
      if (!found) throw new ApiError(404, 'PROJECT_NOT_FOUND', 'Select an existing project.');
      project = found;
    }
    // Re-read after provider I/O so other successful operations cannot be overwritten.
    snapshot = this.store.read();
    if (snapshot.operations[key]?.cancelled) throw new ApiError(410, 'REQUEST_CANCELLED', 'This task request was released. No tasks were saved.');
    const concurrent = this.checkOperation(snapshot.operations[key], fingerprint, "task");
    if (concurrent?.state === "complete") {await this.ensureProjectSubscription(concurrent.projectId!);return this.taskResult(concurrent, true);}
    if (repository && Object.values(snapshot.workspace.projects!).some(item => item.repositoryName === repository)) throw new ApiError(409, 'PROJECT_EXISTS', 'Another request connected this code. Select its project to queue tasks.');
    project = repository ? project : snapshot.workspace.projects![projectId!];
    const tasks = core(() => queueProjectTasks(snapshot.workspace, project, briefs));
    snapshot.workspace.projects![project.id] = project;
    for (const task of tasks) { snapshot.repositories[task.id] = project.repositoryName; task.verificationProfile = profile; }
    const operation: Operation = { fingerprint, kind: 'task', state: 'complete', itemId: tasks[0].id, projectId: project.id, taskIds: tasks.map(task => task.id) };
    snapshot.operations[key] = operation;
    this.save(snapshot);
    await this.ensureProjectSubscription(project.id);
    return this.taskResult(operation, false);
  }

  async releaseTaskRequest(requestKey: string) {
    this.requireOwner();
    const key = await this.operationKey(requestKey), snapshot = this.store.read(), prior = snapshot.operations[key];
    if (prior?.kind !== undefined && prior.kind !== 'task') throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This key belongs to another operation.');
    if (prior?.state === 'complete') return { result: this.taskResult(prior, true) };
    snapshot.operations[key] = { fingerprint: '', kind: 'task', state: 'failed', cancelled: true };
    this.save(snapshot);
    return { released: true };
  }

  policy(projectId: string, input: Record<string, unknown>) {
    this.requireOwner();
    const snapshot = this.store.read();
    core(() => setProjectPolicy(snapshot.workspace, projectId, input));
    this.save(snapshot); return this.workspace();
  }

  automaticMergePolicy(projectId: string, input: Record<string, unknown>) {
    this.requireOwner();
    if (this.authority.principal.kind !== 'owner') throw new ApiError(403, 'OWNER_REQUIRED', 'Only the authenticated owner can change automatic approval and merge.');
    const snapshot = this.store.read();
    core(() => setAutomaticMergePolicy(snapshot.workspace, projectId, input, this.authority.principal as AccessPrincipal));
    this.save(snapshot); return this.workspace();
  }

  private automaticDecisionCurrent(snapshot: HostedSnapshot, runId: string): boolean {
    const run = snapshot.workspace.runs.find(item => item.id === runId), task = snapshot.workspace.tasks.find(item => item.id === run?.taskId);
    const project = task?.projectId ? snapshot.workspace.projects?.[task.projectId] : undefined;
    return Boolean(automaticMergePolicyCurrent(snapshot.workspace, project) && run?.review?.policy
      && run.review.policy.version === project?.automaticMergePolicy?.version && run.review.policy.projectId === project?.id
      && this.currentReviewerAllowed(run));
  }

  private reviewerAllowed(id: string): boolean {
    return Boolean(this.authority.policy.reviewerClientIds?.includes(id) || this.authority.policy.reviewerSubjects?.includes(id));
  }

  private currentReviewerAllowed(run?: Run): boolean {
    const reviewer = run?.codeReview?.identity;
    return Boolean(reviewer?.issuer === this.authority.policy.issuer && this.reviewerAllowed(reviewer.id));
  }

  private requireCurrentReviewer(workspace: Workspace, runId: string): void {
    const run = workspace.runs.find(item => item.id === runId);
    // The core gate still owns missing, malformed, stale and non-passing reviews.
    if (run?.codeReview && !this.currentReviewerAllowed(run)) throw new ApiError(409, 'REVIEWER_ACCESS_CHANGED',
      'The assessment reviewer is no longer allowed. Assign a current reviewer and obtain a fresh assessment before accepting or merging.');
  }

  reviewerName(input: Record<string, unknown>) {
    this.requireOwner();
    if (this.authority.principal.kind !== 'owner') throw new ApiError(403, 'OWNER_REQUIRED', 'Only the owner can name configured reviewers.');
    if (Object.keys(input).sort().join(',') !== 'expectedVersion,name,reviewerId') throw new ApiError(422, 'INVALID_REVIEWER_NAME', 'Supply a configured reviewer ID, display name and current workspace version.');
    const id = typeof input.reviewerId === 'string' ? input.reviewerId : '';
    if (!this.reviewerAllowed(id)) throw new ApiError(403, 'REVIEWER_NOT_ALLOWED', 'Names can only be set for an already allowed reviewer.');
    if (typeof input.name !== 'string' || input.name.length > 80 || !input.name.trim() || /[\p{Cc}\p{Cf}]/u.test(input.name)) throw new ApiError(422, 'INVALID_REVIEWER_NAME', 'Use a display name of 1–80 visible characters.');
    const snapshot = this.store.read();
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion !== snapshot.workspace.version) throw new ApiError(409, 'STATE_CONFLICT', 'The workspace changed. Refresh before saving the name.');
    // Presentation metadata never changes the allowlist or authenticated attribution.
    const names = Object.fromEntries([...Object.entries(snapshot.workspace.reviewerNames ?? {}).filter(([key]) => key !== id && this.reviewerAllowed(key)), [id, input.name.trim()]]);
    snapshot.workspace.reviewerNames = names;
    snapshot.workspace.version++;
    this.save(snapshot);
    return { reviewerId: id, name: names[id] };
  }

  private reviewRequestState(workspace: Workspace, run: Run): string {
    const assignment = run.reviewAssignments?.at(-1);
    if (!assignment) return 'unassigned';
    if (!['awaiting_review', 'accepted'].includes(run.status)) return 'closed';
    try { if (codeReviewContext(workspace, run.id).contextId !== assignment.contextId) return 'stale'; }
    catch { return 'stale'; }
    if (!assignment.reviewerIds.some(id => this.reviewerAllowed(id))) return 'reviewer-unavailable';
    if (run.codeReview?.assignmentId !== assignment.id) return 'pending';
    if (!this.currentReviewerAllowed(run)) return 'reviewer-unavailable';
    const review = independentReviewStatus(workspace, run);
    return review.passed ? 'pass' : review.state === 'changes-requested' ? 'changes_requested' : 'stale';
  }

  private retainAutomaticMergeStop(snapshot: HostedSnapshot, runId: string, decisionId: string, code: string, uncertain: boolean): boolean {
    const run = snapshot.workspace.runs.find(item => item.id === runId);
    if (!run || run.automaticMergeStop?.decisionId === decisionId
      || run.review?.policy && run.review.policy.decisionId !== decisionId
      || !run.review?.policy && !run.reviewHistory?.some(review => review.policy?.decisionId === decisionId)) return false;
    const at = new Date().toISOString();
    run.automaticMergeStop = { decisionId, code, at, phase: uncertain ? 'uncertain-write' : 'before-write' };
    snapshot.workspace.version++;
    snapshot.workspace.events.push({ id: crypto.randomUUID(), at, type: 'run.automatic_merge_stopped', taskId: run.taskId, runId,
      message: uncertain ? 'Automatic merge stopped after a Git write may have started. Reconcile the retained intent before any retry.'
        : 'Automatic merge stopped before Git write. Inspect the retained decision and checks before a new decision or explicit retry.' });
    return true;
  }

  private orphanedAutomaticStops(snapshot: HostedSnapshot) {
    return snapshot.workspace.runs.filter(run => {
      const decisionId = run.review?.policy?.decisionId;
      return decisionId && run.automaticMergeStop?.decisionId !== decisionId
        && snapshot.operations['automatic-merge:' + decisionId]?.kind === 'merge'
        && snapshot.operations['automatic-merge:' + decisionId]?.state === 'failed';
    });
  }

  private automaticMergeCandidate(snapshot: HostedSnapshot): string | undefined {
    if (!this.runtime || verificationOccupancy(snapshot) >= 2) return;
    return snapshot.workspace.runs.find(run => {
      const task = snapshot.workspace.tasks.find(item => item.id === run.taskId)!;
      // Serialize project merges. Uncertain writes are reconciled explicitly by the owner.
      if (this.projectMergePending(snapshot, task.projectId!)
        || Object.values(snapshot.operations).some(op => op.state === 'pending' && op.taskId === task.id)) return false;
      if (run.status === 'accepted' && run.review?.policy) return this.automaticDecisionCurrent(snapshot, run.id)
        && run.automaticMergeStop?.decisionId !== run.review.policy.decisionId
        && !snapshot.operations['automatic-merge:' + run.review.policy.decisionId];
      return Boolean(run.codeReview && run.codeReview.identity.issuer === this.authority.policy.issuer
        && this.reviewerAllowed(run.codeReview.identity.id) && automaticApprovalEligible(snapshot.workspace, run.id));
    })?.id;
  }

  hasAutomaticMergeWork(): boolean {
    const snapshot = this.store.read();
    return Boolean(this.orphanedAutomaticStops(snapshot).length || this.automaticMergeCandidate(snapshot));
  }

  async drainAutomaticMerges(): Promise<void> {
    this.requireOwner();
    if (this.authority.principal.kind !== 'system') throw new ApiError(403, 'ALARM_REQUIRED', 'Automatic decisions run only through the private workspace alarm.');
    let snapshot = this.store.read(), repaired = false;
    for (const run of this.orphanedAutomaticStops(snapshot)) {
      const decisionId = run.review!.policy!.decisionId, operation = snapshot.operations['automatic-merge:' + decisionId];
      repaired = this.retainAutomaticMergeStop(snapshot, run.id, decisionId, operation.errorCode ?? 'AUTOMATIC_MERGE_FAILED', false) || repaired;
    }
    if (repaired) { this.save(snapshot); snapshot = this.store.read(); }
    const runId = this.automaticMergeCandidate(snapshot);
    if (!runId) return;
    const run = snapshot.workspace.runs.find(item => item.id === runId)!;
    if (run.status === 'awaiting_review') { core(() => approveRunByPolicy(snapshot.workspace, runId)); this.save(snapshot); }
    const decisionId = run.review!.policy!.decisionId;
    try { await this.merge(runId, { headCommit: run.headCommit }); }
    catch (error) {
      // Admission contention is waiting work, not a failed Git attempt. Its
      // current decision can resume when the other operation releases capacity.
      if (error instanceof ApiError && ['PROJECT_MERGE_PENDING', 'VERIFICATION_CAPACITY', 'TASK_OPERATION_PENDING', 'OPERATION_IN_PROGRESS'].includes(error.code)) return;
      const current = this.store.read(), operation = current.operations['automatic-merge:' + decisionId];
      if (this.retainAutomaticMergeStop(current, runId, decisionId, error instanceof ApiError ? error.code : 'AUTOMATIC_MERGE_FAILED', operation?.state === 'pending')) this.save(current);
    }
  }

  async claim(projectId: string, input: Record<string, unknown>, requestKey: string) {
    return this.assign(projectId, input, requestKey, false, true);
  }

  async assign(targetId: string, input: Record<string, unknown>, requestKey: string, queued = false, claim = false) {
    this.checkBinding();
    const actor = this.authority.principal;
    if (actor.kind === 'reviewer') throw new ApiError(403, 'REVIEWER_READ_ONLY', 'Reviewers cannot claim or create assignments.');
    if (!claim || queued) this.requireOwner();
    if (!this.store.read().workspace.authentication) throw new ApiError(409, 'OWNER_ADOPTION_REQUIRED', 'Adopt the workspace before claiming work.');
    let agentIdentity: AuthenticatedIdentity | undefined;
    if (!queued) {
      const clientId = actor.kind === 'agent' ? actor.id : input.agentClientId;
      if (actor.kind === 'agent' && Object.hasOwn(input, 'agentClientId')) throw new ApiError(403, 'IDENTITY_FORGED', 'Self-claims derive the client identity from Access.');
      if (typeof clientId !== 'string' || !this.authority.policy.agentClientIds.includes(clientId)) throw new ApiError(400, 'AGENT_IDENTITY_REQUIRED', 'Choose a configured Access agent client.');
      agentIdentity = { provider: 'cloudflare-access', kind: 'agent', issuer: actor.issuer, id: clientId, workspaceId: actor.workspaceId, displayName: clientId };
    }
    const agent = queued ? 'model' : 'external';
    const label = text(input.label, "Label", 160);
    const key = await this.operationKey(requestKey);
    const fingerprint = await digest(JSON.stringify({ targetId, agent, label, queued, claim, agentIdentity }));
    const kind = claim ? 'claim' : 'assign';
    let snapshot = this.store.read();
    const prior = this.checkOperation(snapshot.operations[key], fingerprint, kind);
    if (prior?.state === 'complete') return this.assignmentResult(prior, true);
    if (prior?.state === 'failed') throw new ApiError(409, 'ASSIGNMENT_CLOSED', 'This assignment was closed. Use a new request ID for new work.');
    if (prior?.leaseUntil && prior.leaseUntil > Date.now()) throw new ApiError(409, "OPERATION_IN_PROGRESS", "This assignment is running. Retry the same key after 60 seconds.");
    const taskId = prior?.taskId ?? (claim ? core(() => {
      requireProjectAdmission(snapshot.workspace, targetId);
      return eligibleQueuedTasks(snapshot.workspace, targetId)[0]?.id;
    }) : targetId);
    if (!taskId) {
      const operation: Operation = { fingerprint, kind, state: 'complete', projectId: targetId, idleResult: queueIdle(snapshot.workspace, targetId) };
      snapshot.operations[key] = operation; this.save(snapshot);
      return this.assignmentResult(operation, false);
    }
    let task = snapshot.workspace.tasks.find((item) => item.id === taskId);
    if (!task || !snapshot.repositories[taskId]) throw new ApiError(404, "TASK_NOT_FOUND", "Task not found.");
    this.requireTaskIdle(snapshot, taskId);
    core(() => requireProjectAdmission(snapshot.workspace, task!.projectId!));
    if (Object.values(snapshot.operations).some(op => op.kind === 'merge' && op.state === 'pending' && snapshot.workspace.runs.some(run => run.id === op.itemId && snapshot.workspace.tasks.some(item => item.id === run.taskId && item.projectId === task!.projectId)))) throw new ApiError(409, 'MERGE_PENDING', 'Reconcile the pending project merge before admitting more agent work. Queued tasks are retained.');
    if (task.acceptedRunId || task.mergedCommit) throw new ApiError(409, "TASK_CLOSED", "This task already has an accepted result.");
    if (!task.owner) throw new ApiError(409, 'OWNER_REQUIRED', 'Assign a task owner before agent work.');
    if (!prior && snapshot.workspace.runs.some(item => item.taskId === taskId && item.checkoutState === 'preparing' && item.status === 'assigned')) throw new ApiError(409, 'ASSIGNMENT_PREPARING', 'Another assignment is pinning this task base. Retry after its fork is ready.');
    if (!prior && !queued && executionOccupancy(snapshot) >= MAX_ACTIVE_RUNS) throw new ApiError(409, 'CAPACITY_FULL', 'All four agent slots are occupied. Queued tasks remain available.');
    // No await from queue selection through reservation. Concurrent requests see
    // the assigned run before any provider I/O and cannot claim the same task.
    const suffix = key.slice(0, 32);
    const attemptId = crypto.randomUUID();
    const resourceName = prior?.resourceName ?? 'agent-' + crypto.randomUUID();
    const marker = prior?.marker ?? 'projects-agent-git:' + snapshot.workspace.id + ':' + key;
    let run = prior?.itemId ? snapshot.workspace.runs.find(item => item.id === prior.itemId)! : core(() => {
      bindQueuedBase(snapshot.workspace, task!);
      return assignRun(snapshot.workspace, taskId, { agent, label, branch: 'agents/' + suffix });
    });
    run.checkoutState = 'preparing'; if (!queued) { run.origin = 'external-agent'; run.agentIdentity = agentIdentity; }
    snapshot.operations[key] = { ...prior, fingerprint, kind, state: 'pending', itemId: run.id, taskId, projectId: task.projectId, resourceName, marker, attemptId, leaseUntil: Date.now() + 60_000 };
    this.save(snapshot);
    try {
      using source = await this.artifacts.get(snapshot.repositories[taskId]);
      if (!prior?.baseCommit) {
        const info = await source.info();
        const main = (await source.log({ ref: info.defaultBranch, limit: 1 }))[0]?.hash;
        if (!main) throw new ApiError(422, 'PROJECT_EMPTY', 'The project default branch has no commit.');
        await exactCommit(source, main);
        snapshot = this.assertLease(key, attemptId);
        task = snapshot.workspace.tasks.find(item => item.id === taskId)!;
        const project = snapshot.workspace.projects![task.projectId!];
        project.mainCommit = main; project.defaultBranch = info.defaultBranch;
        // The reserved run has no checkout yet. Only the first assignment can
        // choose a new base; alternatives to existing work keep its pinned base.
        core(() => bindQueuedBase(snapshot.workspace, task!, run.id));
        task.resultBranch = info.defaultBranch;
        run = snapshot.workspace.runs.find(item => item.id === run.id)!;
        run.baseCommit = task.baseCommit;
        snapshot.operations[key].baseCommit = task.baseCommit;
        snapshot.workspace.version++;
        this.save(snapshot);
      } else task = this.store.read().workspace.tasks.find(item => item.id === taskId)!;
      await exactCommit(source, task.baseCommit);
      let initialToken: string | undefined;
      if (!prior) {
        try {
          this.assertLease(key, attemptId);
          const fork = await source.fork(resourceName, { description: marker, readOnly: false, defaultBranchOnly: false });
          initialToken = fork.token;
        } catch (error) {
          // Recover only the durably reserved, marked fork for this operation.
          if (!(error && typeof error === "object" && "code" in error && error.code === "ALREADY_EXISTS")) throw error;
        }
      } else {
        // An interrupted fork can still be in progress. No second random fork is created.
        try {
          using recovered = await this.artifacts.get(resourceName);
          if ((await recovered.info()).description !== marker) throw new ApiError(409, "FORK_OWNERSHIP", "A repository with the reserved name belongs to another operation.");
        } catch (error) {
          if (!(error && typeof error === "object" && "code" in error && error.code === "NOT_FOUND")) throw error;
          this.assertLease(key, attemptId);
          const fork = await source.fork(resourceName, { description: marker, readOnly: false, defaultBranchOnly: false });
          initialToken = fork.token;
        }
      }
      using fork = await this.artifacts.get(resourceName);
      const info = await fork.info();
      if (info.description !== marker) throw new ApiError(409, "FORK_OWNERSHIP", "The fork does not belong to this operation.");
      const remote = safeRemote(info.remote);
      await exactCommit(fork, task.baseCommit);
      if (initialToken) await fork.revokeToken(initialToken);
      this.assertLease(key, attemptId);
      // Recovery also removes a credential orphaned by a crash before its response.
      await this.revokeRunTokens(fork, () => this.assertLease(key, attemptId));
      this.assertLease(key, attemptId);
      await this.ensureProjectSubscription(task.projectId!);
      await this.runtime?.ensureSubscription?.(resourceName,()=>{this.assertLease(key,attemptId);});
      this.assertLease(key,attemptId);
      const credential = await fork.createToken("write", 900);
      try {
        snapshot = this.assertLease(key, attemptId);
        core(() => requireProjectAdmission(snapshot.workspace, task!.projectId!));
        run = snapshot.workspace.runs.find(item => item.id === run.id)!;
        if (run.status !== 'assigned') throw new ApiError(409, 'STALE_RUN', 'The reserved assignment changed.');
        run.repository = remote; run.checkoutState = 'ready';
        snapshot.forks[run.id] = { name: resourceName, remote };
        snapshot.operations[key] = { ...snapshot.operations[key], state: 'complete', leaseUntil: 0 };
        snapshot.workspace.version++;
        this.save(snapshot);
        return { ...this.assignmentResult(snapshot.operations[key], false), credentials: { token: credential.plaintext, expiresAt: credential.expiresAt, remote, branch: run.branch, baseCommit: run.baseCommit }, credentialStatus: 'issued-once' };
      } catch (error) {
        await fork.revokeToken(credential.id);
        throw error;
      }
    } catch (error) {
      const latest = this.store.read();
      const operation = latest.operations[key];
      if (operation?.state === "pending" && operation.attemptId === attemptId) {
        operation.leaseUntil = 0;
        this.save(latest);
      }
      throw error;
    }
  }

  private assignmentResult(operation: Operation, replayed: boolean) {
    this.checkBinding();
    if (!operation.itemId) return { ...(operation.idleResult ?? { idle: true, reason: 'No unassigned tasks in this project.' }), replayed, credentials: null };
    return { runId: operation.itemId, taskId: operation.taskId, projectId: operation.projectId, workspace: this.workspace(), credentials: null, credentialStatus: 'already-issued', replayed };
  }

  start(runId: string) {
    this.requireAssignment(runId);
    const snapshot = this.store.read(), run = snapshot.workspace.runs.find(item => item.id === runId);
    const task = snapshot.workspace.tasks.find(item => item.id === run?.taskId);
    if (!run || !task || run.origin !== 'external-agent') throw new ApiError(404, 'RUN_NOT_FOUND', 'External agent assignment not found.');
    if (run.status === 'running') return this.workspace();
    core(() => requireProjectAdmission(snapshot.workspace, task.projectId!));
    if (run.checkoutState !== 'ready') throw new ApiError(409, 'ASSIGNMENT_PREPARING', 'Retry the original assignment request to finish preparing its fork.');
    core(() => startRun(snapshot.workspace, runId)); this.save(snapshot); return this.workspace();
  }

  async fail(runId: string, input: Record<string, unknown>) {
    this.requireAssignment(runId);
    const message = text(input.message, 'Failure reason', 2000);
    let snapshot = this.store.read();
    const run = snapshot.workspace.runs.find(item => item.id === runId);
    if (!run || run.origin !== 'external-agent') throw new ApiError(404, 'RUN_NOT_FOUND', 'External agent assignment not found.');
    if (run.status === 'failed') return this.workspace();
    if (!['assigned', 'running'].includes(run.status)) throw new ApiError(409, 'RUN_CLOSED', 'Only unfinished external work can be failed.');
    const op = Object.values(snapshot.operations).find(item => ['assign', 'claim', 'base-update'].includes(item.kind) && item.itemId === runId);
    if (op?.state === 'pending' && op.leaseUntil && op.leaseUntil > Date.now()) throw new ApiError(409, 'OPERATION_IN_PROGRESS', 'The assignment is still preparing. Wait for its lease before closing it.');
    if (op?.resourceName) {
      try {
        using repo = await this.artifacts.get(op.resourceName);
        if ((await repo.info()).description !== op.marker) throw new ApiError(409, 'FORK_OWNERSHIP', 'The reserved fork belongs to another operation.');
        await this.revokeRunTokens(repo, () => this.requireAssignment(runId));
      } catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'NOT_FOUND')) throw error; }
    }
    snapshot = this.store.read();
    const current = snapshot.workspace.runs.find(item => item.id === runId)!;
    const freshOperation = Object.values(snapshot.operations).find(item => ['assign', 'claim'].includes(item.kind) && item.itemId === runId);
    if (freshOperation?.state === 'pending' && freshOperation.leaseUntil && freshOperation.leaseUntil > Date.now()) throw new ApiError(409, 'OPERATION_IN_PROGRESS', 'A retry is preparing this assignment. Wait before closing it.');
    if (!['assigned', 'running'].includes(current.status)) throw new ApiError(409, 'STALE_RUN', 'This assignment changed while closing it.');
    // Invalidates an expired preparation attempt before it can issue credentials.
    for (const operation of Object.values(snapshot.operations)) if (['claim', 'assign'].includes(operation.kind) && operation.itemId === runId) { operation.state = 'failed'; operation.leaseUntil = 0; }
    if (current.checkoutState === 'preparing') current.checkoutState = 'failed';
    core(() => failRun(snapshot.workspace, runId, message)); this.save(snapshot); return this.workspace();
  }

  private assertLease(key: string, attemptId: string): HostedSnapshot {
    const snapshot = this.store.read();
    const operation = snapshot.operations[key];
    if (operation?.state !== "pending" || operation.attemptId !== attemptId) throw new ApiError(409, "STALE_OPERATION", "A newer retry owns this assignment.");
    operation.leaseUntil = Date.now() + 60_000;
    this.save(snapshot);
    return this.store.read();
  }

  private async checkoutSource(repo: ArtifactsRepo, head: string): Promise<string> {
    const commit = await exactCommit(repo, head);
    const entry = (await repo.readTree(commit.treeHash))?.find(item => item.name === 'checkout.mjs');
    if (!entry || entry.type !== 'blob' || entry.mode !== '100644') throw new ApiError(422, 'UNSUPPORTED_CONTRACT', 'This execution profile requires a regular checkout.mjs module.');
    const blob = await repo.readBlob(entry.hash);
    if (!blob || blob.size > 65536) throw new ApiError(422, 'SOURCE_LIMIT', 'Checkout source must fit within 64 KiB.');
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(await blob.arrayBuffer());
  }

  private async revokeRunTokens(repo: ArtifactsRepo, assertCurrent: () => unknown): Promise<void> {
    const tokens = await repo.listTokens();
    // A delayed list can include a credential delivered by a newer attempt.
    // Recheck ownership after listing and before every provider mutation.
    assertCurrent();
    for (const token of tokens.tokens) if (token.state === 'active') {
      assertCurrent();
      await repo.revokeToken(token.id);
    }
  }

  private requireTaskIdle(snapshot: HostedSnapshot, taskId: string, except?: string) {
    if (Object.entries(snapshot.operations).some(([key, op]) => key !== except && op.state === 'pending'
      && ['checks', 'base-update', 'merge', 'review-inference'].includes(op.kind)
      && (op.taskId === taskId || snapshot.workspace.runs.find(run => run.id === op.itemId)?.taskId === taskId))) {
      throw new ApiError(409, 'TASK_OPERATION_PENDING', 'Finish or reconcile the pending verification, review inference, base update or merge before changing this task.');
    }
  }

  private projectMergePending(snapshot: HostedSnapshot, projectId: string, except?: string): boolean {
    return Object.entries(snapshot.operations).some(([key, op]) => key !== except && op.kind === 'merge' && op.state === 'pending'
      && snapshot.workspace.tasks.find(task => task.id === (op.taskId ?? snapshot.workspace.runs.find(run => run.id === op.itemId)?.taskId))?.projectId === projectId);
  }

  private requireProjectMergeIdle(snapshot: HostedSnapshot, projectId: string, except: string): void {
    if (this.projectMergePending(snapshot, projectId, except)) {
      throw new ApiError(409, 'PROJECT_MERGE_PENDING', 'Another merge owns this project. Wait for its outcome or reconcile its retained intent.');
    }
  }

  setOwner(taskId: string, input: Record<string, unknown>) {
    this.requireOwner();
    const snapshot = this.store.read();
    const runIds = new Set(snapshot.workspace.runs.filter(run => run.taskId === taskId).map(run => run.id));
    if (Object.values(snapshot.operations).some(op => op.kind === 'merge' && op.state === 'pending' && op.itemId && runIds.has(op.itemId))) throw new ApiError(409, 'MERGE_PENDING', 'Reconcile the pending merge before changing ownership.');
    this.requireTaskIdle(snapshot, taskId);
    core(() => setTaskOwner(snapshot.workspace, taskId, { owner: text(input.owner, 'Task owner', 100), expectedOwnerVersion: Number(input.expectedOwnerVersion) }));
    this.save(snapshot);
    return this.workspace();
  }

  revise(taskId: string, input: Record<string, unknown>) {
    this.requireOwner();
    const snapshot = this.store.read();
    const runIds = new Set(snapshot.workspace.runs.filter(run => run.taskId === taskId).map(run => run.id));
    if (Object.values(snapshot.operations).some(op => op.kind === 'merge' && op.state === 'pending' && op.itemId && runIds.has(op.itemId))) throw new ApiError(409, 'MERGE_PENDING', 'Reconcile the pending merge before changing requirements.');
    this.requireTaskIdle(snapshot, taskId);
    if (!Number.isInteger(input.expectedRevision) || !Array.isArray(input.criteria)) throw new ApiError(422, 'INVALID_REVISION', 'Supply the expected revision and current criteria.');
    core(() => reviseTask(snapshot.workspace, taskId, { expectedRevision: Number(input.expectedRevision), purpose: text(input.purpose, 'Purpose', 4000),
      criteria: (input.criteria as unknown[]).map(value => text(value, 'Criterion', 500)), reason: text(input.reason, 'Reason for revision', 2000) }));
    for (const run of snapshot.workspace.runs.filter(run => run.taskId === taskId)) if (snapshot.checkPolicies?.[run.id]) run.checksConfigured = false;
    this.save(snapshot);
    return this.workspace();
  }

  async configureChecks(runId: string, input: Record<string, unknown>, requestKey: string) {
    this.requireOwner();
    const before = this.store.read(), run = before.workspace.runs.find(item => item.id === runId);
    const task = before.workspace.tasks.find(item => item.id === run?.taskId);
    if (!run || !task) throw new ApiError(404, 'RUN_NOT_FOUND', 'Run not found.');
    if (task.verificationProfile !== 'commands') throw new ApiError(422, 'CHECK_PROFILE', 'This retained task uses the declared checkout contract.');
    if (typeof input.definition !== 'string' || typeof input.definitionSha256 !== 'string') throw new ApiError(422, 'CHECK_DEFINITION_REQUIRED', 'Supply an explicit check definition and its SHA-256.');
    try { readCheckDefinition(Buffer.from(input.definition), input.definitionSha256, task, run); }
    catch { throw new ApiError(422, 'INVALID_CHECK_DEFINITION', 'The check definition must match its digest, exact candidate head and current requirements.'); }
    return this.verify(runId, { headCommit: run.headCommit, taskRevision: task.revision }, requestKey, { definition: input.definition, definitionSha256: input.definitionSha256 });
  }

  private async candidateChecks(snapshot: HostedSnapshot, runId: string, repo: ArtifactsRepo, attemptId: string): Promise<Evidence> {
    const run = snapshot.workspace.runs.find(item => item.id === runId)!;
    const task = snapshot.workspace.tasks.find(item => item.id === run.taskId)!;
    if (task.verificationProfile === 'checkout') {
      if (run.changedFiles.some(file => !['checkout.mjs', '.projects/task.json'].includes(file))) throw new ApiError(422, 'UNSUPPORTED_CONTRACT', 'This retained task uses the checkout contract only.');
      return { ...await this.runtime!.checks.verify(await this.checkoutSource(repo, run.headCommit!), run.headCommit!, undefined, attemptId), taskRevision: task.revision };
    }
    const policy = snapshot.checkPolicies?.[runId];
    if (!policy || !this.runtime?.repositoryChecks) throw new ApiError(422, 'CHECK_DEFINITION_REQUIRED', 'Configure independent command checks for this candidate.');
    const plan = readCheckDefinition(Buffer.from(policy.definition), policy.definitionSha256, task, run);
    try {
      const handoff = await buildTaskHandoff(snapshot.workspace, task.id);
      return await verifyArtifactCandidate(this.runtime.repositoryChecks, await readArtifactSnapshot(repo, run.headCommit!), task, run, policy, handoff.sha256, attemptId);
    } catch {
      const checks = plan.checks.map(check => ({ name: check.name, passed: false, detail: 'Not run: the exact source snapshot or verification runtime was unavailable.' }));
      return { verified: false, source: 'independent-sandbox-checks', commit: run.headCommit!, taskRevision: task.revision, checks, passed: 0, total: checks.length, exitCode: 1,
        command: 'Declared repository command checks', output: 'Verification interrupted. Earlier reports are retained as history.', verifiedAt: new Date().toISOString() };
    }
  }

  async verify(runId: string, input: Record<string, unknown>, requestKey: string, policy?: CheckPolicy) {
    this.requireOwner();
    if (!this.runtime) throw new ApiError(503, 'VERIFIER_NOT_CONFIGURED', 'Configure the independent verifier.');
    if (!requestKey) throw new ApiError(400, 'IDEMPOTENCY_REQUIRED', 'Use a request ID for bounded verification.');
    const key = await this.operationKey(requestKey), fingerprint = await digest(JSON.stringify({ runId, input, policy }));
    // Hashing yields. Read after it so capacity inspection and reservation share
    // one synchronous snapshot even when different clients arrive together.
    let before = this.store.read();
    const run = before.workspace.runs.find(item => item.id === runId);
    const resource = before.forks[runId];
    const task = before.workspace.tasks.find(item => item.id === run?.taskId);
    if (!run || !resource || !task) throw new ApiError(404, 'RUN_NOT_FOUND', 'Run not found.');
    if (run.status !== 'awaiting_review' || input.headCommit !== run.headCommit) throw new ApiError(409, 'STALE_RUN', 'Verify a current submitted commit.');
    const revision = task.revision ?? 1;
    if (input.taskRevision !== revision) throw new ApiError(409, 'STALE_REQUIREMENTS', 'Verify the current task revision.');
    const prior = this.checkOperation(before.operations[key], fingerprint, 'checks');
    if (prior?.state === 'complete' || prior?.state === 'failed') return this.workspace();
    if (prior?.leaseUntil && prior.leaseUntil > Date.now()) throw new ApiError(409, 'OPERATION_IN_PROGRESS', 'Verification is running. Retry this request after its two-minute lease.');
    this.requireTaskIdle(before, task.id, key);
    if (verificationOccupancy(before, key) >= 2) throw new ApiError(409, 'VERIFICATION_CAPACITY', 'Two verification attempts are active. Retry when a slot is free.');
    const selected = policy ?? before.checkPolicies?.[runId];
    if (task.verificationProfile !== 'checkout') {
      if (!selected || !this.runtime.repositoryChecks) throw new ApiError(422, 'CHECK_DEFINITION_REQUIRED', 'Configure command checks for this exact commit and requirements revision.');
      try { readCheckDefinition(Buffer.from(selected.definition), selected.definitionSha256, task, run); }
      catch { throw new ApiError(422, 'STALE_CHECK_DEFINITION', 'Configure checks for the current commit and requirements.'); }
      before.checkPolicies![runId] = selected; run.checksConfigured = true;
    }
    const attemptId = crypto.randomUUID();
    if (prior?.state === 'pending') {
      if (!prior.attemptId || !this.runtime.cancelVerification) throw new ApiError(409, 'VERIFICATION_RECOVERY_REQUIRED', 'The previous verifier must be stopped before its slot can be released.');
      const previousAttempt = prior.executorAttemptId ?? prior.attemptId;
      before.operations[key] = {...prior, attemptId, executorAttemptId: previousAttempt, leaseUntil: Date.now() + 120000};
      this.save(before);
      const count = selected ? JSON.parse(selected.definition).checks.length : checkoutCases.length;
      await this.runtime.cancelVerification(previousAttempt, task.verificationProfile === 'checkout' ? 'checkout' : 'commands', count);
      before = this.assertLease(key, attemptId);
    }
    before.operations[key] = { fingerprint, kind: 'checks', state: 'pending', itemId: runId, taskId: task.id, attemptId, leaseUntil: Date.now() + 120000 };
    run.verificationPending = true; before.workspace.version++; this.save(before);
    let evidence: Evidence | undefined;
    try {
      // An interrupted request is closed without repeating any container execution.
      if (prior) throw new Error('Interrupted verification attempt.');
      using repo = await this.artifacts.get(resource.name);
      await this.revokeRunTokens(repo, () => this.assertLease(key, attemptId)); await branchHead(repo, run.branch, run.headCommit!);
      evidence = await this.candidateChecks(before, runId, repo, attemptId);
      await branchHead(repo, run.branch, run.headCommit!);
    } catch {
      const names = selected ? JSON.parse(selected.definition).checks.map((check: { name: string }) => check.name) : checkoutCases.map(check => check.name);
      evidence = { verified: false, source: 'independent-sandbox-checks', commit: run.headCommit!, taskRevision: revision, passed: 0, total: names.length,
        checks: names.map((name: string) => ({ name, passed: false, detail: 'Not completed: verification was interrupted or the candidate branch changed.' })),
        command: 'Independent verification', exitCode: 1, output: 'Attempt interrupted. Start a new verification request to try again.', verifiedAt: new Date().toISOString() };
    }
    const snapshot = this.store.read();
    if (snapshot.operations[key].attemptId !== attemptId) throw new ApiError(409, 'STALE_OPERATION', 'A newer request reconciled this verification.');
    const current = snapshot.workspace.runs.find(item => item.id === runId)!;
    current.verificationPending = false;
    core(() => verifyRun(snapshot.workspace, runId, evidence));
    if (evidence.verification && snapshot.checkPolicies?.[runId]) snapshot.checkPolicies[runId].image = evidence.verification.image;
    snapshot.operations[key].state = evidence.verified ? 'complete' : 'failed'; snapshot.operations[key].leaseUntil = 0;
    this.save(snapshot);
    return this.workspace();
  }

  async updateBase(runId: string, input: Record<string, unknown>, requestKey: string) {
    this.requireOwner();
    if (!this.runtime) throw new ApiError(503, 'BASE_UPDATE_UNAVAILABLE', 'Configure hosted Git transport.');
    const mode = input.mode;
    if (!['reapply', 'resolve'].includes(String(mode))) throw new ApiError(422, 'INVALID_BASE_UPDATE', 'Choose reapply or resolve.');
    const agentClientId = mode === 'resolve' ? input.agentClientId : undefined;
    if (mode === 'resolve' && (typeof agentClientId !== 'string' || !this.authority.policy.agentClientIds.includes(agentClientId))) throw new ApiError(400, 'AGENT_IDENTITY_REQUIRED', 'Choose an allowlisted agent for the resolution assignment.');
    const key = await this.operationKey(requestKey), fingerprint = await digest(JSON.stringify({ runId, headCommit: input.headCommit, taskRevision: input.taskRevision, mode, agentClientId }));
    let snapshot = this.store.read();
    const prior = this.checkOperation(snapshot.operations[key], fingerprint, 'base-update');
    if (prior?.state === 'complete') return { ...this.assignmentResult(prior, true), mode };
    if (prior?.state === 'failed') throw new ApiError(409, prior.errorCode ?? 'BASE_UPDATE_CLOSED', 'This base update was refused. Its inputs are retained. Use a new request for resolution work or a changed base.');
    if (prior?.leaseUntil && prior.leaseUntil > Date.now()) throw new ApiError(409, 'OPERATION_IN_PROGRESS', 'Base update is running. Retry the same request after its lease.');
    const run = snapshot.workspace.runs.find(item => item.id === runId), task = snapshot.workspace.tasks.find(item => item.id === run?.taskId);
    if (!run || !task || !snapshot.forks[runId]) throw new ApiError(404, 'RUN_NOT_FOUND', 'Candidate not found.');
    if (!requestKey || !run.headCommit || input.headCommit !== run.headCommit || input.taskRevision !== task.revision) throw new ApiError(409, 'STALE_RUN', 'Read the exact candidate and current requirements before updating.');
    this.requireTaskIdle(snapshot, task.id, key);
    if (mode === 'resolve') {
      core(() => requireProjectAdmission(snapshot.workspace, task.projectId!));
      if (!prior?.reservesExecution && executionOccupancy(snapshot) >= MAX_ACTIVE_RUNS) throw new ApiError(409, 'CAPACITY_FULL', 'An agent slot is required for resolution work.');
    }
    const attemptId = crypto.randomUUID(), resourceName = prior?.resourceName ?? 'update-' + crypto.randomUUID();
    const marker = prior?.marker ?? 'projects-agent-git:' + snapshot.workspace.id + ':' + key;
    const branch = 'updates/' + key.slice(0, 32);
    snapshot.operations[key] = { ...prior, fingerprint, kind: 'base-update', state: 'pending', taskId: task.id, projectId: task.projectId, sourceRunId: runId,
      resourceName, marker, attemptId, reservesExecution: mode === 'resolve', timestamp: prior?.timestamp ?? Math.floor(Date.now() / 1000), leaseUntil: Date.now() + 60000 };
    this.save(snapshot);
    try {
      using source = await this.artifacts.get(snapshot.repositories[task.id]);
      using candidate = await this.artifacts.get(snapshot.forks[runId].name);
      const info = await source.info();
      const currentBase = prior?.baseCommit ?? (await source.log({ ref: info.defaultBranch, limit: 1 }))[0]?.hash;
      if (!currentBase) throw new ApiError(422, 'PROJECT_EMPTY', 'Project main has no commit.');
      await branchHead(source, info.defaultBranch, currentBase);
      await branchHead(candidate, run.branch, run.headCommit);
      if (currentBase === task.baseCommit) throw new ApiError(409, 'BASE_UNCHANGED', 'Project main has not advanced. This candidate already uses the current base; no update is needed.');
      snapshot = this.assertLease(key, attemptId);
      core(() => updateTaskBase(structuredClone(snapshot.workspace), task.id, { expectedBaseCommit: task.baseCommit, baseCommit: currentBase, sourceRunId: runId }));
      snapshot.operations[key].baseCommit = currentBase; this.save(snapshot);
      let initialToken: string | undefined;
      try {
        using existing = await this.artifacts.get(resourceName);
        if ((await existing.info()).description !== marker) throw new ApiError(409, 'FORK_OWNERSHIP', 'The reserved fork belongs to another operation.');
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'NOT_FOUND')) throw error;
        this.assertLease(key, attemptId);
        initialToken = (await source.fork(resourceName, { description: marker, readOnly: false, defaultBranchOnly: false })).token;
      }
      using fork = await this.artifacts.get(resourceName);
      const forkInfo = await fork.info(), remote = safeRemote(forkInfo.remote);
      if (forkInfo.description !== marker) throw new ApiError(409, 'FORK_OWNERSHIP', 'The fork does not belong to this base update.');
      if (initialToken) await fork.revokeToken(initialToken);
      this.assertLease(key, attemptId);
      await this.revokeRunTokens(fork, () => this.assertLease(key, attemptId));
      await branchHead(fork, info.defaultBranch, currentBase);
      await this.ensureProjectSubscription(task.projectId!);
      await this.runtime?.ensureSubscription?.(resourceName,()=>{this.assertLease(key,attemptId);});
      let head = snapshot.operations[key].pendingCommit;
      let changes: Awaited<ReturnType<typeof inspectResult>> | undefined;
      if (mode === 'reapply') {
        const recordedHead = (await fork.log({ ref: branch, limit: 1 }))[0]?.hash;
        if (recordedHead && recordedHead !== head) throw new ApiError(409, 'STALE_HEAD', 'The reserved result branch changed.');
        if (!recordedHead) {
          await this.revokeRunTokens(candidate, () => this.assertLease(key, attemptId));
          this.assertLease(key, attemptId);
          const write = await fork.createToken('write', 180);
          let read: Awaited<ReturnType<typeof candidate.createToken>> | undefined;
          try {
            this.assertLease(key, attemptId);
            read = await candidate.createToken('read', 180);
            head = await this.runtime.git.reapply({ remote, token: write.plaintext, defaultBranch: info.defaultBranch, branch,
              candidateRemote: snapshot.forks[runId].remote, candidateToken: read.plaintext, candidateBranch: run.branch,
              baseCommit: run.baseCommit, headCommit: run.headCommit, currentBase, timestamp: snapshot.operations[key].timestamp,
              beforePush: async (newHead: string) => {
                await branchHead(source, info.defaultBranch, currentBase); await branchHead(candidate, run.branch, run.headCommit!);
                const fresh = this.assertLease(key, attemptId);
                if (fresh.operations[key].pendingCommit && fresh.operations[key].pendingCommit !== newHead) throw new ApiError(409, 'BASE_UPDATE_CHANGED', 'The recovered Git result differs from the reserved commit.');
                fresh.operations[key].pendingCommit = newHead; this.save(fresh);
              } });
          } finally { await Promise.all([fork.revokeToken(write.id), ...(read ? [candidate.revokeToken(read.id)] : [])]); }
        }
        changes = await inspectResult(fork, currentBase, head!, branch);
      }
      await branchHead(source, info.defaultBranch, currentBase);
      await branchHead(candidate, run.branch, run.headCommit);
      this.assertLease(key, attemptId);
      const credential = mode === 'resolve' ? await fork.createToken('write', 900) : undefined;
      try {
        snapshot = this.assertLease(key, attemptId);
        const oldPolicy = snapshot.checkPolicies?.[runId];
        let plan;
        if (oldPolicy) { try { plan = readCheckDefinition(Buffer.from(oldPolicy.definition), oldPolicy.definitionSha256, task, run); } catch { /* Stale definitions require explicit reconfiguration. */ } }
        const updated = core(() => updateTaskBase(snapshot.workspace, task.id, { expectedBaseCommit: task.baseCommit, baseCommit: currentBase, sourceRunId: runId }));
        snapshot.workspace.projects![task.projectId!].mainCommit = currentBase;
        snapshot.workspace.projects![task.projectId!].defaultBranch = info.defaultBranch;
        let replacement;
        if (mode === 'resolve') {
          core(() => requireProjectAdmission(snapshot.workspace, task.projectId!));
          replacement = core(() => assignRun(snapshot.workspace, task.id, { agent: 'external', label: 'Resolve changes on current main', branch, repository: remote }));
          replacement.origin = 'external-agent'; replacement.checkoutState = 'ready';
          replacement.agentIdentity = { provider: 'cloudflare-access', kind: 'agent', issuer: this.authority.policy.issuer, id: agentClientId as string, workspaceId: snapshot.workspace.id, displayName: agentClientId as string };
        } else {
          replacement = core(() => recordGitCandidate(snapshot.workspace, task.id, { branch, headCommit: head!, ...changes!, summary: 'Reapplied the full retained change to current project main. New checks and review required.' }));
          replacement.origin = 'reconciled-git'; replacement.label = 'Updated candidate'; replacement.repository = remote;
        }
        replacement.reconcilesRunId = runId;
        snapshot.forks[replacement.id] = { name: resourceName, remote };
        if (plan) {
          const definition = JSON.stringify({ ...plan, commit: replacement.headCommit ?? run.headCommit, taskRevision: updated.revision, requirementsSha256: requirementsDigest(updated) });
          snapshot.checkPolicies![replacement.id] = { definition, definitionSha256: definitionDigest(definition) };
          replacement.checksConfigured = mode === 'reapply';
        }
        snapshot.operations[key] = { ...snapshot.operations[key], itemId: replacement.id, state: 'complete', leaseUntil: 0 };
        this.save(snapshot);
        return { ...this.assignmentResult(snapshot.operations[key], false), mode,
          ...(credential ? { credentials: { token: credential.plaintext, expiresAt: credential.expiresAt, remote, branch, baseCommit: currentBase }, credentialStatus: 'issued-once' } : {}) };
      } catch (error) { if (credential) await fork.revokeToken(credential.id); throw error; }
    } catch (error) {
      snapshot = this.store.read();
      const operation = snapshot.operations[key];
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
      if (operation?.attemptId === attemptId && operation.state === 'pending') {
        operation.leaseUntil = 0;
        if (error instanceof ApiError || error instanceof WorkflowError || ['REBASE_CONFLICT', 'EMPTY_REAPPLICATION'].includes(code ?? '')) { operation.state = 'failed'; operation.errorCode = code; }
        this.save(snapshot);
      }
      if (code === 'REBASE_CONFLICT') throw new ApiError(409, code, 'These changes conflict with current project code. Prepare resolution work; the original candidate and task base are retained.');
      if (code === 'EMPTY_REAPPLICATION') throw new ApiError(409, code, 'These changes are already present on current main. The earlier candidate is retained.');
      throw error;
    }
  }

  async queueModels(input: Record<string, unknown>, requestKey: string) {
    this.requireOwner();
    const runtime = this.runtime;
    if (!runtime?.provider || !runtime.modelName || !runtime.repository) throw new ApiError(503, 'MODEL_NOT_CONFIGURED', 'Configure the model and starter repository.');
    if (!Number.isInteger(input.candidates) || Number(input.candidates) < 1 || Number(input.candidates) > 4) throw new ApiError(422, 'INVALID_CANDIDATES', 'Choose 1 to 4 candidates.');
    let limits: ExecutionLimits;
    try { limits = executionLimits(input.limits); }
    catch { throw new ApiError(422, 'INVALID_BUDGET', 'Supply explicit request, input, output and time limits within the supported ranges.'); }
    const repository = repositoryName(runtime.repository);
    const key = await digest('model:' + requestKey);
    const fingerprint = await digest(JSON.stringify({ repository, candidates: input.candidates, limits }));
    let snapshot = this.store.read();
    const prior = this.checkOperation(snapshot.operations[key], fingerprint, 'model');
    if (prior?.state === 'complete') return { taskId: prior.itemId!, workspace: this.workspace(), replayed: true };
    if (prior?.leaseUntil && prior.leaseUntil > Date.now()) throw new ApiError(409, 'OPERATION_IN_PROGRESS', 'Task preparation is in progress. Retry the same key later.');
    const attemptId = crypto.randomUUID();
    const projectId = prior ? prior.projectId : Object.values(snapshot.workspace.projects!).find(project => project.repositoryName === repository)?.id;
    snapshot.operations[key] = { fingerprint, kind: 'model', state: 'pending', attemptId, leaseUntil: Date.now() + 60000, baseCommit: prior?.baseCommit, projectId };
    this.save(snapshot);
    try {
      using repo = await this.artifacts.get(repository);
      const info = await repo.info();
      const base = prior?.baseCommit ?? (await repo.log({ ref: info.defaultBranch, limit: 1 }))[0]?.hash;
      if (!base) throw new ApiError(422, 'STARTER_EMPTY', 'Seed the starter repository before requesting model work.');
      await this.checkoutSource(repo, base);
      snapshot = this.assertLease(key, attemptId);
      snapshot.operations[key].baseCommit = base;
      this.save(snapshot);
      const created = await this.createTasks({ ...(projectId ? { source: 'project', projectId } : { source: 'repository', repo: repository, projectName: 'Checkout starter', baseCommit: base }),
        tasks: [sampleTask] }, requestKey + ':task', 'checkout');
      for (let index = 0; index < Number(input.candidates); index++) {
        this.assertLease(key, attemptId);
        const assigned = await this.assign(created.taskId, { agent: 'model', label: `Model ${index + 1} · ${runtime.modelName}` }, requestKey + ':candidate:' + index, true);
        if (!assigned.runId) throw new ApiError(409, 'ASSIGNMENT_MISSING', 'The model assignment did not reserve a run.');
        const resource = this.store.read().forks[assigned.runId];
        using fork = await this.artifacts.get(resource.name);
        await this.revokeRunTokens(fork, () => this.assertLease(key, attemptId)); // Internal agents never receive Git credentials in a prompt.
        snapshot = this.assertLease(key, attemptId);
        snapshot.jobs ??= {};
        if (!snapshot.jobs[assigned.runId]) snapshot.jobs[assigned.runId] = { status: 'queued', task: structuredClone(snapshot.workspace.tasks.find(task => task.id === created.taskId)!), limits, phase: 'queued' };
        this.save(snapshot);
      }
      snapshot = this.assertLease(key, attemptId);
      snapshot.operations[key] = { fingerprint, kind: 'model', state: 'complete', itemId: created.taskId };
      this.save(snapshot);
      return { taskId: created.taskId, workspace: this.workspace(), replayed: false };
    } catch (error) {
      snapshot = this.store.read();
      const operation = snapshot.operations[key];
      if (operation?.attemptId === attemptId && operation.state === 'pending') { operation.leaseUntil = 0; this.save(snapshot); }
      throw error;
    }
  }

  hasQueuedWork(): boolean {
    const snapshot = this.store.read();
    if (!snapshot.workspace.authentication) return false;
    if (snapshot.workspace.runs.filter(run => run.status === 'running' || run.status === 'assigned' && run.agent !== 'model').length >= MAX_ACTIVE_RUNS) return false;
    return Object.values(snapshot.jobs ?? {}).some(job => job.status === 'queued' && snapshot.workspace.projects?.[job.task.projectId!]?.acceptingWork);
  }

  async drainJobs(): Promise<void> {
    this.requireOwner();
    const fenced = this.store.read(); let needsFence = false;
    for (const job of Object.values(fenced.jobs ?? {})) if (job.status === 'running') { job.attemptId = 'recovery:' + crypto.randomUUID(); needsFence = true; }
    if (needsFence) this.save(fenced);
    for (const [key, operation] of Object.entries(this.store.read().operations)) if (operation.kind === 'model-check' && operation.state === 'pending') {
      if (!operation.attemptId || !this.runtime?.cancelVerification) throw new ApiError(409, 'VERIFICATION_RECOVERY_REQUIRED', 'Stop the interrupted model verifier before releasing its slot.');
      const executorAttemptId = operation.executorAttemptId ?? operation.attemptId, recoveryId = crypto.randomUUID();
      const pending = this.store.read();
      pending.operations[key] = { ...operation, attemptId: recoveryId, executorAttemptId }; this.save(pending);
      await this.runtime.cancelVerification(executorAttemptId, 'checkout', checkoutCases.length);
      const recovered = this.store.read();
      if (recovered.operations[key]?.attemptId === recoveryId && recovered.operations[key].state === 'pending') {
        recovered.operations[key].state = 'failed'; recovered.operations[key].errorCode = 'MODEL_INTERRUPTED'; recovered.operations[key].leaseUntil = 0; this.save(recovered);
      }
    }
    // Only the DO alarm calls this method. A persisted running job here belongs
    // to an interrupted earlier alarm, never a request to repeat inference.
    let snapshot = this.store.read();
    let changed = false;
    for (const [id, job] of Object.entries(snapshot.jobs ?? {})) if (job.status === 'running') {
      const run = snapshot.workspace.runs.find(item => item.id === id);
      job.status = 'failed'; job.phase = 'interrupted'; changed = true;
      if (run && ['assigned', 'running', 'awaiting_review'].includes(run.status)) core(() => failRun(snapshot.workspace, id, 'Hosted execution was interrupted. Retained receipts and any pending commit remain available; inference was not restarted.'));
      if (run?.execution) { run.execution.status = 'interrupted'; run.execution.error = 'Interrupted hosted execution; no automatic inference retry.'; }
    }
    if (changed) this.save(snapshot);
    snapshot = this.store.read();
    const available = Math.max(0, MAX_ACTIVE_RUNS - executionOccupancy(snapshot));
    const ids = Object.entries(snapshot.jobs ?? {}).filter(([, job]) => job.status === 'queued' && snapshot.workspace.projects?.[job.task.projectId!]?.acceptingWork).slice(0, available).map(([id]) => id);
    await Promise.all(ids.map(id => this.executeJob(id)));
  }

  private async modelCheck(runId: string, jobAttemptId: string, source: string, commit: string, signal: AbortSignal): Promise<Evidence> {
    const key = 'model-check:' + crypto.randomUUID(), attemptId = crypto.randomUUID();
    while (true) {
      signal.throwIfAborted(); this.checkBinding();
      const snapshot = this.store.read(), job = snapshot.jobs?.[runId];
      if (job?.status !== 'running' || job.attemptId !== jobAttemptId) throw new ApiError(409, 'STALE_OPERATION', 'The model job no longer owns this check.');
      if (verificationOccupancy(snapshot) < 2) {
        this.checkOperation(snapshot.operations[key], attemptId, 'model-check');
        snapshot.operations[key] = { fingerprint: attemptId, kind: 'model-check', state: 'pending', itemId: runId, taskId: job.task.id, attemptId, leaseUntil: Date.now() + 120000 };
        job.phase = 'checking'; this.save(snapshot); break;
      }
      if (!this.store.waitForChange) throw new ApiError(503, 'VERIFICATION_QUEUE_UNAVAILABLE', 'The workspace store must support verification admission notifications.');
      if (job.phase !== 'waiting-check') { job.phase = 'waiting-check'; this.save(snapshot); }
      await this.store.waitForChange(this.store.read().revision, signal);
    }
    try {
      const evidence = await this.runtime!.checks.verify(source, commit, signal, attemptId);
      const snapshot = this.assertLease(key, attemptId);
      snapshot.operations[key].state = 'complete'; snapshot.operations[key].leaseUntil = 0;
      snapshot.operations[key].report = evidence; this.save(snapshot);
      return evidence;
    } catch (error) {
      const snapshot = this.store.read(), operation = snapshot.operations[key];
      if (operation?.state === 'pending' && operation.attemptId === attemptId) {
        operation.state = 'failed'; operation.errorCode = 'MODEL_CHECK_INTERRUPTED'; operation.leaseUntil = 0; this.save(snapshot);
      }
      throw error;
    }
  }

  private async executeJob(runId: string): Promise<void> {
    const runtime = this.runtime;
    let snapshot = this.store.read();
    const job = snapshot.jobs?.[runId];
    const run = snapshot.workspace.runs.find(item => item.id === runId);
    if (!job || job.status !== 'queued' || !run) return;
    core(() => requireProjectAdmission(snapshot.workspace, job.task.projectId!));
    const attemptId = crypto.randomUUID();
    job.status = 'running'; job.phase = 'reading'; job.attemptId = attemptId;
    this.save(snapshot);
    try {
      core(() => startRun(snapshot.workspace, runId));
      this.save(snapshot);
      if (!runtime?.provider || !runtime.modelName) throw new Error('Model runtime not configured.');
      const resource = snapshot.forks[runId];
      using repo = await this.artifacts.get(resource.name);
      const source = await this.checkoutSource(repo, run.baseCommit);
      let currentSource = source;
      const result = await runEditingAgent({
        instructions: `${job.task.purpose}\n${job.task.criteria.map(item => '- ' + item).join('\n')}\nImplement checkoutTotal(items), a synchronous function. Each item needs a nonnegative safe integer unitCents and positive safe integer quantity.`,
        files: { 'checkout.mjs': source }, limits: job.limits, provider: runtime.provider,
        apply: async (files, signal) => { signal.throwIfAborted(); if (files.length !== 1 || files[0].path !== 'checkout.mjs') throw new Error('Edit scope changed.'); currentSource = files[0].content; },
        check: signal => this.modelCheck(runId, attemptId, currentSource, run.baseCommit, signal),
        save: async receipt => {
          this.assertJob(runId, attemptId);
          await runtime.saveReceipt(runId, receipt);
          const next = this.assertJob(runId, attemptId);
          const active = next.workspace.runs.find(item => item.id === runId)!;
          active.execution = { ...receipt, model: runtime.modelName,
            requests: receipt.requests.map(({ result: _result, checks: _checks, ...request }) => request) };
          next.jobs![runId].phase = receipt.status === 'finished' ? 'committing' : 'model';
          next.workspace.version += 1;
          this.save(next);
        },
      });
      const info = await repo.info();
      this.assertJob(runId, attemptId);
      const credential = await repo.createToken('write', 180);
      let headCommit;
      try {
        this.assertJob(runId, attemptId);
        headCommit = await runtime.git.commitCandidate({ remote: safeRemote(info.remote), token: credential.plaintext, defaultBranch: info.defaultBranch, branch: run.branch,
          baseCommit: run.baseCommit, files: result.files,
          context: { taskId: run.taskId, runId, revision: job.task.revision ?? 1, purpose: job.task.purpose, criteria: job.task.criteria, baseCommit: run.baseCommit },
          beforePush: async head => {
            const next = this.assertJob(runId, attemptId);
            if (next.workspace.runs.find(item => item.id === runId)?.status !== 'running') throw new Error('Run changed before push.');
            next.jobs![runId].pendingCommit = head;
            next.jobs![runId].phase = 'publishing';
            next.workspace.runs.find(item => item.id === runId)!.execution!.pendingCommit = head;
            this.save(next);
          } });
      } finally { await repo.revokeToken(credential.id); }
      const changes = await inspectResult(repo, run.baseCommit, headCommit, run.branch);
      const evidence = await this.modelCheck(runId, attemptId, await this.checkoutSource(repo, headCommit), headCommit, AbortSignal.timeout(120000));
      await branchHead(repo, run.branch, headCommit);
      snapshot = this.assertJob(runId, attemptId);
      core(() => completeRun(snapshot.workspace, runId, { ...changes, headCommit, summary: result.summary }));
      core(() => verifyRun(snapshot.workspace, runId, { ...evidence, taskRevision: job.task.revision ?? 1 }));
      snapshot.jobs![runId].status = 'finished'; snapshot.jobs![runId].phase = 'finished';
      this.save(snapshot);
    } catch {
      snapshot = this.store.read();
      if (snapshot.jobs?.[runId]?.attemptId !== attemptId || snapshot.jobs[runId].status !== 'running') return;
      const current = snapshot.workspace.runs.find(item => item.id === runId);
      const phase = snapshot.jobs![runId].phase;
      if (current && ['assigned', 'running', 'awaiting_review'].includes(current.status)) core(() => failRun(snapshot.workspace, runId, `Hosted execution failed during ${phase}. Inspect retained receipts and any pending commit; inference will not be retried automatically.`));
      snapshot.jobs![runId].status = 'failed';
      this.save(snapshot);
    }
  }

  private assertJob(runId: string, attemptId: string): HostedSnapshot {
    this.checkBinding();
    const snapshot = this.store.read();
    if (snapshot.jobs?.[runId]?.attemptId !== attemptId || snapshot.jobs[runId].status !== 'running') throw new ApiError(409, 'STALE_OPERATION', 'This model executor no longer owns its retained job.');
    return snapshot;
  }

  async merge(runId: string, input: Record<string, unknown>) {
    this.requireOwner();
    const runtime = this.runtime;
    if (!runtime) throw new ApiError(503, 'MERGE_NOT_CONFIGURED', 'Configure hosted verification and Git transport.');
    let snapshot = this.store.read();
    const run = snapshot.workspace.runs.find(item => item.id === runId);
    const task = snapshot.workspace.tasks.find(item => item.id === run?.taskId);
    const resource = snapshot.forks[runId];
    if (!run || !task || !resource) throw new ApiError(404, 'RUN_NOT_FOUND', 'Run not found.');
    const automatic = run.review?.policy;
    if (this.authority.principal.kind === 'system' && !automatic) throw new ApiError(403, 'POLICY_DECISION_REQUIRED', 'The alarm may merge only an explicit automatic policy decision.');
    if (run.status === 'accepted' && !automatic && (!run.review?.identity || run.review.identity.kind !== 'owner' || run.review.identity.id !== this.authority.policy.ownerSubject || run.review.identity.issuer !== this.authority.policy.issuer || run.review.identity.workspaceId !== this.authority.policy.workspaceId)) throw new ApiError(409, 'AUTHENTICATED_REVIEW_REQUIRED', 'Record a review by the current authenticated owner before merging.');
    const head = commitId(input.headCommit);
    if (head !== run.headCommit) throw new ApiError(409, 'STALE_HEAD', 'Merge the reviewed exact commit.');
    const key = automatic ? 'automatic-merge:' + automatic.decisionId : await this.operationKey(`merge:${runId}:${task.revision ?? 1}`);
    const fingerprint = await digest(`${head}:${task.baseCommit}:${task.revision ?? 1}`);
    snapshot = this.store.read();
    const prior = this.checkOperation(snapshot.operations[key], fingerprint, 'merge');
    if (prior?.state === 'complete') return this.workspace();
    const requirePolicy = () => {
      if (automatic && !this.automaticDecisionCurrent(this.store.read(), runId)) throw new ApiError(409, 'AUTOMATIC_POLICY_CHANGED', 'Automatic approval is no longer authorized. Record a fresh owner decision before a new merge.');
      this.requireCurrentReviewer(this.store.read().workspace, runId);
    };
    if (prior?.state !== 'pending') requirePolicy();
    if (automatic && prior?.state === 'pending' && this.authority.principal.kind === 'system') throw new ApiError(409, 'MERGE_RECOVERY_REQUIRED', 'The owner must reconcile the interrupted automatic merge.');
    this.requireTaskIdle(snapshot, task.id, key);
    this.requireProjectMergeIdle(snapshot, task.projectId!, key);
    core(() => mergeRun(structuredClone(snapshot.workspace), runId, { headCommit: head, baseCommit: task.baseCommit, mergedCommit: head }));
    if (prior?.leaseUntil && prior.leaseUntil > Date.now()) throw new ApiError(409, 'OPERATION_IN_PROGRESS', 'Merge is in progress.');
    if (prior?.state === 'pending') {
      const observed = { fingerprint: prior.fingerprint, attemptId: prior.attemptId, leaseUntil: prior.leaseUntil, itemId: prior.itemId, taskId: prior.taskId };
      using target = await this.artifacts.get(snapshot.repositories[run.taskId]);
      const targetInfo = await target.info();
      const current = (await target.log({ ref: targetInfo.defaultBranch, limit: 1 }))[0]?.hash;
      if (current === head) {
        snapshot = this.store.read();
        const retained = snapshot.operations[key];
        if (retained?.kind !== 'merge' || retained.state !== 'pending' || retained.itemId !== observed.itemId || retained.taskId !== observed.taskId
          || retained.fingerprint !== observed.fingerprint || retained.attemptId !== observed.attemptId || retained.leaseUntil !== observed.leaseUntil) {
          throw new ApiError(409, 'STALE_OPERATION', 'The retained merge intent changed during reconciliation.');
        }
        core(() => mergeRun(snapshot.workspace, runId, { headCommit: head, baseCommit: task.baseCommit, mergedCommit: head }));
        snapshot.workspace.projects![task.projectId!].mainCommit = head;
        snapshot.workspace.projects![task.projectId!].defaultBranch = targetInfo.defaultBranch;
        snapshot.operations[key] = { fingerprint, kind: 'merge', state: 'complete', itemId: runId };
        this.save(snapshot);
        return this.workspace();
      }
      if (current !== task.baseCommit) throw new ApiError(409, 'MERGE_RECOVERY_REQUIRED', 'The target head differs from both the retained base and candidate. Inspect it before changing the locked merge intent.');
    }
    requirePolicy();
    if (prior?.state === 'pending') {
      if (!prior.attemptId || !runtime.cancelVerification) throw new ApiError(409, 'VERIFICATION_RECOVERY_REQUIRED', 'Stop the previous merge verifier before retrying.');
      const recoveryId = crypto.randomUUID(), previousAttempt = prior.executorAttemptId ?? prior.attemptId;
      snapshot.operations[key] = {...prior, attemptId:recoveryId, executorAttemptId:previousAttempt, leaseUntil:Date.now()+120000}; this.save(snapshot);
      const policy = snapshot.checkPolicies?.[runId];
      await runtime.cancelVerification(previousAttempt, task.verificationProfile === 'checkout' ? 'checkout' : 'commands', policy ? JSON.parse(policy.definition).checks.length : checkoutCases.length);
      snapshot = this.assertLease(key,recoveryId);
      requirePolicy();
    }
    this.requireProjectMergeIdle(snapshot, task.projectId!, key);
    if (verificationOccupancy(snapshot, key) >= 2) throw new ApiError(409, 'VERIFICATION_CAPACITY', 'Two verification attempts are active. Retry when a slot is free.');
    const attemptId = crypto.randomUUID();
    snapshot.operations[key] = { fingerprint, kind: 'merge', state: 'pending', itemId: runId, taskId: task.id, attemptId, leaseUntil: Date.now() + 120000 };
    this.save(snapshot);
    let pushMayHaveStarted = false;
    try {
      using candidate = await this.artifacts.get(resource.name);
      using target = await this.artifacts.get(snapshot.repositories[run.taskId]);
      await this.revokeRunTokens(candidate, () => this.assertLease(key, attemptId));
      await branchHead(candidate, run.branch, head);
      const checked = await this.candidateChecks(snapshot, runId, candidate, attemptId);
      const evidence = mergeEvidence(checked, attemptId) as Evidence;
      const failed = !evidence.verified || evidence.passed !== evidence.total || evidence.exitCode !== 0;
      const changed = mergeEvidenceChanged(run.evidence, evidence, task.verificationProfile);
      snapshot = this.assertLease(key, attemptId);
      core(() => retainMergeEvidence(snapshot.workspace, runId, evidence, { requiresReview: failed || changed }));
      this.save(snapshot);
      if (failed) throw new ApiError(409, 'CHECKS_FAILED', 'Fresh independent merge checks failed. The report is retained; inspect it before a new decision.');
      if (changed) throw new ApiError(409, 'VERIFIER_CHANGED', 'The verification definition, code or runtime changed after acceptance. Fresh proof is retained; review it before merging.');
      const targetInfo = await target.info();
      const current = (await target.log({ ref: targetInfo.defaultBranch, limit: 1 }))[0]?.hash;
      if (current !== task.baseCommit && current !== head) throw new ApiError(409, 'STALE_BASE', 'The target branch changed after review.');
      if (current !== head) {
        this.assertLease(key, attemptId);
        requirePolicy();
        const write = await target.createToken('write', 180);
        let read: Awaited<ReturnType<typeof candidate.createToken>> | undefined;
        try {
          this.assertLease(key, attemptId);
          requirePolicy();
          read = await candidate.createToken('read', 180);
          requirePolicy();
          await runtime.git.merge({ remote: safeRemote(targetInfo.remote), token: write.plaintext, defaultBranch: targetInfo.defaultBranch,
            candidateRemote: resource.remote, candidateToken: read.plaintext, candidateBranch: run.branch, baseCommit: task.baseCommit, headCommit: head,
            beforePush: async () => {
              await branchHead(candidate, run.branch, head);
              const fresh = this.assertLease(key, attemptId);
              requirePolicy();
              core(() => mergeRun(structuredClone(fresh.workspace), runId, { headCommit: head, baseCommit: task.baseCommit, mergedCommit: head }));
              pushMayHaveStarted = true;
            } });
        } finally { await Promise.all([target.revokeToken(write.id), ...(read ? [candidate.revokeToken(read.id)] : [])]); }
      }
      await branchHead(target, targetInfo.defaultBranch, head);
      snapshot = this.assertLease(key, attemptId);
      core(() => mergeRun(snapshot.workspace, runId, { headCommit: head, baseCommit: task.baseCommit, mergedCommit: head }));
      snapshot.workspace.projects![task.projectId!].mainCommit = head;
      snapshot.workspace.projects![task.projectId!].defaultBranch = targetInfo.defaultBranch;
      snapshot.operations[key] = { fingerprint, kind: 'merge', state: 'complete', itemId: runId };
      this.save(snapshot);
      return this.workspace();
    } catch (error) {
      snapshot = this.store.read();
      const operation = snapshot.operations[key];
      if (operation?.attemptId === attemptId) {
        operation.leaseUntil = 0;
        operation.state = pushMayHaveStarted ? 'pending' : 'failed';
        operation.errorCode = error instanceof ApiError ? error.code : 'MERGE_FAILED';
        if (automatic) this.retainAutomaticMergeStop(snapshot, runId, automatic.decisionId, operation.errorCode, pushMayHaveStarted);
        snapshot.workspace.version += 1;
        snapshot.workspace.events.push({ id: crypto.randomUUID(), at: new Date().toISOString(), type: 'merge.refused', taskId: run.taskId, runId,
          message: pushMayHaveStarted ? 'Merge outcome requires reconciliation. The intent is retained; requirements stay locked until the exact remote head is checked.' : 'Merge refused before push. The accepted candidate and earlier evidence are retained.' });
        this.save(snapshot);
      }
      throw error;
    }
  }

  async complete(runId: string, input: Record<string, unknown>) {
    this.requireAssignment(runId);
    const headCommit = commitId(input.headCommit);
    const summary = text(input.summary, "Summary", 2_000);
    const evidence = input.report === undefined ? null : report(input.report, headCommit);
    let snapshot = this.store.read();
    const run = snapshot.workspace.runs.find((item) => item.id === runId);
    const resource = snapshot.forks[runId];
    if (!run || !resource) throw new ApiError(404, "RUN_NOT_FOUND", "Run not found.");
    if (run.status !== "running") throw new ApiError(409, "INVALID_TRANSITION", "Only a running agent may complete.");
    using repo = await this.artifacts.get(resource.name);
    const changes = await inspectResult(repo, run.baseCommit, headCommit, run.branch);
    await this.revokeRunTokens(repo, () => this.requireAssignment(runId));
    await branchHead(repo, run.branch, headCommit);
    snapshot = this.store.read();
    const current = snapshot.workspace.runs.find((item) => item.id === runId);
    if (current?.status !== "running" || current.baseCommit !== run.baseCommit) throw new ApiError(409, "STALE_RUN", "The run changed while its Git objects were read.");
    if(current.repositoryObservation?.requiresSubmission&&current.repositoryObservation.headCommit!==headCommit)
      throw new ApiError(409,'STALE_HEAD','A different Artifacts head was observed while processing this submission.');
    core(() => completeRun(snapshot.workspace, runId, { headCommit, ...changes, summary }));
    if(current.repositoryObservation)current.repositoryObservation.requiresSubmission=false;
    const policy = snapshot.checkPolicies?.[runId], task = snapshot.workspace.tasks.find(item => item.id === run.taskId)!;
    if (policy && current?.reconcilesRunId) {
      const plan = JSON.parse(policy.definition);
      if (plan.taskRevision === task.revision && plan.requirementsSha256 === requirementsDigest(task)) {
        policy.definition = JSON.stringify({ ...plan, commit: headCommit }); policy.definitionSha256 = definitionDigest(policy.definition); current.checksConfigured = true;
      }
    }
    if (evidence) core(() => verifyRun(snapshot.workspace, runId, evidence));
    this.save(snapshot);
    return this.workspace();
  }

  async reviewContext(runId: string) {
    this.checkBinding();
    if (!['owner', 'reviewer'].includes(this.authority.principal.kind)) throw new ApiError(403, 'REVIEWER_REQUIRED', 'Candidate review context is for the owner and independent reviewers.');
    const snapshot = this.store.read();this.requireReviewAssignment(snapshot.workspace,runId);
    const packet = core(() => codeReviewContext(snapshot.workspace, runId));
    const run = snapshot.workspace.runs.find(run => run.id === runId)!;
    if (this.authority.principal.kind === 'reviewer' && run.reviewAssignments?.at(-1)?.contextId !== packet.contextId) {
      throw new ApiError(409, 'STALE_REVIEW_ASSIGNMENT', 'The owner must assign a review for this changed candidate context.');
    }
    const resource = snapshot.forks[runId];
    if (!resource) throw new ApiError(404, 'RUN_NOT_FOUND', 'Candidate repository not found.');
    using repo = await this.artifacts.get(resource.name);
    await branchHead(repo, run.branch, run.headCommit!);
    const source = await readArtifactSnapshot(repo, run.headCommit!);
    const task = snapshot.workspace.tasks.find(task => task.id === run.taskId)!;
    const baseSource = await readArtifactSnapshot(repo, task.baseCommit);
    this.checkBinding();
    const latest=this.store.read().workspace;
    this.requireReviewAssignment(latest,runId);
    if (latest.version !== snapshot.workspace.version || core(() => codeReviewContext(latest, runId)).contextId !== packet.contextId)
      throw new ApiError(409, 'STALE_CODE_REVIEW', 'The review context or earlier assessment changed while reading source.');
    const previous=run.codeReview;
    const priorReview=previous ? {id:previous.id,at:previous.at,verdict:previous.verdict,summary:previous.summary??null,
      unresolvedFindings:(previous.unresolvedFindingIds??(Array.isArray(previous.findings)
        ?previous.findings.filter(finding=>finding.priority<=1).map(finding=>finding.id):[])).map(id=>{
        const record=[previous,...(run.codeReviewHistory??[])].flatMap(item=>Array.isArray(item.findings)?item.findings:[]).find(item=>item.id===id);
        return record ? {id,title:record.title,body:record.body,location:record.location} : {id};
      })} : null;
    return {...packet, source, baseSource: {...baseSource, files: baseSource.files.filter(file => run.changedFiles.includes(file.name))}, verificationPolicy: snapshot.checkPolicies?.[runId] ?? null,
      evidence: { ...run.evidence, checks: run.evidence!.checks.map(check => ({...check})) },priorReview};
  }

  async reserveReviewInference(runId: string, input: Record<string, unknown>, requestKey: string) {
    this.checkBinding();
    const actor = this.authority.principal;
    if (actor.kind !== 'reviewer') throw new ApiError(403, 'REVIEWER_REQUIRED', 'Only an assigned reviewer may reserve inference.');
    if (typeof requestKey !== 'string' || !requestKey.trim() || requestKey.length > 200)
      throw new ApiError(422, 'IDEMPOTENCY_REQUIRED', 'Supply an idempotency key for this inference attempt.');
    if (!input || Object.keys(input).sort().join(',') !== 'assignmentId,contextId,maxInputBytes,maxOutputTokens,model,timeoutMs'
      || typeof input.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(input.model)
      || !Number.isSafeInteger(input.maxInputBytes) || (input.maxInputBytes as number) < 1 || (input.maxInputBytes as number) > 131072
      || !Number.isSafeInteger(input.maxOutputTokens) || (input.maxOutputTokens as number) < 1 || (input.maxOutputTokens as number) > 8192
      || !Number.isSafeInteger(input.timeoutMs) || (input.timeoutMs as number) < 1 || (input.timeoutMs as number) > 120000)
      throw new ApiError(422, 'REVIEW_LIMITS_REQUIRED', 'Supply the exact context, assignment, model and bounded one-request limits.');
    const key = await this.operationKey(requestKey);
    const fingerprint = await digest(JSON.stringify([runId,input]));
    this.checkBinding();
    const before = this.store.read();
    const previous = this.checkOperation(before.operations[key],fingerprint,'review-inference');
    if (previous) return {attemptId:previous.attemptId,contextId:previous.contextId,state:previous.state,replayed:true};
    this.requireReviewAssignment(before.workspace,runId);
    const run = before.workspace.runs.find(item => item.id === runId)!;
    const assignment = run.reviewAssignments?.at(-1);
    if (!assignment || assignment.id !== input.assignmentId || assignment.contextId !== input.contextId
      || core(() => codeReviewContext(before.workspace,runId)).contextId !== input.contextId)
      throw new ApiError(409,'STALE_REVIEW_ASSIGNMENT','Read the current owner assignment before inference.');
    this.requireTaskIdle(before,run.taskId);
    if (executionOccupancy(before) >= MAX_ACTIVE_RUNS) throw new ApiError(409,'EXECUTION_CAPACITY','Four execution slots are occupied.');
    const resource=before.forks[runId];
    if(!resource)throw new ApiError(404,'RUN_NOT_FOUND','Candidate repository not found.');
    using repo=await this.artifacts.get(resource.name);
    await branchHead(repo,run.branch,run.headCommit!);
    this.checkBinding();
    const current=this.store.read();
    const raced=this.checkOperation(current.operations[key],fingerprint,'review-inference');
    if(raced)return {attemptId:raced.attemptId,contextId:raced.contextId,state:raced.state,replayed:true};
    this.requireReviewAssignment(current.workspace,runId);
    const latest=current.workspace.runs.find(item=>item.id===runId)!;
    if(latest.reviewAssignments?.at(-1)?.id!==input.assignmentId
      || core(()=>codeReviewContext(current.workspace,runId)).contextId!==input.contextId)
      throw new ApiError(409,'STALE_REVIEW_ASSIGNMENT','The review context changed before inference was reserved.');
    this.requireTaskIdle(current,latest.taskId);
    if(executionOccupancy(current)>=MAX_ACTIVE_RUNS)throw new ApiError(409,'EXECUTION_CAPACITY','Four execution slots are occupied.');
    const attemptId=crypto.randomUUID();
    current.operations[key]={kind:'review-inference',state:'pending',fingerprint,itemId:runId,taskId:latest.taskId,
      attemptId,contextId:input.contextId as string,assignmentId:input.assignmentId as string,
      reviewerId:actor.id,reviewerIssuer:actor.issuer,model:input.model as string,reservesExecution:true,
      startedAt:new Date().toISOString(),timestamp:Date.now()};
    this.save(current);
    return {attemptId,contextId:input.contextId,state:'pending',replayed:false};
  }

  reconcileReviewInference(runId: string, attemptId: string, input: Record<string, unknown>) {
    this.requireOwner();
    if(typeof input?.note!=='string'||!input.note.trim()||input.note.length>2000
      || !Number.isSafeInteger(input.expectedRevision))
      throw new ApiError(422,'RECONCILIATION_REQUIRED','Supply the current source revision and an explicit recovery note.');
    const snapshot=this.store.read();
    if(snapshot.revision!==input.expectedRevision)throw new ApiError(409,'STATE_CONFLICT','Refresh the workspace before reconciling inference.');
    const entry=Object.values(snapshot.operations).find(op=>op.kind==='review-inference'&&op.itemId===runId&&op.attemptId===attemptId);
    if(!entry)throw new ApiError(404,'REVIEW_ATTEMPT_NOT_FOUND','Review inference attempt not found.');
    if(entry.state!=='pending')throw new ApiError(409,'REVIEW_ATTEMPT_SETTLED','Only a pending inference attempt can be reconciled.');
    entry.state='failed';entry.reservesExecution=false;entry.errorCode='OWNER_RECONCILED';entry.timestamp=Date.now();
    snapshot.workspace.version++;
    snapshot.workspace.events.push({id:crypto.randomUUID(),at:new Date().toISOString(),type:'run.review_inference_reconciled',
      taskId:entry.taskId!,runId,message:'Owner reconciled retained review inference attempt: '+input.note.trim()});
    this.save(snapshot);
    return {attemptId,state:entry.state,runId};
  }

  async codeReview(runId: string, input: Record<string, unknown>, requestKey: string) {
    this.checkBinding();
    const actor = this.authority.principal;
    if (actor.kind !== 'reviewer') throw new ApiError(403, 'REVIEWER_REQUIRED', 'Only a separately allowlisted reviewer can submit independent code review.');
    if (typeof requestKey !== 'string' || !requestKey.trim() || requestKey.length > 200) throw new ApiError(422, 'IDEMPOTENCY_REQUIRED', 'Supply an idempotency key for this assessment.');
    const key = await this.operationKey(requestKey);
    this.checkBinding();
    const attemptId=input?.reviewAttemptId;
    if(attemptId!==undefined && (typeof attemptId!=='string'||!/^[a-f0-9-]{36}$/.test(attemptId)))
      throw new ApiError(422,'INVALID_REVIEW_ATTEMPT','Supply a valid retained review inference attempt.');
    const assessmentInput=attemptId===undefined?input:Object.fromEntries(Object.entries(input).filter(([field])=>field!=='reviewAttemptId'));
    const requireAttempt=(snapshot:HostedSnapshot)=>{
      if(attemptId===undefined){
        if(Object.values(snapshot.operations).some(op=>op.kind==='review-inference'&&op.itemId===runId
          && op.contextId===assessmentInput.contextId&&op.reviewerId===actor.id&&op.reviewerIssuer===actor.issuer))
          throw new ApiError(409,'REVIEW_ATTEMPT_REQUIRED','This reviewer must submit through its retained inference attempt.');
        return;
      }
      const operation=snapshot.operations[key];
      if(operation?.kind!=='review-inference'||operation.attemptId!==attemptId||operation.itemId!==runId
        ||operation.contextId!==assessmentInput.contextId||operation.reviewerId!==actor.id||operation.reviewerIssuer!==actor.issuer
        ||!['pending','complete'].includes(operation.state))
        throw new ApiError(409,'REVIEW_ATTEMPT_STALE','The retained inference attempt is missing, superseded or reconciled.');
    };
    // Validate before any provider I/O, then validate again after the branch read.
    const snapshot = this.store.read();
    this.requireReviewAssignment(snapshot.workspace,runId);
    requireAttempt(snapshot);
    const validation = structuredClone(snapshot.workspace);
    const validated = core(() => recordCodeReview(validation, runId, assessmentInput, actor, key));
    if (validation.version === snapshot.workspace.version) return {runId, codeReview: validated.codeReview};
    this.requireTaskIdle(snapshot, snapshot.workspace.runs.find(run => run.id === runId)!.taskId,attemptId===undefined?undefined:key);
    const resource = snapshot.forks[runId];
    if (!resource) throw new ApiError(404, 'RUN_NOT_FOUND', 'Candidate repository not found.');
    using repo = await this.artifacts.get(resource.name);
    const run = snapshot.workspace.runs.find(run => run.id === runId)!;
    await branchHead(repo, run.branch, run.headCommit!);
    const findings = validated.codeReview?.findings;
    const head = Array.isArray(findings) && findings.length ? await readArtifactSnapshot(repo, run.headCommit!) : null;
    const base = Array.isArray(findings) && findings.some(finding => finding.location.side === 'base')
      ? await readArtifactSnapshot(repo, snapshot.workspace.tasks.find(task => task.id === run.taskId)!.baseCommit) : undefined;
    if (head && Array.isArray(findings)) validateFindingLocations(findings, head, base);
    const current = this.store.read();
    this.checkBinding();
    this.requireReviewAssignment(current.workspace,runId);
    requireAttempt(current);
    this.requireTaskIdle(current, run.taskId,attemptId===undefined?undefined:key);
    const version = current.workspace.version;
    const reviewed = core(() => recordCodeReview(current.workspace, runId, assessmentInput, actor, key));
    const reviewedFindings = reviewed.codeReview?.findings;
    if (head && Array.isArray(reviewedFindings)) validateFindingLocations(reviewedFindings, head, base);
    if (current.workspace.version !== version) {
      if(attemptId!==undefined){current.operations[key].state='complete';current.operations[key].reservesExecution=false;current.operations[key].timestamp=Date.now();}
      this.save(current);
    }
    return {runId, codeReview: reviewed.codeReview};
  }

  private requireReviewAssignment(workspace: Workspace, runId: string) {
    if(this.authority.principal.kind==='owner')return;
    const run=workspace.runs.find(run=>run.id===runId);
    if(!run)throw new ApiError(404,'RUN_NOT_FOUND','Candidate not found.');
    const assignment=run.reviewAssignments?.at(-1);
    if(this.authority.principal.kind!=='reviewer' || !assignment?.reviewerIds.includes(this.authority.principal.id)
      || assignment.identity.issuer!==this.authority.principal.issuer) {
      throw new ApiError(403,'REVIEW_ASSIGNMENT_REQUIRED','Only a currently assigned reviewer can read this candidate.');
    }
  }

  reviewInbox() {
    this.checkBinding();
    const actor=this.authority.principal;
    if(!['owner','reviewer'].includes(actor.kind))throw new ApiError(403,'REVIEWER_REQUIRED','The review inbox is restricted to the owner and reviewers.');
    const workspace=this.store.read().workspace;
    const items=workspace.runs.flatMap(run=>{
      const assignment=run.reviewAssignments?.at(-1);
      if(!assignment || actor.kind==='reviewer' && !assignment.reviewerIds.includes(actor.id))return [];
      const task=workspace.tasks.find(task=>task.id===run.taskId);
      if(!task)return [];
      return [{workspaceId:workspace.id,projectId:task.projectId,taskId:task.id,taskTitle:task.title,
        runId:run.id,runLabel:run.label,headCommit:run.headCommit,assignmentId:assignment.id,
        assignmentScope:assignment.reviewerIds.length>1?'team':'personal',
        assignedAt:assignment.at,reviewerIds:actor.kind==='owner'?assignment.reviewerIds:undefined,
        status:this.reviewRequestState(workspace,run)}];
    });
    return {workspaceId:workspace.id,principal:{kind:actor.kind,id:actor.id,displayName:actor.displayName},
      reviewerName:Object.hasOwn(workspace.reviewerNames??{},actor.id)?workspace.reviewerNames![actor.id]:null,items,total:items.length};
  }

  async assignReviewers(runId: string, input: Record<string, unknown>, requestKey: string) {
    this.requireOwner();
    if(this.authority.principal.kind!=='owner')throw new ApiError(403,'OWNER_REQUIRED','Only the owner can assign reviewers.');
    if(typeof requestKey!=='string'||!requestKey.trim()||requestKey.length>200)throw new ApiError(422,'IDEMPOTENCY_REQUIRED','Supply an idempotency key.');
    const key=await this.operationKey(requestKey);this.requireOwner();
    const allowed=[...(this.authority.policy.reviewerClientIds??[]),...(this.authority.policy.reviewerSubjects??[])];
    const snapshot=this.store.read(),validation=structuredClone(snapshot.workspace);
    const result=core(()=>assignReviewers(validation,runId,input,this.authority.principal as AuthenticatedIdentity,allowed,key));
    if(validation.version===snapshot.workspace.version)return {runId,assignment:result};
    const run=snapshot.workspace.runs.find(run=>run.id===runId),resource=snapshot.forks[runId];
    if(!run||!resource)throw new ApiError(404,'RUN_NOT_FOUND','Candidate repository not found.');
    this.requireTaskIdle(snapshot,run.taskId);
    using repo=await this.artifacts.get(resource.name);await branchHead(repo,run.branch,run.headCommit!);
    this.requireOwner();const current=this.store.read();this.requireTaskIdle(current,run.taskId);
    const assignment=core(()=>assignReviewers(current.workspace,runId,input,this.authority.principal as AuthenticatedIdentity,allowed,key));
    this.save(current);return {runId,assignment};
  }

  async findingDecision(runId: string, findingId: string, input: Record<string, unknown>, requestKey: string) {
    this.requireOwner();
    if (this.authority.principal.kind !== 'owner') throw new ApiError(403, 'OWNER_REQUIRED', 'Finding decisions require the authenticated owner.');
    if (typeof requestKey !== 'string' || !requestKey.trim() || requestKey.length > 200) throw new ApiError(422, 'IDEMPOTENCY_REQUIRED', 'Supply an idempotency key.');
    const key = await this.operationKey(requestKey);
    this.requireOwner();
    const snapshot = this.store.read();
    const decision = core(() => recordFindingDecision(snapshot.workspace, runId, findingId, input, this.authority.principal as AuthenticatedIdentity, key));
    if (snapshot.workspace.version !== this.store.read().workspace.version) this.save(snapshot);
    return {runId, findingDecision: decision};
  }

  async review(runId: string, input: Record<string, unknown>) {
    this.requireOwner();
    if (['reviewer', 'identity', 'reviewerIdentity', 'principal', 'policy'].some(key => Object.hasOwn(input, key))) throw new ApiError(400, 'IDENTITY_FORGED', 'Reviewer identity is derived from the authenticated owner.');
    if (this.authority.principal.kind !== 'owner') throw new ApiError(403, 'OWNER_REQUIRED', 'Human review requires the authenticated owner.');
    const decision = input.decision;
    if (decision !== "accept" && decision !== "reject") throw new ApiError(400, "INVALID_DECISION", "Choose accept or reject.");
    const review: Omit<Review, "at"> = { decision, note: text(input.note, "Review note", 2_000), reviewer: this.authority.principal.displayName, headCommit: commitId(input.headCommit), taskRevision: input.taskRevision === undefined ? 1 : Number(input.taskRevision),
      ownerVersion: input.ownerVersion as number, comparisons: input.comparisons as Review['comparisons'] };
    const before = this.store.read();
    const run = before.workspace.runs.find((item) => item.id === runId);
    const resource = before.forks[runId];
    if (!run || !resource) throw new ApiError(404, "RUN_NOT_FOUND", "Run not found.");
    if (run.headCommit !== review.headCommit) throw new ApiError(409, "STALE_REVIEW", "Review the current candidate commit.");
    this.requireTaskIdle(before, run.taskId);
    if (decision === 'accept') this.requireCurrentReviewer(before.workspace, runId);
    using repo = await this.artifacts.get(resource.name);
    await branchHead(repo, run.branch, review.headCommit);
    const snapshot = this.store.read();
    this.requireTaskIdle(snapshot, run.taskId);
    if (decision === 'accept') this.requireCurrentReviewer(snapshot.workspace, runId);
    core(() => reviewRun(snapshot.workspace, runId, review, this.authority.principal as AccessPrincipal));
    this.save(snapshot);
    return this.workspace();
  }
}
