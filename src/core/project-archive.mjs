import {buildTaskHandoff, readTaskHandoff} from './handoff.mjs';
import {WorkflowError} from './workflow.mjs';
import {digest} from './check-definition.mjs';

export const PROJECT_ARCHIVE_FORMAT = 'projects-git-project/v1';
export const MAX_PROJECT_ARCHIVE_BYTES = 1024 * 1024;
const encoder = new TextEncoder();
const commit = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const refuse = message => { throw new WorkflowError('invalid_project_archive', message, 422); };
const fields = (value, names) => record(value) && Object.keys(value).sort().join(',') === [...names].sort().join(',');
function canonical(value, depth = 0) {
  if (depth > 40) refuse('Project archive nesting exceeds its limit.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(item => canonical(item, depth + 1)).join(',') + ']';
  if (record(value) && Object.getPrototypeOf(value) === Object.prototype)
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key], depth + 1)).join(',') + '}';
  refuse('Project archives contain finite JSON data only.');
}
async function checksum(payload) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(canonical(payload))))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export function archiveCommits(handoffs, mainCommit) {
  if (!Array.isArray(handoffs) || !commit(mainCommit)) refuse('Invalid retained handoffs or project main commit.');
  const commits = new Set([mainCommit]);
  const add = value => { if (value != null) { if (!commit(value)) refuse('A retained Git commit is invalid.'); commits.add(value); } };
  const reference = (value, field) => {
    if (!record(value) || !commit(value[field])) refuse('Invalid retained ' + field + ' record.');
    add(value[field]);
  };
  const history = (value, field) => {
    if (value == null) return;
    if (!Array.isArray(value)) refuse('Retained ' + field + ' history must be an array.');
    for (const item of value) reference(item, field);
  };
  for (const item of handoffs) {
    const payload = item?.payload;
    if (!record(payload) || !record(payload.task) || !Array.isArray(payload.runs)) refuse('Invalid retained task or runs.');
    const task = payload.task;
    reference(task, 'baseCommit'); add(task.mergedCommit);
    history(task.baseHistory, 'baseCommit');
    for (const run of payload.runs) {
      reference(run, 'baseCommit'); add(run.headCommit);
      if (run.review != null) reference(run.review, 'headCommit');
      if (run.evidence != null) reference(run.evidence, 'commit');
      history(run.reviewHistory, 'headCommit'); history(run.evidenceHistory, 'commit');
    }
  }
  if (commits.size > 128) refuse('Project archives support at most 128 referenced commits; nothing was truncated.');
  return [...commits].sort();
}

export async function buildProjectArchive(workspace, projectId, exportedAt = new Date().toISOString(), policies = {}) {
  const state = structuredClone(workspace), project = state.projects?.[projectId];
  if (!project) throw new WorkflowError('project_not_found', 'Project not found.', 404);
  if (!commit(project.mainCommit) || typeof project.defaultBranch !== 'string' || !project.defaultBranch) refuse('The project needs a recorded default branch and exact main commit.');
  if (project.acceptingWork) throw new WorkflowError('project_not_paused', 'Pause new agent work before exporting this project.', 409);
  const tasks = state.tasks.filter(task => task.projectId === projectId);
  const ids = new Set(tasks.map(task => task.id));
  if (state.runs.some(run => ids.has(run.taskId) && (['assigned', 'running'].includes(run.status) || run.verificationPending
    || run.execution?.pendingCommit && run.execution.pendingCommit !== run.headCommit)))
    throw new WorkflowError('project_busy', 'Reconcile active assignments, checks and uncertain Git commits before exporting.', 409);
  const history = structuredClone(project.restoredHistory ?? []);
  const checkPolicies = structuredClone(project.restoredCheckPolicies ?? []);
  for (const run of state.runs.filter(run => ids.has(run.taskId))) {
    const policy = policies[run.id];
    if (policy) checkPolicies.push({workspaceId: state.id, runId: run.id, definition: policy.definition,
      definitionSha256: policy.definitionSha256, ...(policy.image ? {image: policy.image} : {})});
  }
  const current = await Promise.all(tasks.map(task => buildTaskHandoff(state, task.id, exportedAt)));
  const handoffs = [...history, ...current];
  if (handoffs.length > 64) refuse('Project archives support at most 64 retained task records; nothing was truncated.');
  const payload = {
    exportedAt, workspace: {id: state.id, name: state.name, version: state.version},
    project: {id: project.id, name: project.name, defaultBranch: project.defaultBranch, mainCommit: project.mainCommit},
    current, history, checkPolicies, commits: archiveCommits(handoffs, project.mainCommit),
    boundary: 'Historical records only. Checksums establish integrity, not authenticated provenance or current authorization. Restoring never resumes work or grants approval.'
  };
  const archive = {format: PROJECT_ARCHIVE_FORMAT, sha256: await checksum(payload), payload};
  return readProjectArchive(JSON.stringify(archive), archive.sha256);
}

