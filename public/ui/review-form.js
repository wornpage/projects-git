import {$, el, shortSha, dateTime, explainDisabledButtons} from './dom.js';
import {reviewContext, candidateOutcome, mergeState, projectMergeBlocker} from '../workbench-state.js';
import {independentReviewStatus} from '../review-boundary.js';

// Human review and merge remain separate guarded operations.
export function createReviewForm({getContext, drafts, api, mutate, refresh, saveSession, showError, getReviewerName, rememberReviewerName, runCoordination, comparisonKey, comparisonHeads, acceptanceReady, disclosure, evidenceChecks, diffPanel, switchView}) {
  let mergePending = false;
  function mergeReady(workspace, run, task) {
    const operation = mergeState(workspace, run), project = workspace.projects?.[task.projectId], related = runCoordination(run);
    return operation !== 'running'
      && !projectMergeBlocker(workspace, run)
      && (!run.review?.policy || operation === 'recovery-required' || project?.automaticMergePolicy?.enabled && project.automaticMergePolicy.version === run.review.policy.version)
      && (operation === 'recovery-required' || !project || project.mainCommit === task.baseCommit)
      && !task.mergedCommit && task.acceptedRunId === run.id && run.status === 'accepted' && run.baseCommit === task.baseCommit
      && acceptanceReady(run) && run.evidence?.exitCode === 0 && workspace.capabilities?.merge === true
      && run.review?.decision === 'accept' && run.review.headCommit === run.headCommit
      && (workspace.provider !== 'cloudflare-artifacts' || independentReviewStatus(workspace, run).passed && run.review.codeReviewId === run.codeReview?.id)
      && (run.review.taskRevision ?? 1) === (task.revision ?? 1)
      && task.owner && run.review.ownerVersion === task.ownerVersion && related && !related.activeRunIds.length && !related.blockingRunIds.length
      && comparisonHeads(run).every(head => run.review.comparisons?.some(saved => saved.runId === head.runId && saved.headCommit === head.headCommit));
  }
  function draftFor(run) {
    const {workspace} = getContext();
    const key = reviewContext(workspace, run);
    if (!drafts.has(key)) drafts.set(key, { runId: run.id, note: "", reviewer: getReviewerName(), comparisonKey: null });
    const draft = drafts.get(key);
    if (workspace.authentication?.mode === 'cloudflare-access') draft.reviewer = workspace.authentication.principal.kind === 'owner' ? workspace.authentication.principal.displayName : '';
    return draft;
  }
  function reviewPanel(run, task) {
    const {workspace, busy, sessionWarning} = getContext();
    const draft = draftFor(run);
    const context = reviewContext(workspace, run);
    const hosted = workspace.authentication?.mode === 'cloudflare-access';
    const retained = Boolean(task.acceptedRunId && task.acceptedRunId !== run.id);
    const canReview = (run.status === 'awaiting_review' || run.status === 'accepted' && run.review?.policy && !mergeState(workspace, run)) && !retained && !task.mergedCommit && (!hosted || workspace.authentication.permissions.review);
    const related = runCoordination(run);
    const prerequisites = related?.acceptance;
    const hasOverlaps = Boolean(related?.overlaps.length);
    const checklist = el('div', { class: 'review-prerequisites', id: 'acceptance-prerequisites' });
    const savedMessage = hosted ? 'Review notes are saved for this authenticated owner and workspace. Identity is supplied by the server.' : 'Saved in this tab. Your name is reused for new review drafts in this workspace; notes stay with this candidate.';
    const saveNote = el('p', { class: 'draft-note' }, sessionWarning ? 'Draft storage unavailable; copy your text before leaving.' : savedMessage);
    const acceptButton = el('button', { id: 'accept-' + run.id, type: 'submit', class: 'button button-dark' }, 'Accept candidate');
    const rejectButton = el('button', { id: 'reject-' + run.id, type: 'button', class: 'button button-danger', onclick: () => submitReview(run, 'reject') }, 'Reject candidate');
    const updateButtons = () => {
      const rules = [
        ...(prerequisites ?? [{ met: false, label: 'Updated server required for current acceptance prerequisites' }]),
        { met: Boolean(draft.reviewer.trim()), label: hosted ? 'Authenticated owner session' : 'Enter your reviewer name' },
        ...(hasOverlaps ? [{ met: draft.comparisonKey === comparisonKey(run), label: 'Compare the overlapping changes and acknowledge their current commits' }] : []),
      ];
      const missing = rules.filter(rule => !rule.met);
      const filled = Boolean(draft.note.trim() && draft.reviewer.trim());
      acceptButton.disabled = busy || !canReview || missing.length > 0;
      rejectButton.disabled = busy || !canReview || !filled;
      acceptButton.title = busy ? 'Wait for the current action.' : missing.length ? 'Complete the acceptance prerequisites shown above.' : 'Accept this exact commit. Merge remains separate.';
      rejectButton.title = !draft.reviewer.trim() ? 'Enter your reviewer name.' : !draft.note.trim() ? 'Add feedback explaining the rejection.' : busy ? 'Wait for the current action.' : 'Reject this candidate and retain its evidence.';
      checklist.replaceChildren(el('p', { class: 'prerequisite-heading', role: 'status' }, missing.length ? missing.length + ' acceptance prerequisites remaining' : 'Ready to record your choice'),
        missing.length ? el('ul', {}, missing.map(rule => el('li', {}, rule.label))) : el('p', { class: 'small' }, 'All prerequisites are satisfied. Acceptance does not merge.'),
        el('p', { class: 'head-hint' }, (rules.length - missing.length) + ' / ' + rules.length + ' prerequisites satisfied · rechecked on submission.'));
      explainDisabledButtons();
    };
    const noteId = 'review-note-' + run.id, nameId = 'reviewer-' + run.id;
    const changed = () => { saveSession(); saveNote.textContent = getContext().sessionWarning ? 'Draft storage unavailable; copy your text before leaving.' : savedMessage; updateButtons(); };
    const reviewer = el('input', { id: nameId, value: draft.reviewer, readonly: hosted, required: true, maxlength: hosted ? '320' : '100', autocomplete: 'name', placeholder: 'Your name', oninput: event => { if (hosted) return; draft.reviewer = event.target.value; rememberReviewerName(draft.reviewer); changed(); } });
    const noteHelpId = noteId + '-help';
    const note = el('textarea', { id: noteId, maxlength: '2000', 'aria-describedby': noteHelpId, placeholder: 'Add context or explain requested changes', oninput: event => { draft.note = event.target.value; changed(); } }, draft.note);
    const oldDrafts = [...drafts.entries()].filter(([key, value]) => key !== context && value.runId === run.id && (value.note || value.reviewer));
    const previous = oldDrafts.length ? disclosure('old-drafts-' + run.id, oldDrafts.length + ' earlier draft(s) · context changed',
      el('p', { class: 'small' }, 'The commit, requirements, owner, evidence or compared heads changed. Earlier text is retained below; comparison must be renewed.'),
      oldDrafts.map(([, value]) => el('blockquote', { class: 'saved-draft' }, el('strong', {}, value.reviewer), el('p', {}, value.note)))) : null;
    const comparison = hasOverlaps ? el('div', { class: 'review-comparison' },
      el('h3', {}, 'Compare alternatives'),
      related.overlaps.map(other => {
        const candidate = workspace.runs.find(item => item.id === other.runId);
        return disclosure('compare-' + run.id + '-' + other.runId + '-' + other.headCommit, 'Compare ' + other.label + ' · ' + shortSha(other.headCommit),
          el('p', { class: 'head-hint' }, 'Shared files: ' + other.paths.join(', ')), candidate ? evidenceChecks(candidate) : null, candidate ? diffPanel(candidate) : null);
      }),
      el('label', { class: 'comparison-confirm' }, el('input', { id: 'comparison-' + run.id, type: 'checkbox', checked: draft.comparisonKey === comparisonKey(run), onchange: event => { draft.comparisonKey = event.target.checked ? comparisonKey(run) : null; changed(); } }), 'I compared the overlapping candidates at these commits.')) : null;
    const form = canReview ? el('form', { class: 'review-form', onsubmit: event => { event.preventDefault(); if (!acceptButton.disabled) submitReview(run, 'accept'); } },
      comparison, el('div', {}, el('label', { for: nameId }, hosted ? 'Owner' : 'Decision attribution'), reviewer),
      el('div', {}, el('label', { for: noteId }, 'Review note'), note,
        el('p', { id: noteHelpId, class: 'small' }, 'Optional when accepting; explain rejections. A blank note records this commit and requirements r' + (task.revision ?? 1) + '.')), saveNote,
      el('div', { class: 'review-buttons' }, acceptButton, rejectButton)) : null;
    if(run.status==='accepted')acceptButton.classList.remove('button-primary');
    updateButtons();
    const record = run.review ? el('div', { class: 'review-record ' + (run.review.decision === 'reject' ? 'rejected' : '') },
      el('h3', {}, run.review.policy ? 'Approved by automatic policy' : run.review.decision === 'accept' ? 'Candidate accepted' : 'Candidate rejected'), el('p', {}, run.review.note),
      el('p', { class: 'small' }, (run.review.policy ? 'Policy v' + run.review.policy.version + ' · enabled by ' + run.review.policy.enabledBy.displayName + ' · ' : workspace.demonstration?.kind==='read-only-sample' ? 'Example decision · ' : run.review.identity ? 'Authenticated owner · ' : 'Recorded attribution · ') + run.review.reviewer + ' · ' + dateTime(run.review.at) + ' · Head ' + shortSha(run.review.headCommit))) : null;
    const merging = mergeState(workspace, run);
    const recovering = merging === 'recovery-required';
    const canMerge = mergeReady(workspace, run, task);
    const projectBusy = Boolean(projectMergeBlocker(workspace, run));
    const merge = run.status === 'accepted' ? el('div', { class: 'merge-section' },
      recovering ? el('div', {class:'merge-recovery-explanation'},
        el('p', {}, 'Check the target of the saved merge attempt:'),
        el('ul', {class:'small'},
          el('li', {}, 'Already at the accepted commit: record completion without another check or Git update.'),
          el('li', {}, 'Still at the reviewed base: run fresh checks and retry the merge.'),
          el('li', {}, 'At a different commit: stop and keep recovery visible.')))
        : el('p', {}, projectBusy ? 'Another merge owns this project. This merge can start after its outcome is known.' : task.origin === 'connected-git' ? 'Merge into this workspace’s local main branch. GitHub publication is a separate preview and owner action after this merge.' : 'Merge this chosen commit into the task repository. This does not deploy the app.'),
      el('div', {class: 'merge-actions'},
        el('button', { id:'merge-'+run.id, type:'button', class: 'button button-primary', disabled: busy || !canMerge, title: busy ? 'Wait for the current action.' : merging === 'running' ? candidateOutcome(workspace, run).next : !canMerge ? 'Merge needs current acceptance, evidence, ownership and compared heads. Read the current record.' : recovering ? 'Read the target; fresh checks and another guarded merge may run.' : 'Merge the accepted commit.', onclick: () => submitMerge(run.id, context) }, merging === 'running' ? 'Merge in progress…' : recovering ? 'Reconcile or retry merge' : 'Merge accepted candidate'),
        merging ? el('button', {type:'button', class:'button button-small', onclick:() => refresh(true)}, 'Refresh merge status') : null)) : null;
    return el('section', { class: 'panel', id: 'review-decision', tabindex: '-1' },
      el('div', { class: 'panel-header' }, el('h2', {}, run.status === 'merged' || retained ? 'Recorded outcome' : 'Your decision')),
      el('div', { class: 'panel-body' }, el('p', { class: 'review-reason' }, candidateOutcome(workspace, run).next),
        canReview ? checklist : null, previous, form, record, merge,
        run.status === 'merged' ? el('p', { class: 'head-hint' }, 'Merged commit · ' + task.mergedCommit) : null,
        retained ? el('button', { class: 'button button-small', onclick: () => switchView('review', task.id, task.acceptedRunId) }, 'View chosen candidate') : null,
        canReview && !task.owner ? el('button', { class: 'button button-small', onclick: () => switchView('work', task.id, run.id) }, 'Open task settings') : null));
  }
  async function submitReview(run, decision) {
    const {workspace} = getContext();
    const draft = draftFor(run);
    if (!draft.reviewer.trim()) { showError('Enter your name before recording a decision.'); return; }
    if (decision === 'reject' && !draft.note.trim()) { showError('Add feedback explaining the rejection.'); return; }
    if (decision === "accept" && (!runCoordination(run)?.acceptance?.every(rule => rule.met) || draft.comparisonKey !== comparisonKey(run) && comparisonHeads(run).length)) { showError("Complete all current acceptance prerequisites and compare the overlapping heads before submitting."); return; }
    const submittedContext = reviewContext(workspace, run);
    const task = workspace.tasks.find(task => task.id === run.taskId);
    const note = draft.note.trim() || `Accepted commit ${run.headCommit} for requirements r${task.revision ?? 1}.`;
    const result = await mutate(() => api(`/api/runs/${encodeURIComponent(run.id)}/review`, { decision, note, ...(workspace.authentication?.mode === 'cloudflare-access' ? {} : {reviewer: draft.reviewer.trim()}), headCommit: run.headCommit, taskRevision: task.revision ?? 1, ownerVersion: task.ownerVersion, comparisons: decision === 'accept' && draft.comparisonKey === comparisonKey(run) ? comparisonHeads(run) : [] }), decision === "accept" ? "Candidate accepted. Merge remains a separate action." : "Candidate rejected. Your review note is retained.");
    if (result) { drafts.delete(submittedContext); saveSession(); await refresh(true); $('#review-decision')?.focus({ preventScroll: true }); }
  }
  async function submitMerge(runId, expectedContext) {
    const {workspace, busy} = getContext();
    if (busy || mergePending) return;
    const run = workspace.runs.find(item => item.id === runId);
    const task = workspace.tasks.find(item => item.id === run?.taskId);
    if (!run || !task || mergeState(workspace, run) === 'running') return;
    if (reviewContext(workspace, run) !== expectedContext || !mergeReady(workspace, run, task)) {
      showError('The merge context changed. Refresh and inspect the current acceptance and evidence before trying again.');
      return;
    }
    mergePending = true;
    try {
      const result = await mutate(() => api(`/api/runs/${encodeURIComponent(run.id)}/merge`, { headCommit: run.headCommit }), "Accepted candidate merged into the task base.");
      if (result) { await refresh(true); $('#review-decision')?.focus({ preventScroll: true }); }
    } finally { mergePending = false; }
  }

  return {draftFor, reviewPanel};
}
