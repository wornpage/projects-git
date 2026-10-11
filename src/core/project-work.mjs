import { createTask, WorkflowError } from './workflow.mjs';
import { dependencyState } from '../../public/task-dependencies.js';

export const MAX_QUEUED_BATCH = 8;
export function taskBriefs(input) {
  if (!Array.isArray(input.tasks) || !input.tasks.length || input.tasks.length > MAX_QUEUED_BATCH) {
    throw new WorkflowError('invalid_task_stack', `Queue 1 to ${MAX_QUEUED_BATCH} task briefs together.`, 422);
  }
  return input.tasks.map(brief => {
    if (!brief || typeof brief !== 'object' || Array.isArray(brief)) throw new WorkflowError('invalid_task_brief', 'Every task needs a brief.', 422);
    const { title, purpose, criteria, owner, dependsOn = [] } = brief;
    if (!Array.isArray(dependsOn) || dependsOn.length > 16 || new Set(dependsOn).size !== dependsOn.length
      || dependsOn.some(id => typeof id !== 'string' || !/^(?:[a-f0-9-]{36}|draft:[1-8])$/.test(id))) {
      throw new WorkflowError('invalid_dependencies', 'Use at most16 unique prerequisite task UUIDs or draft:1 through draft:8 references.', 422);
    }
    // Empty prerequisites preserve the canonical shape of already-saved request
    // fingerprints. New prerequisite edges extend that shape explicitly.
    return { title, purpose, criteria, owner, ...(dependsOn.length ? { dependsOn } : {}) };
  });
}

export function projectName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 100) throw new WorkflowError('invalid_project_name', 'Give the project a name of 1 to 100 characters.', 422);
  return value.trim();
}

// Queued tasks have requirements, but no checkout or running agent. The first
// assignment binds the current project baseline, then that task's base is fixed.
export function queueProjectTasks(state, project, briefs, firstId) {
  briefs = taskBriefs({ tasks: briefs });
  const staged = structuredClone(state);
  const ids = briefs.map((_, index) => index === 0 && firstId ? firstId : crypto.randomUUID());
  const tasks = briefs.map((brief, index) => {
    const references = (brief.dependsOn ?? []).map(id => id.startsWith('draft:') ? ids[Number(id.slice(6)) - 1] : id);
    if (references.some(id => !id || id === ids[index]) || new Set(references).size !== references.length) {
      throw new WorkflowError('invalid_dependencies', 'A task cannot depend on itself, repeat a prerequisite, or name an absent draft.', 422);
    }
    const task = createTask(staged, { ...brief, id: ids[index], baseCommit: project.mainCommit, repositoryKey: project.id });
    task.origin = project.kind === 'artifacts' ? 'artifacts' : 'connected-git'; task.projectId = project.id;
    task.dependsOn = references;
    task.repositoryName = project.repositoryName; task.resultBranch = project.defaultBranch ?? 'main';
    return task;
  });
  const visited = new Set(), path = new Set();
  function visit(task) {
    if (path.has(task.id)) throw new WorkflowError('dependency_cycle', 'Task prerequisites contain a cycle.', 422);
    if (visited.has(task.id)) return;
    const dependencies = dependencyState(staged, task);
    if (dependencies.invalid) throw new WorkflowError('invalid_dependencies', dependencies.invalid, 422);
    path.add(task.id);
    for (const id of task.dependsOn ?? []) visit(staged.tasks.find(item => item.id === id));
    path.delete(task.id); visited.add(task.id);
  }
  for (const task of tasks) visit(task);
  // Publish only after the entire batch and its graph have been validated.
  state.tasks = staged.tasks; state.events = staged.events; state.version = staged.version;
  return tasks;
}

export function queuedTasks(state, projectId) {
  return state.tasks.filter(task => task.projectId === projectId && !task.acceptedRunId && !task.mergedCommit
    && state.runs.filter(run => run.taskId === task.id).every(run => run.status === 'failed' && run.checkoutState === 'failed'));
}

export function eligibleQueuedTasks(state, projectId) {
  return queuedTasks(state, projectId).filter(task => dependencyState(state, task).ready);
}

