import {$, el} from './dom.js';
import {requirementChangePreview} from '../workbench-state.js';

// Owns the unsaved requirement proposal and its guarded save lifecycle.
export function createRequirementsForm({getContext, api, dialogs, refresh, announce}) {
  let revisionDraft = null, revisionSaving = false;
  dialogs.register('revision-dialog', () => !revisionSaving);
  function openRevision(task) {
    const {workspace} = getContext();
    revisionDraft = { workspaceId:workspace.id, taskId: task.id, expectedRevision: task.revision ?? 1 };
    $("#revision-purpose").value = task.purpose;
    $("#revision-criteria").value = task.criteria.join("\n");
    $("#revision-reason").value = "";
    $('#revision-status').textContent = '';
    renderRevisionPreview();
    dialogs.show('revision-dialog', '#revision-purpose');
  }
  function revisionProposal() {
    return { purpose:$('#revision-purpose').value.trim(), criteria:$('#revision-criteria').value.split('\n').map(value=>value.trim()).filter(Boolean), reason:$('#revision-reason').value.trim() };
  }
  function renderRevisionPreview() {
    const {workspace, busy} = getContext();
    if (!revisionDraft) return;
    const proposal=revisionProposal(), preview=requirementChangePreview(workspace,revisionDraft,proposal);
    $('#revision-context').textContent=preview.unavailable ? 'This task is no longer available in the current workspace.' : `Saved revision ${preview.revision} → proposed revision ${preview.revision + 1}`;
    $('#revision-stale').hidden=!preview.stale;
    $('#revision-rebase').hidden=preview.unavailable || !preview.stale;
    $('#revision-rebase').disabled=revisionSaving;
    $('#revision-cancel').disabled=revisionSaving;
    for (const id of ['revision-purpose','revision-criteria','revision-reason']) $('#'+id).disabled=revisionSaving;
    const valid=proposal.purpose && proposal.criteria.length > 0 && proposal.criteria.length <= 12 && proposal.criteria.every(value=>value.length <= 500) && proposal.reason;
    $('#revision-save').disabled=revisionSaving || busy || preview.unavailable || preview.merged || preview.stale || !preview.changed || !valid;
    $('#revision-save').textContent=revisionSaving ? 'Saving revision…' : 'Save revision';
    $('#revision-preview').replaceChildren(...[
      el('h3',{},'Review the change'),
      ...preview.fields.map(field=>el('section',{class:'requirement-change'},el('h4',{},field.label),
        el('div',{class:'requirement-change-columns'},
          el('div',{},el('strong',{},'Saved'),el('pre',{},field.before)),
          el('div',{},el('strong',{},'Proposed'),el('pre',{},field.after || 'Not provided'))))),
      !preview.changed ? el('p',{},'No requirement changes yet.') : null].filter(Boolean));
    $('#revision-impact').replaceChildren(...[
      el('h3',{},'Effect on retained work'),
      el('p',{},`${preview.retained} candidate commit(s) stay available. ${preview.reports}/${preview.retained} retained candidates have a check report; ${preview.currentReports}/${preview.retained} have verification at the current head and requirements.`),
      el('p',{},'After saving, earlier reports remain evidence for their original revision. Verification against the new requirements is required before acceptance.'),
      preview.accepted ? el('p',{},`${preview.accepted} accepted candidate(s) will return to review. The saved decision remains in history; acceptance must be renewed.`) : null,
      preview.active ? el('p',{},`${preview.active} assigned or running candidate(s) continue. Share the revised requirements with their agents.`) : null,
      preview.merged ? el('p',{class:'inline-error'},'This task has merged. Create another task for further requirements.') : null].filter(Boolean));
  }

  $("#revision-cancel").addEventListener("click", () => { if (!revisionSaving) $("#revision-dialog").close(); });
  $('#revision-dialog').addEventListener('close',()=>{ revisionDraft=null; });
  $('#revision-form').addEventListener('input',()=>{ $('#revision-status').textContent=''; renderRevisionPreview(); });
  $('#revision-rebase').addEventListener('click',()=>{
    const {workspace} = getContext();
    const task=workspace.id===revisionDraft?.workspaceId && workspace.tasks.find(item=>item.id===revisionDraft.taskId);
    if (!task || revisionSaving) return;
    revisionDraft.expectedRevision=task.revision ?? 1;
    $('#revision-status').textContent='Your proposed text is kept. Compare it with the latest saved requirements below before saving.';
    renderRevisionPreview();
  });
  $("#revision-form").addEventListener("submit", async event => {
    event.preventDefault();
    if (!revisionDraft || getContext().busy || revisionSaving) return;
    renderRevisionPreview();
    if ($('#revision-save').disabled || !$('#revision-form').reportValidity()) return;
    const captured=revisionDraft, body={expectedRevision:captured.expectedRevision,...revisionProposal()};
    revisionSaving=true; renderRevisionPreview(); $('#revision-status').textContent='Saving revision…';
    try {
      await api(`/api/tasks/${encodeURIComponent(captured.taskId)}/revise`, body);
      if (revisionDraft!==captured) return;
      $('#revision-dialog').close();
      announce('Requirements revised. Commits and earlier reports are retained; recheck before accepting.');
      await refresh(true);
    } catch(error) {
      if(revisionDraft===captured) {
        $('#revision-status').textContent=error.message + ' Your proposed changes are still here.';
        await refresh(true);
      }
    } finally { if(revisionDraft===captured || revisionDraft===null)revisionSaving=false; if(revisionDraft===captured)renderRevisionPreview(); }
  });
  function leave() {
    revisionDraft=null;revisionSaving=false;
    for(const id of ['revision-purpose','revision-criteria','revision-reason']){$('#'+id).value='';$('#'+id).disabled=false;}
    for(const id of ['revision-context','revision-preview','revision-impact','revision-status'])$('#'+id).replaceChildren();
  }
  return {openRevision, renderRevisionPreview,leave};
}
