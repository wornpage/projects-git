import {$} from './dom.js';
import {candidateAgentInstructions} from '../agent-instructions.js';

// Owns only the selected preview and copy request; agent execution stays external.
export function createContinuationDialog({getContext, api, dialogs, showError}) {
  let continuationContext = null;
  dialogs.register('continuation-dialog');

  function selectionScope() {
    const {workspace, view, selectedTask, selectedRun} = getContext();
    return JSON.stringify([workspace.id, view, selectedTask, selectedRun]);
  }
  function instructions(snapshot, runId) {
    return candidateAgentInstructions({workspace: snapshot, runId, origin: location.origin, cli: snapshot.repositoryWorkflow?.cli});
  }
  async function openContinuation(runId) {
    const scope = selectionScope(), opener = document.activeElement;
    try {
      const fresh = await api('/api/workspace');
      const {workspace} = getContext();
      if (scope !== selectionScope() || fresh.id !== workspace.id) return;
      const snapshot = fresh.version >= workspace.version ? fresh : workspace;
      const text = instructions(snapshot, runId);
      continuationContext = {workspaceId: snapshot.id, version: snapshot.version, runId, text, snapshot};
      $('#copy-continuation').disabled = false;
      $('#continuation-text').value = text;
      $('#continuation-notice').textContent = 'Selected candidate · ' + runId.slice(0, 10) + '. Source text is quoted; refresh current state in your agent before acting.';
      dialogs.show('continuation-dialog', '#copy-continuation', opener);
    } catch (error) { showError(error.message); }
  }
  function currentContinuationText() {
    const {workspace} = getContext();
    if (!continuationContext || continuationContext.workspaceId !== workspace.id) throw new Error('The workspace changed. Reopen the candidate context.');
    const snapshot = workspace.version >= continuationContext.version ? workspace : continuationContext.snapshot;
    const text = instructions(snapshot, continuationContext.runId);
    if (text !== continuationContext.text) throw new Error('The candidate context changed. Close and reopen it before copying.');
    return text;
  }
  const stillOpen = captured => $('#continuation-dialog').open && continuationContext === captured;
  $('#close-continuation').addEventListener('click', () => $('#continuation-dialog').close());
  $('#continuation-dialog').addEventListener('close', () => {
    continuationContext = null;
    $('#continuation-text').value = '';
    $('#copy-continuation').disabled = false;
  });
  $('#copy-continuation').addEventListener('click', async () => {
    const captured = continuationContext;
    if (!captured || $('#copy-continuation').disabled) return;
    $('#copy-continuation').disabled = true;
    try {
      const fresh = await api('/api/workspace');
      if (!stillOpen(captured)) return;
      if (fresh.id !== captured.workspaceId) throw new Error('The workspace changed. Reopen the candidate context.');
      if (instructions(fresh, captured.runId) !== captured.text) throw new Error('The candidate context changed. Close and reopen it before copying.');
      const text = currentContinuationText();
      try { await navigator.clipboard.writeText(text); }
      catch {
        if (!stillOpen(captured)) return;
        currentContinuationText();
        $('#continuation-text').focus();
        $('#continuation-text').select();
        $('#continuation-notice').textContent = 'Clipboard unavailable. Copy the selected context manually.';
        return;
      }
      if (!stillOpen(captured)) return;
      currentContinuationText();
      $('#continuation-notice').textContent = 'Candidate instructions copied. Continue the discussion in your existing coding conversation.';
    } catch (error) {
      if (stillOpen(captured)) $('#continuation-notice').textContent = error.message;
    } finally {
      if (continuationContext === captured) $('#copy-continuation').disabled = false;
    }
  });
  return {openContinuation};
}
