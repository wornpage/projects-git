export type AuthenticatedIdentity = {issuer:string;id:string;workspaceId:string;displayName:string} & (
  {provider:'cloudflare-access';kind:'owner'|'agent'|'reviewer'|'member'} |
  {provider:'trial-credential';kind:'agent'|'reviewer'});
export interface CodeReviewFinding { id: string; title: string; body: string; priority: 0 | 1 | 2 | 3; location: { path: string; side: 'head' | 'base'; startLine: number; endLine: number }; evidence: string; oid?: string }
export interface CodeReview { repositoryAccessVersion?: number; id: string; at: string; assignmentId?: string; format?: 'projects-code-review-assessment/v2'; contextId: string; context: Record<string, unknown>; verdict: 'pass' | 'changes_requested'; summary?: string; findings: CodeReviewFinding[] | string; resolvedPriorFindingIds?: string[]; unresolvedFindingIds?: string[]; identity: AuthenticatedIdentity }
export interface ReviewAssignment { id: string; at: string; sourceContextId: string; contextId?: string; reviewerIds: string[]; identity: AuthenticatedIdentity }
export interface FindingDecision { id: string; at: string; assessmentId: string; findingId: string; decision: 'resolved' | 'deferred' | 'dismissed'; note: string; identity: AuthenticatedIdentity }
export interface OwnerBinding { provider: 'cloudflare-access'; issuer: string; audience: string; subject: string; workspaceId: string }
export interface AutomaticMergePolicy { mode: 'checks-and-independent-review'; enabled: boolean; version: number; at: string; enabledBy: AuthenticatedIdentity; ownerAudience: string; sessionsValidAfter: number }
export interface PolicyDecision extends AutomaticMergePolicy { projectId: string; decisionId: string }
export interface Review { policy?: PolicyDecision }
export interface Project { automaticMergePolicy?: AutomaticMergePolicy }
export interface Run { automaticMergeStop?: { decisionId: string; code: string; at: string; phase: 'before-write' | 'uncertain-write' } }
export type Provider = 'local-git' | 'cloudflare-artifacts';
export type TaskStatus = 'open' | 'running' | 'review' | 'accepted' | 'merged';
export type RunStatus = 'assigned' | 'running' | 'awaiting_review' | 'failed' | 'accepted' | 'rejected' | 'merged' | 'superseded';
export interface Evidence {
  operation?: 'merge';
  attemptId?: string;
  verification?: { kind: 'repository-command-checks/v1'; definitionSha256: string; verifierSha256: string; inputHandoffSha256: string; requirementsSha256: string; image: string; tree: string };
  taskRevision?: number;
  verified: boolean; commit: string; passed: number; total: number;
  checks: { name: string; passed: boolean; detail: string }[];
  command: string; exitCode: number; output: string; verifiedAt: string;
  source: 'independent-local-checks' | 'independent-sandbox-checks' | 'hosted-harness-report';
}
export interface Review { codeReviewId?: string; identity?: AuthenticatedIdentity; ownerVersion?: number; comparisons?: { runId: string; headCommit: string }[]; decision: 'accept' | 'reject'; note: string; reviewer: string; at: string; headCommit: string; taskRevision?: number }
export interface TaskRevision { revision: number; purpose: string; criteria: string[]; reason: string; at: string }
export interface RepositoryObservation { eventKey:string; ref:string; headCommit:string|null; observedAt:string; eventTimestamp:string; requiresSubmission:boolean }
export interface Task { dependsOn?: string[]; verificationProfile?: "commands" | "checkout"; projectId?: string; origin?: 'connected-git' | 'artifacts'; repositoryName?: string; resultBranch?: string; baseHistory?: { baseCommit: string; revision: number; acceptedRunId: string | null; sourceRunId: string; at: string }[]; owner?: string | null; ownerVersion?: number; ownerHistory?: { owner: string | null; version: number; at: string }[]; repositoryKey?: string | null; id: string; title: string; purpose: string; criteria: string[]; status: TaskStatus; baseCommit: string; createdAt: string; acceptedRunId: string | null; mergedCommit: string | null; revision?: number; revisions?: TaskRevision[] }
export interface Run { repositoryObservation?: RepositoryObservation; reviewAssignments?: ReviewAssignment[]; codeReview?: CodeReview; codeReviewHistory?: CodeReview[]; findingDecisions?: FindingDecision[]; agentIdentity?: AuthenticatedIdentity; verificationPending?: boolean; ownerVersion?: number; origin?: 'existing-git' | 'external-agent' | 'reconciled-git'; checkoutState?: 'preparing' | 'ready' | 'failed'; reconcilesRunId?: string; checksConfigured?: boolean; id: string; taskId: string; agent: string; label: string; status: RunStatus; baseCommit: string; headCommit: string | null; branch: string; repository: string | null; startedAt: string | null; finishedAt: string | null; changedFiles: string[]; diff: string; summary: string; evidence: Evidence | null; review: Review | null; error: string | null; assignedRevision?: number; evidenceHistory?: Evidence[]; reviewHistory?: Review[]; execution?: import('./agent.mjs').ExecutionReceipt & { model?: string; pendingCommit?: string } }
export interface WorkspaceEvent { repositoryEvent?: Record<string,unknown>; id: string; at: string; type: string; projectId?: string; taskId: string | null; runId: string | null; message: string }
export interface Project { access?: import('./repository-access.mjs').RepositoryAccess; repositoryObservation?: RepositoryObservation; id: string; name: string; repositoryName: string; mainCommit: string; defaultBranch?: string; kind: 'sample' | 'connected' | 'artifacts'; acceptingWork: boolean; policyVersion: number; codeConnected?: boolean; owner?: string | null; restoredHistory?: import('./handoff.mjs').TaskHandoff[]; restoredCheckPolicies?: import('./project-archive.mjs').ArchivedCheckPolicy[]; restoredFrom?: {archiveSha256: string; workspaceId: string; projectId: string; at: string} }
export interface Workspace { reviewerNames?: Record<string, string>; sessionsValidAfter?: number; authentication?: OwnerBinding; projects?: Record<string, Project>; schemaVersion: 1; id: string; name: string; provider: Provider; createdAt: string; version: number; tasks: Task[]; runs: Run[]; events: WorkspaceEvent[] }
export class WorkflowError extends Error { constructor(code: string, message: string, status?: number); code: string; status: number }
export function validateCommit(value: unknown): string;
export function createWorkspace(options?: { id?: string; name?: string; provider?: Provider }): Workspace;
export function createTask(state: Workspace, input: { id?: string; title: string; purpose: string; criteria: string[]; baseCommit: string; owner?: string | null; repositoryKey?: string | null }): Task;
export function reviseTask(state: Workspace, taskId: string, input: { expectedRevision: number; purpose: string; criteria: string[]; reason: string }): Task;
export function assignRun(state: Workspace, taskId: string, input: { agent: string; label: string; branch: string; repository?: string | null }): Run;
export function requireTaskDependencies(state: Workspace, task: Task): { ready: boolean; invalid: string | null; waiting: { id: string; title: string; mergedCommit: string | null }[]; integrated: { id: string; title: string; mergedCommit: string | null }[] };
export function startRun(state: Workspace, runId: string): Run;
export function completeRun(state: Workspace, runId: string, input: { headCommit: string; changedFiles: string[]; diff: string; summary: string }): Run;
export function verifyRun(state: Workspace, runId: string, evidence: Evidence): Run;
export function failRun(state: Workspace, runId: string, error: string): Run;
export function reviewRun(state: Workspace, runId: string, review: Omit<Review, 'at' | 'identity'>, identity?: AuthenticatedIdentity): Run;
export function automaticApprovalEligible(state: Workspace, runId: string): boolean;
export function approveRunByPolicy(state: Workspace, runId: string): Run;
export function codeReviewContext(state: Workspace, runId: string): { format: string; contextId: string; context: Record<string, unknown>; candidate: { changedFiles: string[]; diff: string }; boundaries: Record<string, unknown> };
export function recordCodeReview(state: Workspace, runId: string, input: Record<string, unknown>, identity: AuthenticatedIdentity, requestKey: string): Run;
export function assignReviewers(state: Workspace, runId: string, input: Record<string, unknown>, identity: AuthenticatedIdentity, allowedReviewerIds: string[], requestKey: string): ReviewAssignment;
export function validateReviewAssessment(input: Record<string, unknown>, changedFiles: string[]): { format: string; contextId: string; verdict: 'pass' | 'changes_requested'; summary: string; findings: Omit<CodeReviewFinding, 'id'>[]; resolvedPriorFindingIds: string[] };
export function recordFindingDecision(state: Workspace, runId: string, findingId: string, input: Record<string, unknown>, identity: AuthenticatedIdentity, requestKey: string): FindingDecision;
export function independentReviewStatus(state: Workspace, run: Run): { state: string; passed: boolean; label: string };
export function mergeRun(state: Workspace, runId: string, input: { headCommit: string; baseCommit: string; mergedCommit: string }): Run;
export function metrics(state: Workspace): { tasks: Record<'total' | TaskStatus, number>; runs: Record<'total' | 'assigned' | 'running' | 'awaitingReview' | 'accepted' | 'rejected' | 'failed' | 'merged' | 'superseded', number>; checks: { passed: number; total: number; verifiedRuns: number; evidencedRuns: number }; acceptedCandidates: { numerator: number; denominator: number } };

export function recordGitCandidate(state: Workspace, taskId: string, input: { id?: string; branch: string; headCommit: string; changedFiles: string[]; diff: string; summary: string }): Run;

export const MAX_ACTIVE_RUNS: number;
export function setTaskOwner(state: Workspace, taskId: string, input: { owner: string; expectedOwnerVersion: number }): Task;
export function coordination(state: Workspace, runId: string): { acceptance: { code: string; met: boolean; label: string; message: string }[]; activeRunIds: string[]; blockingRunIds: string[]; overlaps: { runId: string; taskId: string; headCommit: string; label: string; status: string; paths: string[] }[] };
export function workspaceCoordination(state: Workspace): Record<string, ReturnType<typeof coordination>>;

export function updateTaskBase(state: Workspace, taskId: string, input: { expectedBaseCommit: string; baseCommit: string; sourceRunId: string }): Task;
