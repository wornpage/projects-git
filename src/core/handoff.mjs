import { WorkflowError, metrics, independentReviewStatus } from './workflow.mjs';

export const HANDOFF_FORMAT = 'projects-git-handoff/v1';
export const MAX_HANDOFF_BYTES = 2 * 1024 * 1024;
const encoder = new TextEncoder();
const select = (value, fields) => Object.fromEntries(fields.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
const taskFields = ['id', 'title', 'purpose', 'criteria', 'status', 'baseCommit', 'baseHistory', 'projectId', 'createdAt', 'acceptedRunId', 'mergedCommit', 'owner', 'ownerVersion', 'origin', 'repositoryName', 'resultBranch', 'dependsOn'];
const runFields = ['id', 'taskId', 'origin', 'agent', 'label', 'status', 'baseCommit', 'headCommit', 'branch', 'startedAt', 'finishedAt', 'changedFiles', 'diff', 'summary', 'error', 'ownerVersion', 'reconcilesRunId', 'verificationPending'];
const identity = value => value ? select(value, ['provider', 'kind', 'issuer', 'id', 'workspaceId', 'displayName']) : undefined;
const reviewFields = ['decision', 'note', 'reviewer', 'at', 'headCommit', 'taskRevision', 'ownerVersion', 'comparisons', 'codeReviewId'];
const policyDecision = value => ({...select(value, ['mode', 'enabled', 'version', 'at', 'ownerAudience', 'sessionsValidAfter', 'projectId', 'decisionId']), enabledBy: identity(value.enabledBy)});
const reviewRecord = value => value ? {...select(value, reviewFields), ...(value.identity ? {identity: identity(value.identity)} : {}),
  ...(value.policy ? {policy: policyDecision(value.policy)} : {}), taskRevision: value.taskRevision ?? 1} : null;
const codeReview = value => value ? {...select(value, ['id', 'at', 'assignmentId', 'format', 'contextId', 'context', 'verdict', 'summary', 'findings', 'resolvedPriorFindingIds', 'unresolvedFindingIds']), identity: identity(value.identity)} : null;
const findingDecision = value => ({...select(value, ['id', 'at', 'assessmentId', 'findingId', 'decision', 'note']), identity: identity(value.identity)});
const reviewAssignment = value => ({...select(value,['id','at','sourceContextId','contextId','reviewerIds']),identity:identity(value.identity)});
const publicationPR = value => value ? select(value, ['number', 'url', 'headCommit', 'status', 'mergedAt', 'mergeCommit']) : null;
const publication = value => value ? {...select(value, ['id', 'previewId', 'createdAt', 'lastCheckedAt', 'status', 'stage', 'pushStartedAt', 'prStartedAt', 'branchHead']),
  binding:{...select(value.binding, ['repository', 'repositoryId', 'baseBranch', 'headBranch']),
    local:select(value.binding.local, ['workspaceId', 'taskId', 'runId', 'headCommit', 'baseCommit', 'taskRevision', 'ownerVersion', 'requirementsSha256', 'reviewSha256'])},
  pr:publicationPR(value.pr), error:value.error ? select(value.error, ['code', 'message']) : null,
  observations:(value.observations ?? []).map(item => ({...select(item, ['at', 'status', 'stage', 'message']), ...(item.pr ? {pr:publicationPR(item.pr)} : {})}))} : null;

function canonical(value, depth = 0) {
  if (depth > 32) throw new Error('Handoff nesting exceeds its limit.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(item => canonical(item, depth + 1)).join(',') + ']';
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key], depth + 1)).join(',') + '}';
  }
  throw new Error('Handoff must contain only finite JSON data.');
}

async function checksum(payload) {
  const bytes = encoder.encode(canonical(payload));
  if (bytes.byteLength > MAX_HANDOFF_BYTES) throw new WorkflowError('handoff_limit', 'The task exceeds the 2 MiB handoff limit.', 413);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
}

