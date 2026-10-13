const uuid = /^[a-f0-9-]{36}$/;
const text = (value, limit) => typeof value === 'string' && value.length <= limit;
const entries = value => Array.isArray(value) ? value.filter(item => Array.isArray(item) && item.length === 2) : [];
const partial = workspace => workspace.page?.scope === 'loaded-projects';
const unloadedProject = (workspace, id) => partial(workspace) && uuid.test(id) && !Object.hasOwn(workspace.projects ?? {}, id);

function validComposer(value, workspace) {
  const source = value?.source;
  return (['repository', 'sample'].includes(source) || typeof source === 'string' && source.startsWith('project:')
    && (Object.hasOwn(workspace.projects ?? {}, source.slice(8)) || unloadedProject(workspace, source.slice(8))))
    && Array.isArray(value.tasks) && value.tasks.length > 0 && value.tasks.length <= 8
    && value.tasks.every(task => task && ['title','purpose','criteria','owner'].every(key => text(task[key], 6000))
      && (task.dependsOn === undefined || Array.isArray(task.dependsOn) && task.dependsOn.length <= 16 && task.dependsOn.every(id => typeof id === 'string' && /^(?:[a-f0-9-]{36}|draft:[1-8])$/.test(id))))
    && ['name','repo','base'].every(key => text(value[key], 1000));
}

// Only these maps and composer fields belong in tab storage. Authentication and
// checkout credentials are owned elsewhere and are never passed to this owner.
export function createBrowserSession({drafts, disclosures, assignmentRequests, operationRequests, projectSelections, onWarning, storage = () => sessionStorage}) {
  let key = null, warning = false, reviewerName = '';
  function warn(message) { warning = true; onWarning(message); }
  function enter(workspace) {
    const principal = workspace.authentication?.principal;
    const next = principal ? `projects-git-ui:${JSON.stringify([workspace.id, principal.issuer, principal.kind, principal.id])}` : `projects-git-ui:${workspace.id}`;
    if (key === next) return {changed: false};
    key = next; warning = false; reviewerName = '';
    for (const map of [drafts, disclosures, assignmentRequests, operationRequests, projectSelections]) map.clear();
    let composer = null;
    try {
      const saved = JSON.parse(storage().getItem(key) || '{}');
      for (const [projectId, selection] of entries(saved.projects)) {
        const task=workspace.tasks.find(task=>task.id===selection?.taskId && task.projectId===projectId);
        if (task && (!selection.runId || workspace.runs.some(run=>run.id===selection.runId && run.taskId===task.id)))
          projectSelections.set(projectId,{taskId:task.id,runId:selection.runId??null});
        else if (unloadedProject(workspace,projectId) && uuid.test(selection?.taskId) && (!selection.runId || uuid.test(selection.runId)))
          projectSelections.set(projectId,{taskId:selection.taskId,runId:selection.runId??null});
      }
      if (text(saved.reviewerName, 100)) reviewerName = saved.reviewerName.trim();
      for (const [path, request] of entries(saved.operations)) {
        if (/^\/api\/runs\/[a-f0-9-]{36}\/(checks|verify|update-base)$/.test(path) && /^[a-f0-9]{64}$/.test(request?.fingerprint) && uuid.test(request?.requestId))
          operationRequests.set(path, {fingerprint: request.fingerprint, requestId: request.requestId});
      }
      for (const [taskId, request] of entries(saved.assignments)) {
        // A page omits other projects; absence here cannot settle their requests.
        if ((workspace.tasks.some(task => task.id === taskId) || partial(workspace) && uuid.test(taskId)) && text(request?.label, 160) && uuid.test(request?.requestId)
          && (!principal || /^[a-f0-9]{32}\.access$/.test(request.agentClientId)))
          assignmentRequests.set(taskId, {label: request.label, requestId: request.requestId, ...(principal ? {agentClientId:request.agentClientId} : {})});
      }
      if (validComposer(saved.composer, workspace)) {
        composer = saved.composer;
        composer.sources = (Array.isArray(composer.sources) ? composer.sources : []).filter(item => validComposer(item, workspace));
      }
      for (const [context, draft] of entries(saved.drafts)) {
        if (typeof context === 'string' && typeof draft?.runId === 'string' && text(draft.note, 2000) && text(draft.reviewer, 320))
          drafts.set(context, {runId: draft.runId, note: draft.note, reviewer: draft.reviewer, comparisonKey: typeof draft.comparisonKey === 'string' ? draft.comparisonKey : null});
      }
      for (const [id, open] of entries(saved.disclosures)) if (typeof id === 'string' && typeof open === 'boolean') disclosures.set(id, open);
    } catch {
      warn('Saved browser context could not be restored. Review text in this tab may not survive a reload.');
    }
    return {changed: true, composer};
  }
  function save(composer) {
    if (!key) return;
    try {
      storage().setItem(key, JSON.stringify({drafts: [...drafts], disclosures: [...disclosures].slice(-300),
        assignments: [...assignmentRequests], operations: [...operationRequests], projects:[...projectSelections].slice(-100), composer, reviewerName}));
    } catch {
      warn('This browser could not save your drafts or request IDs. Keep this tab open or copy your text before leaving.');
    }
  }
  function rememberReviewerName(value) {
    if (!text(value, 100)) throw new Error('Reviewer name must be text of at most 100 characters.');
    reviewerName = value.trim();
  }
  return {enter, save, rememberReviewerName, getReviewerName: () => reviewerName, get warning() { return warning; }};
}