export async function readProjectArchive(text, expectedSha256) {
  if (typeof text !== 'string' || encoder.encode(text).byteLength > MAX_PROJECT_ARCHIVE_BYTES)
    refuse('Project archive must be JSON no larger than 1 MiB.');
  let archive;
  try { archive = JSON.parse(text); } catch { refuse('Project archive is not valid JSON.'); }
  if (!fields(archive, ['format', 'sha256', 'payload']) || archive.format !== PROJECT_ARCHIVE_FORMAT
    || typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedSha256) || archive.sha256 !== expectedSha256
    || await checksum(archive.payload) !== expectedSha256) refuse('Project archive checksum differs from the expected digest.');
  const p = archive.payload;
  if (!fields(p, ['exportedAt', 'workspace', 'project', 'current', 'history', 'checkPolicies', 'commits', 'boundary'])
    || !fields(p.workspace, ['id', 'name', 'version']) || typeof p.workspace.id !== 'string' || typeof p.workspace.name !== 'string'
    || !Number.isSafeInteger(p.workspace.version) || p.workspace.version < 0
    || !fields(p.project, ['id', 'name', 'defaultBranch', 'mainCommit']) || typeof p.project.id !== 'string'
    || typeof p.project.name !== 'string' || !p.project.name.trim() || p.project.name.length > 120
    || typeof p.project.defaultBranch !== 'string' || !p.project.defaultBranch || p.project.defaultBranch.length > 200
    || !commit(p.project.mainCommit) || typeof p.exportedAt !== 'string' || !Number.isFinite(Date.parse(p.exportedAt))
    || typeof p.boundary !== 'string' || !Array.isArray(p.current) || !Array.isArray(p.history)
    || p.current.length + p.history.length > 64 || !Array.isArray(p.commits)
    || !Array.isArray(p.checkPolicies) || p.checkPolicies.length > 128) refuse('Invalid project archive payload.');
  const ids = new Set(), runIds = new Set();
  // Integrity-checked handoffs are still untrusted input. Validate every record
  // shape this archive traverses before inspecting identities or storing history.
  const commits = archiveCommits([...p.current, ...p.history], p.project.mainCommit);
  for (const item of [...p.current, ...p.history]) {
    try { await readTaskHandoff(JSON.stringify(item)); } catch { refuse('Invalid retained task handoff.'); }
    const key = JSON.stringify([item.payload.workspace.id, item.payload.task.id]);
    if (ids.has(key)) refuse('Duplicate retained task identity.');
    ids.add(key);
    for (const run of item.payload.runs) {
      const runKey = JSON.stringify([item.payload.workspace.id, run.id]);
      if (runIds.has(runKey)) refuse('Duplicate retained candidate identity.');
      runIds.add(runKey);
    }
    if (p.current.includes(item) && (item.payload.workspace.id !== p.workspace.id || item.payload.workspace.version !== p.workspace.version
      || item.payload.task.projectId !== p.project.id)) refuse('A current task belongs to another workspace or project revision.');
  }
  const policyIds = new Set();
  for (const policy of p.checkPolicies) {
    if (!record(policy) || !fields(policy, ['workspaceId', 'runId', 'definition', 'definitionSha256', ...(policy.image === undefined ? [] : ['image'])]))
      refuse('Invalid retained check policy.');
    const key = JSON.stringify([policy.workspaceId, policy.runId]);
    if (!runIds.has(key) || policyIds.has(key) || typeof policy.definition !== 'string'
      || policy.definition.length > 131072 || digest(policy.definition) !== policy.definitionSha256
      || policy.image !== undefined && (typeof policy.image !== 'string' || !/^(?:[^\s]+@)?sha256:[a-f0-9]{64}$/.test(policy.image))) refuse('Invalid retained check policy.');
    policyIds.add(key);
  }
  if (JSON.stringify(commits) !== JSON.stringify(p.commits)) refuse('Referenced Git commits differ from the retained records.');
  return archive;
}
