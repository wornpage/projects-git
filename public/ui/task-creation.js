import {$, el} from './dom.js';
import {createTaskComposer} from './task-composer.js';

// Owns draft destinations, stable submission IDs and explicit request recovery.
export function createTaskCreation({getContext, currentProject, selectTask, switchView, api, refresh,
  render, updateChrome, schedulePoll, saveSession, clearError, showError, announce}) {
  let composerSource = null, savedComposer = null, taskFormInitialized = false;
  let taskStack = [blankTask()], pendingTaskStart = null, pendingModelStart = null, taskStarting = false;
  let epoch = 0;
  const composerSources = new Map();
  const {renderTaskDrafts,validateDrafts} = createTaskComposer({getContext: () => ({...getContext(), taskStack}), saveSession, updateChrome, showError});
  function blankTask(owner = '') { return {title:'', purpose:'', criteria:'', owner}; }
  function restore(saved) {
    epoch++;
    composerSources.clear(); composerSource = null; taskFormInitialized = false;
    taskStarting = false; pendingTaskStart = null; pendingModelStart = null;
    savedComposer = saved; taskStack = [blankTask()];
    for (const item of saved?.sources ?? []) composerSources.set(item.source, structuredClone(item));
    if (saved) composerSources.set(saved.source, structuredClone(saved));
    for (const id of ['project-name-input','repository-path','repository-base']) $('#' + id).value = '';
    delete $('#task-source').dataset.projects;
  }
  function composerSnapshot(source = composerSource ?? $('#task-source').value) {
    return {tasks: structuredClone(taskStack), source, name: $('#project-name-input').value,
      repo: $('#repository-path').value, base: $('#repository-base').value, pending: structuredClone(pendingTaskStart)};
  }
  function snapshot() {
    const current = composerSnapshot();
    composerSources.set(current.source, current);
    return {...current, sources: [...composerSources.values()].map(({sources, ...item}) => structuredClone(item))};
  }
  function activateComposer(source) {
    const {workspace} = getContext();
    if (source === composerSource) { $('#task-source').value = source; return true; }
    if (pendingTaskStart || taskStarting) {
      $('#task-source').value = composerSource;
      showError('Resolve the current saved task request before starting a draft in another project.');
      return false;
    }
    if (composerSource) composerSources.set(composerSource, composerSnapshot());
    const saved = composerSources.get(source);
    taskStack = saved ? structuredClone(saved.tasks) : [{title:'',purpose:'',criteria:'',owner:workspace.projects?.[source.slice(8)]?.owner ?? ''}];
    for (const [id,key] of [['project-name-input','name'],['repository-path','repo'],['repository-base','base']]) $('#' + id).value = saved?.[key] ?? '';
    pendingTaskStart = saved?.pending ?? null;
    composerSource = source; $('#task-source').value = source;
    configureTaskForm();
    return true;
  }
  function update() {
    const {workspace, busy} = getContext();
    if (!workspace) return;
    const project = currentProject();
    syncProjectOptions();
    if (!taskFormInitialized) {
      const project = currentProject();
      $('#task-source').value = project ? 'project:' + project.id : workspace.capabilities?.repository ? 'repository' : 'sample';
      if (savedComposer) {
        taskStack = savedComposer.tasks;
        if ([...$('#task-source').options].some(option => option.value === savedComposer.source)) $('#task-source').value = savedComposer.source;
        $('#project-name-input').value = savedComposer.name ?? ''; $('#repository-path').value = savedComposer.repo ?? ''; $('#repository-base').value = savedComposer.base ?? '';
        pendingTaskStart = savedComposer.pending ?? null;
      } else taskStack[0].owner = project?.owner ?? '';
      composerSource = $('#task-source').value;
      configureTaskForm(); taskFormInitialized = true;
    }
    // Route changes and restored drafts must agree on the destination project.
    // An unresolved request keeps its original body and ID; show it only there.
    if (!$('#task-launcher').open && project && composerSource?.startsWith('project:')
      && composerSource !== 'project:' + project.id && !pendingTaskStart && !taskStarting)
      activateComposer('project:' + project.id);
    const source = $('#task-source').value, mode = $('#task-execution').value;
    const sample = source === 'sample';
    const activeWork = workspace.runs.some(run => ['assigned', 'running'].includes(run.status));
    const supported = !sample ? workspace.capabilities?.repository : mode === 'model' ? workspace.capabilities?.model : workspace.capabilities?.demo;
    $('#new-task-summary').textContent = sample ? 'New project · sample starter' : source==='repository' ? 'New project · connect code' : 'Add to the task queue';
    $('#create-task').disabled = taskStarting || !supported || sample && (busy || activeWork);
    $('#create-task').textContent = taskStarting ? source === 'repository' ? 'Connecting code…' : 'Saving tasks…' : pendingTaskStart ? 'Retry this task stack' : sample ? 'Create task' : (source === 'repository' ? 'Create project & queue ' : 'Queue ') + taskStack.length + (taskStack.length === 1 ? ' task' : ' tasks');
    $('#create-task').title = taskStarting ? 'The same request is still in progress.' : !supported ? 'This workspace does not support this project source.' : sample && activeWork ? 'Wait for current sample work to finish.' : 'Save these tasks. Agents can claim queued work when ready.';
    $('#add-task-draft').hidden = sample;
    $('#add-task-draft').disabled = taskStack.length >= 8 || taskStarting || Boolean(pendingTaskStart);
    const progress = workspace.repositoryWorkflow?.imports?.find(item => item.requestId === pendingTaskStart?.requestId);
    const status = $('#task-creation-status');
    status.hidden = !taskStarting && !pendingTaskStart;
    $('#release-task-request').hidden = !pendingTaskStart || taskStarting;
    status.textContent = progress ? progress.phase + (progress.total ? ' · ' + progress.completed + ' / ' + progress.total + ' objects' : '') + ' · ' + Math.max(0, Math.round((Date.now() - progress.startedAt) / 1000)) + 's' : taskStarting ? 'Saving this task stack…' : pendingTaskStart ? 'This request has not been confirmed. Retry uses the same request ID.' : '';
    for (const control of $('#task-form').querySelectorAll('input, textarea, select')) control.disabled = taskStarting || Boolean(pendingTaskStart);
    for (const button of $('#task-drafts').querySelectorAll('button')) button.disabled = taskStarting || Boolean(pendingTaskStart);
    $('#model-availability').textContent = workspace.capabilities?.model ? 'Model: ' + workspace.execution.model + '. Starting model work sends paid requests within this allowance.' : 'Model execution is not configured.';
  }
  function syncProjectOptions() {
    const {workspace} = getContext();
    const select = $('#task-source');
    const projects = Object.values(workspace.projects ?? {});
    const signature = JSON.stringify([projects.map(project => [project.id, project.name, project.codeConnected]), workspace.capabilities]);
    if (select.dataset.projects === signature) return;
    const selected = select.value;
    select.replaceChildren(...projects.map(project => el('option', { value: 'project:' + project.id, disabled: project.codeConnected === false }, project.name)),
      el('option', { value: 'repository', disabled: !workspace.capabilities?.repository }, 'New project · connect code'),
      ...(workspace.capabilities?.demo || workspace.capabilities?.model ? [el('option', { value: 'sample' }, 'New project · checkout starter')] : []));
    if ([...select.options].some(option => option.value === selected)) select.value = selected;
    select.dataset.projects = signature;
  }
  function configureTaskForm() {
    const {workspace} = getContext();
    const source = $('#task-source').value, sample = source === 'sample', connecting = source === 'repository';
    const hosted = workspace.provider === 'cloudflare-artifacts';
    document.querySelector('label[for="repository-path"]').textContent = hosted ? 'Artifacts repository name' : 'Local repository path';
    $('#repository-path').placeholder = hosted ? 'customer-portal' : 'C:/code/my-project';
    $('#repository-base').placeholder = hosted ? 'Full commit ID at the default branch head' : 'Paste git rev-parse HEAD';
    if (sample && workspace.sampleTask) taskStack = [{ ...workspace.sampleTask, criteria: workspace.sampleTask.criteria.join('\n') }];
    $('#repository-source-fields').hidden = !connecting;
    for (const id of ['repository-path', 'repository-base', 'project-name-input']) $('#' + id).required = connecting;
    for (const option of $('#task-execution').options) option.disabled = option.hidden = sample ? option.value === 'external' || option.value === 'model' && !workspace.capabilities?.model : option.value !== 'external';
    $('#task-execution').value = sample ? workspace.capabilities?.demo ? 'scripted' : 'model' : 'external';
    $('#task-source-note').textContent = sample ? 'This starter creates a project with one fixed checkout task. Its candidates use the same work, review and evidence views.' : connecting ? hosted ? 'Connect an existing repository in your configured Artifacts namespace. Agents work in isolated forks; accepted changes merge into this repository. Then queue tasks without waiting for agents.' : 'Connect committed code once. Your project keeps its own Git copy; your source checkout stays untouched. Then queue tasks without waiting for agents.' : 'Tasks are saved in this project’s queue, in this order. An agent claims a task when ready; unstarted tasks pick up the latest merged code.';
    renderTaskDrafts(); updateExecutionForm();
  }
  function requestScope() {
    const started = epoch, workspaceId = getContext().workspace.id;
    return () => started === epoch && getContext().workspace?.id === workspaceId;
  }
  function requireResult(result, source) {
    if (typeof result?.taskId !== 'string' || !result.taskId
      || source !== 'sample' && (typeof result.projectId !== 'string' || !result.projectId
        || !Array.isArray(result.taskIds) || !result.taskIds.includes(result.taskId)
        || source.startsWith('project:') && result.projectId !== source.slice(8))) {
      const error = new Error('The server did not confirm this task request. Check its saved result before editing or retrying.');
      error.uncertain = true;
      throw error;
    }
  }
  function taskRequest(source) {
    return {requestId: crypto.randomUUID(), ...(source.startsWith('project:') ? {source: 'project', projectId: source.slice(8)}
      : {source: 'repository', projectName: $('#project-name-input').value.trim(), repo: $('#repository-path').value.trim(), baseCommit: $('#repository-base').value.trim()}),
      tasks: taskStack.map(task => ({title: task.title.trim(), purpose: task.purpose.trim(), owner: task.owner.trim(),
        criteria: task.criteria.split('\n').map(value => value.trim()).filter(Boolean),
        ...(task.dependsOn ? {dependsOn: [...task.dependsOn]} : {})}))};
  }
  async function showSavedTasks(result, source, isCurrent, recovered = false) {
    selectTask(result.taskId);
    await refresh(true);
    if (!isCurrent()) return;
    if (source === 'sample') switchView('work', result.taskId, getContext().selectedRun);
    else {
      composerSources.delete(composerSource);
      $('#task-source').value = 'project:' + result.projectId;
      composerSource = $('#task-source').value;
      taskStack = [blankTask(taskStack[0].owner)];
      configureTaskForm(); $('#task-launcher').close();
      if(getContext().view!=='overview')switchView('overview',result.taskId,null);
      else render(true);
      announce(recovered ? 'The task stack was already saved. Its original tasks are shown.' : result.taskIds.length + ' tasks queued. Agents can claim them when ready.');
      $('#page-title').focus({preventScroll: true}); $('#project-header').scrollIntoView({block: 'start', behavior: 'instant'});
    }
    saveSession();
  }
  async function createWorkbenchTask(event) {
    event.preventDefault();
    if (taskStarting || $('#create-task').disabled) return;
    if ($('#task-source').value !== 'sample' && !validateDrafts()) return;
    const source = $('#task-source').value, mode = $('#task-execution').value, isCurrent = requestScope();
    taskStarting = true; clearError(); updateChrome(); schedulePoll();
    try {
      let result;
      if (mode === 'model') {
        pendingModelStart ??= {key: crypto.randomUUID(), body: modelInput()};
        result = await api('/api/model-runs', pendingModelStart.body, pendingModelStart.key);
      } else if (source === 'sample') result = await api('/api/tasks', {source: 'sample'});
      else {
        pendingTaskStart ??= taskRequest(source);
        saveSession(); updateChrome();
        result = await api('/api/tasks', pendingTaskStart, pendingTaskStart.requestId);
      }
      if (!isCurrent()) return;
      requireResult(result, source);
      pendingTaskStart = null; pendingModelStart = null;
      await showSavedTasks(result, source, isCurrent);
    } catch (error) {
      if (!isCurrent()) return;
      if (error.status >= 400 && error.status < 500 && error.status !== 409) pendingTaskStart = null;
      showError(error.message); saveSession();
    } finally {
      if (isCurrent()) { taskStarting = false; updateChrome(); schedulePoll(); }
    }
  }
  async function releaseRequest() {
    if (!pendingTaskStart || taskStarting) return;
    const source = composerSource, isCurrent = requestScope();
    taskStarting = true; updateChrome();
    try {
      const outcome = await api('/api/task-requests/' + pendingTaskStart.requestId + '/release', {});
      if (!isCurrent()) return;
      if (outcome?.result) requireResult(outcome.result, source);
      else if (outcome?.released !== true) throw new Error('The server did not confirm whether tasks were saved. The original request remains locked.');
      pendingTaskStart = null; clearError();
      if (outcome.result) await showSavedTasks(outcome.result, source, isCurrent, true);
      else { announce('No tasks were saved by that request. You can edit the stack and retry.'); saveSession(); }
    } catch (error) { if (isCurrent()) showError(error.message); }
    finally { if (isCurrent()) { taskStarting = false; render(true); } }
  }
  $('#add-task-draft').addEventListener('click', () => {
    if (taskStack.length >= 8 || taskStarting || pendingTaskStart) return;
    taskStack.push({ title: '', purpose: '', criteria: '', owner: taskStack.at(-1).owner });
    renderTaskDrafts(); updateChrome(); saveSession();
    $('#task-title-input-' + (taskStack.length - 1)).focus();
  });
  for (const id of ['project-name-input', 'repository-path', 'repository-base']) $('#' + id).addEventListener('input', saveSession);
  function updateExecutionForm() { $('#model-form').hidden = $('#task-execution').value !== 'model'; updateModelBudget(); }
  $('#task-source').addEventListener('change', () => {
    const source = $('#task-source').value;
    if (!activateComposer(source)) return;
    updateChrome(); saveSession();
  });
  $('#task-execution').addEventListener('change', () => { updateExecutionForm(); updateChrome(); });
  function modelInput() {
    return { candidates: Number($("#model-candidates").value), limits: {
      maxRequests: Number($("#model-requests").value), maxOutputTokens: Number($("#model-output").value),
      timeoutMs: Number($("#model-seconds").value) * 1000, maxInputBytes: Number($("#model-input").value),
    } };
  }
  function updateModelBudget() {
    const { candidates, limits } = modelInput();
    $("#model-budget").textContent = `Total allowance: at most ${candidates * limits.maxRequests} requests and ${candidates * limits.maxRequests * limits.maxOutputTokens} output tokens. Input is limited to ${limits.maxInputBytes} bytes per request. These are execution limits, not a dollar estimate.`;
  }
  $("#model-form").addEventListener("input", updateModelBudget);
  updateModelBudget();

  $('#task-form').addEventListener('submit', createWorkbenchTask);
  $('#release-task-request').addEventListener('click', releaseRequest);
  return {update, restore, snapshot, activate: activateComposer,
    get starting() { return taskStarting; }, get locked() { return taskStarting || Boolean(pendingTaskStart); }};
}
