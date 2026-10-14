import {$} from './dom.js';
import {candidateAgentInstructions} from '../agent-instructions.js';
import {buildGitNote,serializeGitNote} from '../git-notes.js';

function resetPreview(selector,text) {
  const preview=$(selector);
  preview.value=text;
  preview.selectionStart=0;preview.selectionEnd=0;
  preview.scrollTop=0;preview.scrollLeft=0;
}

// Owns only the selected preview and copy request; agent execution stays external.
export function createContinuationDialog({getContext, api, dialogs, showError, downloadJson, captureSession}) {
  let continuationContext = null;
  let opening = 0;
  dialogs.register('continuation-dialog');
  const principal = workspace => JSON.stringify(workspace.authentication?.principal ?? null);

  function selectionScope() {
    const {workspace, view, selectedTask, selectedRun} = getContext();
    return JSON.stringify([workspace.id, principal(workspace), view, selectedTask, selectedRun]);
  }
  function instructions(snapshot, runId) {
    return candidateAgentInstructions({workspace: snapshot, runId, origin: location.origin, cli: snapshot.repositoryWorkflow?.cli});
  }
  async function openContinuation(runId) {
    const request = ++opening, scope = selectionScope(), opener = document.activeElement, isCurrent = captureSession();
    try {
      const fresh = await api('/api/workspace');
      const {workspace} = getContext();
      if (!isCurrent() || request !== opening || scope !== selectionScope() || fresh.id !== workspace.id) return;
      if (principal(fresh) !== principal(workspace)) throw new Error('The workspace identity changed. Refresh before reopening context.');
      const snapshot = fresh.version >= workspace.version ? fresh : workspace;
      const text = instructions(snapshot, runId);
      let note = null, noteError = '';
      try { note = await buildGitNote(snapshot,runId); } catch(error) { noteError = error.message; }
      if (!isCurrent() || request !== opening || scope !== selectionScope()) return;
      continuationContext = {workspaceId: snapshot.id, version: snapshot.version, runId, text, snapshot, scope, isCurrent, principal:principal(snapshot)};
      $('#copy-continuation').disabled = false;
      $('#git-note-details').open = false;
      $('#download-git-note').disabled = !note;
      resetPreview('#git-note-preview',note ? serializeGitNote(note) : '');
      $('#git-note-notice').textContent = noteError;
      $('#continuation-notice').textContent = 'Selected candidate · ' + runId.slice(0, 10) + '. Source text is quoted; refresh current state in your agent before acting.';
      dialogs.show('continuation-dialog', '#copy-continuation', opener);
      resetPreview('#continuation-text',text);
    } catch (error) { if(isCurrent() && request === opening && scope === selectionScope())showError(error.message); }
  }
  function currentContinuationText() {
    const {workspace} = getContext();
    if (!continuationContext || !continuationContext.isCurrent() || continuationContext.workspaceId !== workspace.id || principal(workspace)!==continuationContext.principal) throw new Error('The workspace session changed. Reopen the candidate context.');
    const snapshot = workspace.version >= continuationContext.version ? workspace : continuationContext.snapshot;
    const text = instructions(snapshot, continuationContext.runId);
    if (text !== continuationContext.text) throw new Error('The candidate context changed. Close and reopen it before copying.');
    return text;
  }
  const stillOpen = captured => $('#continuation-dialog').open && continuationContext === captured && captured.isCurrent() && selectionScope() === captured.scope;
  $('#close-continuation').addEventListener('click', () => $('#continuation-dialog').close());
  $('#git-note-details').addEventListener('toggle',()=>{
    if($('#git-note-details').open)resetPreview('#git-note-preview',$('#git-note-preview').value);
  });
  $('#continuation-dialog').addEventListener('close', () => {
    opening++;
    continuationContext = null;
    $('#continuation-text').value = '';
    $('#copy-continuation').disabled = false;
    $('#git-note-preview').value = '';
    $('#download-git-note').disabled = true;
  });
  $('#download-git-note').addEventListener('click',async()=>{
    const captured=continuationContext;
    if(!captured||!stillOpen(captured)||$('#download-git-note').disabled)return;
    $('#download-git-note').disabled=true;
    try{
      const fresh=await api('/api/workspace');
      if(!stillOpen(captured))return;
      if(fresh.id!==captured.workspaceId||principal(fresh)!==captured.principal||instructions(fresh,captured.runId)!==captured.text)
        throw new Error('The candidate context changed. Close and reopen it before downloading.');
      currentContinuationText();
      const note=await buildGitNote(fresh,captured.runId);
      if(!stillOpen(captured))return;
      currentContinuationText();
      resetPreview('#git-note-preview',serializeGitNote(note));
      downloadJson(note,`projects-git-note-${captured.runId}-${note.commit.slice(0,12)}.json`);
      $('#git-note-notice').textContent='Git context downloaded. Keep it private and review the destination before syncing the notes ref.';
    }catch(error){if(stillOpen(captured))$('#git-note-notice').textContent=error.message;}
    finally{if(stillOpen(captured))$('#download-git-note').disabled=false;}
  });
  $('#copy-continuation').addEventListener('click', async () => {
    const captured = continuationContext;
    if (!captured || !stillOpen(captured) || $('#copy-continuation').disabled) return;
    $('#copy-continuation').disabled = true;
    try {
      const fresh = await api('/api/workspace');
      if (!stillOpen(captured)) return;
      if (fresh.id !== captured.workspaceId || principal(fresh)!==captured.principal) throw new Error('The workspace session changed. Reopen the candidate context.');
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
      if (stillOpen(captured)) $('#copy-continuation').disabled = false;
    }
  });
  return {openContinuation};
}