export function queueIdle(state, projectId) {
  const waiting = queuedTasks(state, projectId);
  return { idle: true, reason: waiting.length
    ? `${waiting.length} queued task${waiting.length === 1 ? '' : 's'} waiting for prerequisite integration. Other eligible work can be claimed.`
    : 'No unassigned tasks in this project.', waitingTaskIds: waiting.map(task => task.id) };
}

export function bindQueuedBase(state, task, reservedRunId) {
  if (state.runs.some(run => run.taskId === task.id && run.id !== reservedRunId && run.checkoutState !== 'failed')) return;
  const mainCommit = state.projects[task.projectId].mainCommit;
  if (task.baseCommit === mainCommit) return;
  const oldBase = task.baseCommit;
  task.baseCommit = mainCommit;
  state.version++;
  state.events.push({ id: crypto.randomUUID(), at: new Date().toISOString(), type: 'task.base_bound', taskId: task.id, runId: null,
    message: `Queued task bound to current project main ${mainCommit}; queued baseline was ${oldBase}. No previous candidate or report existed.` });
}

export function requireProjectAdmission(state, projectId) {
  const project = state.projects?.[projectId];
  if (!project) throw new WorkflowError('project_not_found', 'Project not found.', 404);
  if (project.codeConnected === false) throw new WorkflowError('project_code_unavailable', 'Restore project code before admitting agent work.', 503);
  if (!project.acceptingWork) throw new WorkflowError('project_paused', 'New agent work is paused for this project. Existing submissions can still finish.');
  return project;
}

export function setProjectPolicy(state, projectId, input) {
  const project = state.projects?.[projectId];
  if (!project) throw new WorkflowError('project_not_found', 'Project not found.', 404);
  if (typeof input.acceptingWork !== 'boolean' || input.expectedVersion !== project.policyVersion) throw new WorkflowError('stale_project_policy', 'Read the current project policy before changing it.');
  if (input.acceptingWork && project.codeConnected === false) throw new WorkflowError('project_code_unavailable', 'Restore project code before admitting agent work.', 503);
  project.acceptingWork = input.acceptingWork; project.policyVersion++;
  state.version++;
  state.events.push({ id: crypto.randomUUID(), at: new Date().toISOString(), type: 'project.policy_changed', projectId, taskId: null, runId: null,
    message: project.name + ': new agent work ' + (input.acceptingWork ? 'enabled' : 'paused') + '. Existing work is retained.' });
  return project;
}

export function setAutomaticMergePolicy(state, projectId, input, identity) {
  const project = state.projects?.[projectId], owner = state.authentication;
  if (!project) throw new WorkflowError('project_not_found', 'Project not found.', 404);
  if (state.provider !== 'cloudflare-artifacts' || !owner || identity?.kind !== 'owner'
    || identity.provider !== owner.provider || identity.id !== owner.subject || identity.issuer !== owner.issuer || identity.workspaceId !== state.id) {
    throw new WorkflowError('owner_required', 'Only the authenticated workspace owner can change automatic merge policy.', 403);
  }
  if (!input || Object.keys(input).sort().join(',') !== 'enabled,expectedVersion' || typeof input.enabled !== 'boolean'
    || input.expectedVersion !== (project.automaticMergePolicy?.version ?? 0)) {
    throw new WorkflowError('stale_automatic_merge_policy', 'Send the switch value and current automatic merge policy version.', 409);
  }
  if (input.enabled && project.codeConnected === false) throw new WorkflowError('project_code_unavailable', 'Restore project code before enabling automatic merges.', 503);
  project.automaticMergePolicy = { mode: 'checks-and-independent-review', enabled: input.enabled,
    version: (project.automaticMergePolicy?.version ?? 0) + 1, at: new Date().toISOString(),
    enabledBy: Object.fromEntries(['provider', 'kind', 'issuer', 'id', 'workspaceId', 'displayName'].map(key => [key, identity[key]])),
    ownerAudience: owner.audience, sessionsValidAfter: state.sessionsValidAfter ?? 0 };
  state.version++;
  state.events.push({ id: crypto.randomUUID(), at: project.automaticMergePolicy.at, type: 'project.automatic_merge_policy_changed', projectId, taskId: null, runId: null,
    message: `${project.name}: owner ${input.enabled ? 'enabled' : 'disabled'} automatic approval and merge (policy v${project.automaticMergePolicy.version}). Current checks, independent review and an unambiguous candidate are required.` });
  return project;
}