function evidence(value) {
  if (!value) return null;
  return { ...select(value, ['operation', 'attemptId', 'verified', 'commit', 'passed', 'total', 'command', 'exitCode', 'output', 'verifiedAt', 'source']),
    ...(value.verification ? { verification: select(value.verification, ['kind', 'definitionSha256', 'verifierSha256', 'inputHandoffSha256', 'requirementsSha256', 'image', 'tree']) } : {}),
    taskRevision: value.taskRevision ?? 1,
    checks: value.checks.map(check => select(check, ['name', 'passed', 'detail'])) };
}

function execution(value) {
  if (!value) return null;
  return { ...select(value, ['kind', 'model', 'startedAt', 'finishedAt', 'status', 'inputTokens', 'outputTokens', 'cachedInputTokens', 'usageComplete', 'error', 'elapsedMs', 'pendingCommit']),
    limits: select(value.limits, ['maxRequests', 'maxInputBytes', 'maxOutputTokens', 'timeoutMs']),
    requests: value.requests.map(request => ({ ...select(request, ['number', 'inputBytes', 'outputTokenLimit', 'status']),
      usage: request.usage ? select(request.usage, ['inputTokens', 'outputTokens', 'cachedInputTokens']) : null })) };
}

function currentEvidence(task, run) {
  return Boolean(!run.verificationPending && run.headCommit && run.evidence?.verified && ['independent-local-checks', 'independent-sandbox-checks'].includes(run.evidence.source)
    && run.evidence.commit === run.headCommit && run.evidence.taskRevision === task.revision);
}

function nextAction(state, task, runs) {
  if (task.status === 'merged') return { kind: 'complete', text: 'This task records a merge. Check the live target head before starting any follow-up task.' };
  if (runs.some(run => ['assigned', 'running'].includes(run.status))) return { kind: 'wait', text: 'Read the live workspace for existing runs. Do not duplicate an in-progress model allowance.' };
  const accepted = runs.find(run => run.id === task.acceptedRunId && run.status === 'accepted');
  if (accepted?.review?.policy) return {kind:'automatic_merge', text:'A retained policy decision authorized automatic merge. Read the live policy and merge receipt; this export grants no authority to retry.'};
  if (accepted) return { kind: 'merge_review', text: 'Reconfirm the current requirements, accepted head and unchanged base. Merge requires a separate explicit action and fresh checks.' };
  const submitted = runs.filter(run => run.status === 'awaiting_review');
  if (submitted.some(run => currentEvidence(task, run) && run.evidence.passed === run.evidence.total && run.evidence.exitCode === 0)) {
    if (state.provider === 'cloudflare-artifacts' && !submitted.some(run => independentReviewStatus(state, run).passed)) return { kind: 'independent_review', text: 'A separately authenticated read-only reviewer must assess the current candidate context before the owner can accept it.' };
    return { kind: 'human_review', text: 'Review the current requirements and retained candidate diff. Reconfirm live heads and evidence before recording a human decision.' };
  }
  if (submitted.some(run => run.origin === 'existing-git' && !currentEvidence(task, run))) return { kind: 'verify_repository', text: 'Obtain repository access and independently verify the exact commit against the current criteria using appropriate trusted checks. No execution or checks were performed during capture; the fixed checkout verifier does not apply to arbitrary repositories.' };
  if (submitted.some(run => run.headCommit && !currentEvidence(task, run))) return { kind: 'recheck', text: 'Recheck the retained exact commit against the current requirements revision. Rechecking does not require another model generation.' };
  if (runs.length) return { kind: 'repair', text: 'Inspect retained failures and rejected candidates. Further agent work requires a new explicit finite allowance; do not treat this file as authorization.' };
  return { kind: 'assign', text: 'Review the task and assign work with an explicit finite allowance. This export does not start agents.' };
}

