import { WorkflowError } from './workflow.mjs';

const provenanceFields = ['definitionSha256', 'verifierSha256', 'image', 'tree', 'requirementsSha256'];

function requireAttemptId(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) {
    throw new WorkflowError('invalid_merge_attempt', 'Merge evidence needs a bounded server-generated attempt ID.', 500);
  }
  return value;
}

/** Add server-owned merge provenance without modifying the verifier report. */
export function mergeEvidence(evidence, attemptId) {
  return { ...structuredClone(evidence), operation: 'merge', attemptId: requireAttemptId(attemptId) };
}

/** A fresh report must describe the same reviewed source, policy and runtime. */
export function mergeEvidenceChanged(accepted, fresh, verificationProfile = 'checkout') {
  if (!accepted || accepted.commit !== fresh.commit || (accepted.taskRevision ?? 1) !== (fresh.taskRevision ?? 1)) return true;
  if (verificationProfile !== 'commands') return false;
  return provenanceFields.some(field => !accepted.verification || !fresh.verification
    || accepted.verification[field] !== fresh.verification[field]);
}

function sameReport(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Retain one immutable report per merge attempt. Successful attempts leave the
 * evidence and human decision that authorized the merge untouched. Failed or
 * stale attempts become the current evidence and require another review.
 */
export function retainMergeEvidence(state, runId, fresh, { requiresReview = false } = {}) {
  if (fresh?.operation !== 'merge') throw new WorkflowError('invalid_merge_evidence', 'Merge evidence must identify its operation.', 500);
  const attemptId = requireAttemptId(fresh.attemptId);
  const run = state.runs.find(item => item.id === runId);
  if (!run) throw new WorkflowError('run_not_found', 'Agent run not found.', 404);
  const task = state.tasks.find(item => item.id === run.taskId);
  if (!task) throw new WorkflowError('task_not_found', 'Task not found.', 404);
  run.evidenceHistory ??= [];
  const priorAttempt = run.evidenceHistory.find(item => item.operation === 'merge' && item.attemptId === attemptId);
  if (priorAttempt) {
    if (!sameReport(priorAttempt, fresh)) throw new WorkflowError('merge_attempt_conflict', 'A merge attempt ID already names a different retained report.', 409);
    return false;
  }
  if (requiresReview && run.evidence && !run.evidenceHistory.some(item => sameReport(item, run.evidence))) {
    run.evidenceHistory.push(structuredClone(run.evidence));
  }
  run.evidenceHistory.push(structuredClone(fresh));
  if (requiresReview) {
    run.evidence = structuredClone(fresh);
    if (run.review) {
      run.reviewHistory ??= [];
      run.reviewHistory.push(run.review);
      run.review = null;
    }
    run.status = 'awaiting_review';
    task.acceptedRunId = null;
    task.status = 'review';
  }
  state.version++;
  state.events.push({ id: crypto.randomUUID(), at: new Date().toISOString(), type: 'run.merge-verified', taskId: task.id, runId,
    message: `${run.label}: retained fresh merge checks for attempt ${attemptId}.` });
  return true;
}

export function localMergeStateByRun(intents, activeRunIds = new Set()) {
  const active = activeRunIds instanceof Set ? activeRunIds : new Set(activeRunIds);
  return Object.fromEntries(Object.keys(intents ?? {}).map(runId => [runId, active.has(runId) ? 'running' : 'recovery-required']));
}

export function hostedMergeStateByRun(operations, now = Date.now()) {
  const states = {};
  for (const operation of Object.values(operations ?? {})) {
    if (operation?.kind !== 'merge' || operation.state !== 'pending' || typeof operation.itemId !== 'string') continue;
    states[operation.itemId] = (operation.leaseUntil ?? 0) > now ? 'running' : 'recovery-required';
  }
  return states;
}
