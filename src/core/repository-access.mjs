import {WorkflowError} from './workflow.mjs';

const invalid = () => {throw new WorkflowError('PROJECT_ACCESS_INVALID', 'Repository access needs owner repair before non-owner access.', 503);};
const subject = value => typeof value === 'string' && /^[A-Za-z0-9_.:@-]{1,200}$/.test(value);
const roles = new Map([['member', ['read']], ['agent', ['read', 'build']], ['reviewer', ['review']]]);
export function configuredRepositoryIdentity(policy, kind, id) {
  return kind === 'agent' ? policy.agentClientIds.includes(id)
    : kind === 'reviewer' ? [...(policy.reviewerClientIds ?? []), ...(policy.reviewerSubjects ?? [])].includes(id)
    : kind === 'member' && (policy.memberSubjects ?? []).includes(id);
}
export function repositoryAccess(project) {
  if (project.access === undefined) return {version: 0, grants: [], configured: false};
  const value = project.access;
  if (!value || Object.keys(value).sort().join(',') !== 'grants,updatedAt,updatedBy,version'
    || !Number.isSafeInteger(value.version) || value.version < 1 || !Array.isArray(value.grants) || value.grants.length > 300
    || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt)) || !subject(value.updatedBy)
    || value.grants.some(grant => !grant || Object.keys(grant).sort().join(',') !== 'id,issuer,kind,role'
      || !roles.get(grant.kind)?.includes(grant.role) || !subject(grant.id)
      || typeof grant.issuer !== 'string' || !/^https:\/\/[a-z0-9][a-z0-9-]*\.cloudflareaccess\.com$/.test(grant.issuer))
    || new Set(value.grants.map(grant => grant.kind + ':' + grant.id)).size !== value.grants.length) invalid();
  return {...value, configured: true};
}
export function hasRepositoryPermission(project, actor, policy, permission) {
  if (actor.kind === 'owner' || actor.kind === 'system') return true;
  if (!configuredRepositoryIdentity(policy, actor.kind, actor.id)) return false;
  return repositoryAccess(project).grants.some(grant => grant.kind === actor.kind && grant.id === actor.id
    && grant.issuer === actor.issuer && (grant.role === permission || permission === 'read' && grant.role === 'build'));
}
export function requireRepositoryPermission(project, actor, policy, permission) {
  if (!project || !hasRepositoryPermission(project, actor, policy, permission))
    throw new WorkflowError('PROJECT_FORBIDDEN', 'This repository is unavailable to this identity.', 403);
}
export function setRepositoryAccess(project, input, actor, policy, now = new Date().toISOString()) {
  if (actor.kind !== 'owner') throw new WorkflowError('OWNER_REQUIRED', 'Only the workspace owner can change repository access.', 403);
  if (!input || Object.keys(input).sort().join(',') !== 'expectedVersion,grants'
    || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0 || !Array.isArray(input.grants) || input.grants.length > 300)
    throw new WorkflowError('INVALID_PROJECT_ACCESS', 'Supply the current access version and explicit repository grants.', 422);
  const current = repositoryAccess(project);
  if (current.version !== input.expectedVersion || current.version === Number.MAX_SAFE_INTEGER) throw new WorkflowError('PROJECT_ACCESS_CHANGED', 'Repository access changed or reached its version limit. Read it again before applying your changes.', 409);
  const grants = input.grants.map(grant => {
    if (!grant || Object.keys(grant).sort().join(',') !== 'id,kind,role' || !roles.get(grant.kind)?.includes(grant.role)
      || !subject(grant.id) || !configuredRepositoryIdentity(policy, grant.kind, grant.id))
      throw new WorkflowError('INVALID_PROJECT_GRANT', 'Choose a configured identity and a role allowed for that identity.', 422);
    return {...grant, issuer: policy.issuer};
  });
  if (new Set(grants.map(grant => grant.kind + ':' + grant.id)).size !== grants.length)
    throw new WorkflowError('INVALID_PROJECT_GRANT', 'Give each identity one repository role.', 422);
  grants.sort((a, b) => (a.kind + ':' + a.id).localeCompare(b.kind + ':' + b.id));
  project.access = {version: current.version + 1, grants, updatedAt: now, updatedBy: actor.id};
  return project.access;
}

/** Filter before pagination and metrics. Workspace-wide events are owner-only. */
export function repositoryWorkspace(workspace, actor, policy) {
  if (actor.kind === 'owner' || actor.kind === 'system') return workspace;
  const projects = Object.fromEntries(Object.entries(workspace.projects ?? {})
    .filter(([,project]) => hasRepositoryPermission(project, actor, policy, 'read'))
    .map(([id, project]) => [id, {...project, access: undefined}]));
  const ids = new Set(Object.keys(projects)), tasks = workspace.tasks.filter(task => ids.has(task.projectId));
  const taskIds = new Set(tasks.map(task => task.id)), runs = workspace.runs.filter(run => taskIds.has(run.taskId));
  const runIds = new Set(runs.map(run => run.id));
  return {...workspace, projects, tasks, runs, reviewerNames: undefined,
    events: workspace.events.filter(event => event.projectId ? ids.has(event.projectId)
      : event.taskId ? taskIds.has(event.taskId) : event.runId ? runIds.has(event.runId) : false),
    accessScope: 'accessible-repositories'};
}