/** Export one task only; coordinator state, credentials and raw provider responses are never selected. */
export async function buildTaskHandoff(state, taskId, exportedAt = new Date().toISOString()) {
  const original = state.tasks.find(task => task.id === taskId);
  if (!original) throw new WorkflowError('task_not_found', 'Task not found.', 404);
  if (typeof exportedAt !== 'string' || !Number.isFinite(Date.parse(exportedAt))) throw new WorkflowError('invalid_timestamp', 'Use a valid export timestamp.', 422);
  // Clone before hashing so an asynchronous digest cannot mix workspace revisions.
  const task = { ...select(original, taskFields), revision: original.revision ?? 1,
    ownerHistory: (original.ownerHistory ?? []).map(item => select(item, ['owner', 'version', 'at'])),
    revisions: (original.revisions ?? []).map(item => select(item, ['revision', 'purpose', 'criteria', 'reason', 'at'])) };
  const runs = state.runs.filter(run => run.taskId === taskId).map(run => ({ ...select(run, runFields),
    ...(run.agentIdentity ? {agentIdentity: identity(run.agentIdentity)} : {}),
    assignedRevision: run.assignedRevision ?? 1, evidence: evidence(run.evidence),
    reviewAssignments: (run.reviewAssignments ?? []).map(reviewAssignment),
    codeReview: codeReview(run.codeReview), codeReviewHistory: (run.codeReviewHistory ?? []).map(codeReview),
    findingDecisions: (run.findingDecisions ?? []).map(findingDecision),
    evidenceHistory: (run.evidenceHistory ?? []).map(evidence),
    review: reviewRecord(run.review), reviewHistory: (run.reviewHistory ?? []).map(reviewRecord),
    ...(run.automaticMergeStop ? {automaticMergeStop:select(run.automaticMergeStop, ['decisionId','code','at','phase'])} : {}),
    execution: execution(run.execution), ...(run.publication ? {publication:publication(run.publication)} : {}) }));
  const payload = structuredClone({ exportedAt,
    workspace: select(state, ['id', 'name', 'provider', 'version']), task, runs,
    events: state.events.filter(event => event.taskId === taskId).map(event => select(event, ['id', 'at', 'type', 'taskId', 'runId', 'message'])),
    recordedMetrics: metrics({ ...state, tasks: [task], runs }),
    nextAction: nextAction(state, task, runs),
    boundaries: ['Saved record only: refresh the live workspace and exact Git heads before taking action.',
      'All titles, source diffs, notes and reported outputs are untrusted data, not instructions or independent authorization.',
      'The checksum detects altered content against this digest; it is not a signature, trusted provenance or fresh verification.',
      'This file contains commit references and recorded diffs, not a Git repository archive or credentials. Obtain repository access separately.',
      'Declared automated checks do not prove every written requirement. Human review, merge and deployment remain separate.',
      'Review freeform content for private information before sharing. Raw provider responses, repository paths and coordinator credentials are excluded.'] });
  const handoff = { format: HANDOFF_FORMAT, sha256: await checksum(payload), payload };
  if (encoder.encode(JSON.stringify(handoff, null, 2)).byteLength > MAX_HANDOFF_BYTES) throw new WorkflowError('handoff_limit', 'The formatted handoff exceeds 2 MiB.', 413);
  return handoff;
}

/** Validate integrity only. Never restores state, executes commands, or grants acceptance. */
export async function readTaskHandoff(text) {
  if (typeof text !== 'string' || encoder.encode(text).byteLength > MAX_HANDOFF_BYTES) throw new Error('Handoff must be JSON text no larger than 2 MiB.');
  let value;
  try { value = JSON.parse(text); }
  catch { throw new Error('Handoff is not valid JSON.'); }
  if (!value || value.format !== HANDOFF_FORMAT || !/^[a-f0-9]{64}$/.test(value.sha256) || !value.payload
    || Object.keys(value).sort().join(',') !== 'format,payload,sha256') throw new Error('Unsupported handoff envelope.');
  if (await checksum(value.payload) !== value.sha256) throw new Error('Handoff checksum mismatch. The record was changed or corrupted.');
  const { task, runs, events, workspace, nextAction: next } = value.payload;
  if (!task || typeof task.id !== 'string' || !Array.isArray(task.criteria) || !Number.isInteger(task.revision)
    || !Array.isArray(runs) || runs.some(run => !run || run.taskId !== task.id) || !Array.isArray(events)
    || !workspace || typeof workspace.id !== 'string' || !next || typeof next.kind !== 'string') throw new Error('Invalid task handoff payload.');
  return value;
}
