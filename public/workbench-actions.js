export async function sha256Text(text) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

// Action progress is distinct from verification and human acceptance. Pending
// operation IDs are retained for an explicit retry, never replayed automatically.
export function createWorkbenchActions({getContext, captureSession, applySnapshot, getPath, refresh, api,
  actionFeedback, operationRequests, saveSession, render, clearError, showError, announce,
  captureActionFocus, restoreActionFocus, hash = sha256Text}) {
  let active = null;
  function reset() { active = null; actionFeedback.clear(); }
  function actionKey(kind, task, run) {
    return JSON.stringify([getContext().workspace.id, kind, task.id, task.revision ?? 1, run?.id ?? null, run?.headCommit ?? null]);
  }
  async function mutate(action, success, feedback) {
    if (active) return null;
    const operation = {}, isCurrent = captureSession(), focus = captureActionFocus();
    const location = ({view, selectedTask, selectedRun}) => JSON.stringify([view, selectedTask, selectedRun]);
    const origin = location(getContext()), originPath = getPath();
    let restoreFocus = true;
    active = operation;
    if (feedback) actionFeedback.set(feedback.key, {phase:'pending', message:feedback.pending});
    clearError(); render(true);
    try {
      const result = await action();
      if (!isCurrent() || active !== operation) return null;
      let refreshPage = false;
      if (Array.isArray(result?.tasks)) {
        if (result.id !== getContext().workspace?.id) {
          const error = new Error('The action returned a different workspace. Refresh status to confirm the outcome.');
          error.uncertain = true;
          throw error;
        }
        // Mutation replies can contain only their own project. A newer version
        // does not make that projection belong to a page opened while waiting.
        if (location(getContext()) === origin && getPath() === originPath) applySnapshot(result);
        else refreshPage = true;
      }
      if (feedback) actionFeedback.set(feedback.key, {phase:'recorded', message:success});
      announce(success);
      if (refreshPage) {
        try { await refresh(true); }
        catch (error) { if (isCurrent()) showError('The change was recorded, but the current page could not refresh. ' + error.message); }
        if (!isCurrent() || active !== operation) return null;
      }
      return result;
    } catch (error) {
      if (!isCurrent() || active !== operation) return null;
      if (feedback) actionFeedback.set(feedback.key, {phase:'error', message:error.message, uncertain:Boolean(error.uncertain)});
      if(error.auth)restoreFocus=false;
      showError(error.message + (error.uncertain ? ' The outcome is not confirmed. Refresh status before trying again.' : ''), error.auth ? null : focus);
      return null;
    } finally {
      if (active === operation) {
        active = null; render(true);
        if (restoreFocus && isCurrent() && location(getContext()) === origin) restoreActionFocus(focus);
      }
    }
  }
  async function runOperation(path, body) {
    const isCurrent = captureSession(), submitted = structuredClone(body);
    const fingerprint = await hash(JSON.stringify(submitted));
    if (!isCurrent()) throw new Error('The workspace changed before this operation could be sent. Review the current workspace.');
    if (operationRequests.get(path)?.fingerprint !== fingerprint)
      operationRequests.set(path, {fingerprint, requestId:crypto.randomUUID()});
    const request = operationRequests.get(path);
    saveSession();
    function clearRequest() {
      if (isCurrent() && operationRequests.get(path) === request) { operationRequests.delete(path); saveSession(); }
    }
    try {
      const result = await api(path, submitted, request.requestId);
      clearRequest(); return result;
    } catch (error) {
      if (error.status && error.status < 500 && !['OPERATION_IN_PROGRESS','TASK_OPERATION_PENDING','STATE_CONFLICT'].includes(error.code)) clearRequest();
      throw error;
    }
  }
  return {mutate, runOperation, actionKey, reset, get busy() { return active !== null; }};
}
