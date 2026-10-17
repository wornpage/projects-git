import {$, el} from './dom.js';
import {createTaskComposer} from './task-composer.js';

// Owns draft destinations, stable submission IDs and explicit request recovery.
export function createTaskCreation({getContext, currentProject, selectProject, selectTask, switchView, api, refresh,
  render, updateChrome, schedulePoll, saveSession, clearError, showError, announce}) {
  let composerSource = null, savedComposer = null, taskFormInitialized = false;
  let taskStack = [blankTask()], pendingTaskStart = null, pendingModelStart = null, taskStarting = false;
  let pendingRepositoryStart = null;
  let epoch = 0;
  let codeConfirmed = false, inspectingRepository = false, inspectionRequest = 0;
  const composerSources = new Map();
  const {renderTaskDrafts,validateDrafts} = createTaskComposer({getContext: () => ({...getContext(), taskStack}), saveSession, updateChrome, showError});
  function blankTask(owner = '') { return {title:'', purpose:'', criteria:'', owner}; }
  function restoredModelStart(saved) {
    const request = saved?.modelStart;
    if (request == null) return null;
    const limits = request.body?.limits;
    if (saved.source !== 'sample' || !/^[a-f0-9-]{36}$/.test(request.key ?? '')
      || Object.keys(request).sort().join(',') !== 'body,key' || Object.keys(request.body ?? {}).sort().join(',') !== 'candidates,limits'
      || !Number.isSafeInteger(request.body?.candidates) || request.body.candidates < 1
      || !limits || Object.keys(limits).sort().join(',') !== 'maxInputBytes,maxOutputTokens,maxRequests,timeoutMs'
      || !['maxRequests','maxOutputTokens','timeoutMs','maxInputBytes'].every(key => Number.isSafeInteger(limits[key]) && limits[key] > 0))
      throw new Error('The saved model-start request is invalid. Inspect its outcome before starting another model run.');
    return structuredClone(request);
  }
  function restoredRepositoryStart(saved) {
    const request = saved?.repositoryStart;
    if (request == null) return null;
    if (saved.source !== 'new-repository' || !/^[a-f0-9-]{36}$/.test(request.key ?? '')
      || Object.keys(request).sort().join(',') !== 'body,key' || Object.keys(request.body ?? {}).sort().join(',') !== 'description,name'
      || typeof request.body.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(request.body.name)
      || typeof request.body.description !== 'string' || request.body.description.length > 500)
      throw new Error('The saved repository request is invalid. Inspect its outcome before creating another repository.');
    return structuredClone(request);
  }
  function pendingRequest() { return Boolean(pendingTaskStart || pendingModelStart || pendingRepositoryStart); }
  function restore(saved) {
    epoch++;
    codeConfirmed = false; inspectionRequest++; inspectingRepository = false;
    composerSources.clear(); composerSource = null; taskFormInitialized = false;
    taskStarting = false; pendingTaskStart = null; pendingModelStart = null; pendingRepositoryStart = null;
    savedComposer = saved; taskStack = [blankTask()];
    for (const item of saved?.sources ?? []) { restoredModelStart(item); restoredRepositoryStart(item); composerSources.set(item.source, structuredClone(item)); }
    if (saved) { restoredModelStart(saved); restoredRepositoryStart(saved); composerSources.set(saved.source, structuredClone(saved)); }
    for (const id of ['project-name-input','repository-path','repository-base','repository-create-name','repository-create-description']) $('#' + id).value = '';
    delete $('#task-source').dataset.projects;
  }
  function composerSnapshot(source = composerSource ?? $('#task-source').value) {
    return {tasks: structuredClone(taskStack), source, name: $('#project-name-input').value,
      repo: $('#repository-path').value, base: $('#repository-base').value, codeConfirmed,
      pending: structuredClone(pendingTaskStart), modelStart: structuredClone(pendingModelStart),
      repositoryDraft: {name: $('#repository-create-name').value, description: $('#repository-create-description').value},
      repositoryStart: structuredClone(pendingRepositoryStart)};
  }
  function snapshot() {
    const current = composerSnapshot();
    composerSources.set(current.source, current);
    return {...current, sources: [...composerSources.values()].map(({sources, ...item}) => structuredClone(item))};
  }
  function activateComposer(source) {
    const {workspace} = getContext();
    if (source === composerSource) { $('#task-source').value = source; return true; }
    if (pendingRequest() || taskStarting) {
      $('#task-source').value = composerSource;
      showError('Resolve the current saved request before starting a draft in another project.');
      return false;
    }
    if (composerSource) composerSources.set(composerSource, composerSnapshot());
    codeConfirmed = false; inspectionRequest++; inspectingRepository = false;
    $('#repository-inspection-status').textContent = '';
    const saved = composerSources.get(source);
    codeConfirmed = saved?.codeConfirmed === true;
    taskStack = saved ? structuredClone(saved.tasks) : [{title:'',purpose:'',criteria:'',owner:workspace.projects?.[source.slice(8)]?.owner ?? ''}];
    for (const [id,key] of [['project-name-input','name'],['repository-path','repo'],['repository-base','base']]) $('#' + id).value = saved?.[key] ?? '';
    pendingTaskStart = saved?.pending ?? null;
    pendingModelStart = restoredModelStart(saved);
    pendingRepositoryStart = restoredRepositoryStart(saved);
    for (const field of ['name','description']) $('#repository-create-'+field).value = pendingRepositoryStart?.body[field] ?? saved?.repositoryDraft?.[field] ?? '';
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
        codeConfirmed = savedComposer.codeConfirmed === true;
        taskStack = savedComposer.tasks;
        if ([...$('#task-source').options].some(option => option.value === savedComposer.source)) $('#task-source').value = savedComposer.source;
        $('#project-name-input').value = savedComposer.name ?? ''; $('#repository-path').value = savedComposer.repo ?? ''; $('#repository-base').value = savedComposer.base ?? '';
        pendingTaskStart = savedComposer.pending ?? null;
        pendingModelStart = restoredModelStart(savedComposer);
        pendingRepositoryStart = restoredRepositoryStart(savedComposer);
        for (const field of ['name','description']) $('#repository-create-'+field).value = pendingRepositoryStart?.body[field] ?? savedComposer.repositoryDraft?.[field] ?? '';
      } else taskStack[0].owner = project?.owner ?? '';
      composerSource = $('#task-source').value;
      configureTaskForm(); taskFormInitialized = true; savedComposer = null;
    }
    // Route changes and restored drafts must agree on the destination project.
    // An unresolved request keeps its original body and ID; show it only there.
    if (!$('#task-launcher').open && project && composerSource?.startsWith('project:')
      && composerSource !== 'project:' + project.id && !pendingRequest() && !taskStarting)
      activateComposer('project:' + project.id);
    const source = $('#task-source').value, mode = $('#task-execution').value;
    const sample = source === 'sample', creating = source === 'new-repository';
    const unloadedSource = source.startsWith('project:') && !Object.hasOwn(workspace.projects ?? {}, source.slice(8));
    const codeStep = source === 'repository' && !codeConfirmed && !pendingTaskStart;
    $('#repository-source-fields').hidden = !codeStep;
    $('#repository-next').hidden = !codeStep;
    $('#repository-next').disabled = taskStarting || Boolean(pendingTaskStart) || inspectingRepository;
    $('#repository-back').hidden = source !== 'repository' || !codeConfirmed;
    $('#repository-back').disabled = taskStarting || Boolean(pendingTaskStart);
    $('#repository-create-fields').hidden = !creating;
    $('#repository-create-fields').disabled = !creating || taskStarting || pendingRequest();
    $('#create-repository').hidden = !creating;
    $('#create-repository').disabled = taskStarting || !workspace.capabilities?.repositoryCreate;
    $('#create-repository').textContent = taskStarting ? 'Creating repository…' : pendingRepositoryStart ? 'Retry this repository' : 'Create repository';
    $('#task-details-step').hidden = codeStep || creating;
    $('#task-details-step').disabled = codeStep || creating;
    $('#task-details-label').textContent = source === 'repository' ? '2. Describe your first task' : 'Describe the work';
    $('#create-task').hidden = codeStep || creating;
    $('#inspect-repository').hidden = !workspace.capabilities?.inspectRepository;
    $('#inspect-repository').disabled = taskStarting || Boolean(pendingTaskStart) || inspectingRepository;
    const activeWork = workspace.runs.some(run => ['assigned', 'running'].includes(run.status));
    const supported = source.startsWith('project:')&&workspace.trial?.workflowReady
      ? workspace.authentication?.permissions.manage
      : !sample ? workspace.capabilities?.repository : mode === 'model' ? workspace.capabilities?.model : workspace.capabilities?.demo;
    $('#new-task-summary').textContent = creating ? 'New project · Create repository' : sample ? 'New project · sample starter' : source==='repository' ? codeStep ? 'New project · connect code' : 'New project · first task' : 'Add to the task queue';
    if (source === 'repository' && !codeStep) $('#task-source-note').textContent = $('#project-name-input').value + ' · ' + $('#repository-path').value + ' · Commit ' + $('#repository-base').value + (workspace.provider === 'cloudflare-artifacts' ? '. The project uses this Artifacts repository and selected base commit.' : '. Only this committed code will be copied.');
    $('#create-task').disabled = creating || codeStep || taskStarting || unloadedSource || !supported || sample && (busy || activeWork);
    $('#create-task').textContent = taskStarting ? source === 'repository' ? 'Connecting code…' : sample ? 'Starting agents…' : 'Saving tasks…'
      : pendingModelStart ? 'Retry same model start' : pendingTaskStart ? 'Retry this task stack'
      : sample ? mode === 'model' ? 'Start model agents' : 'Start 2 scripted agents'
      : (source === 'repository' ? 'Create project & queue ' : 'Queue ') + taskStack.length + (taskStack.length === 1 ? ' task' : ' tasks');
    $('#create-task').title = taskStarting ? 'The same request is still in progress.' : unloadedSource ? 'Load the original project before submitting this saved work.' : !supported ? 'This workspace does not support this project source.'
      : sample && activeWork ? 'Wait for current sample work to finish.'
      : pendingModelStart ? 'Retry the saved model request with its original allowance and request ID.'
      : sample ? mode === 'model' ? 'Create the sample project and start model agents within the displayed allowance.' : 'Create the sample project and start two scripted agents. No model calls are made.'
      : 'Save these tasks. Agents can claim queued work when ready.';
    $('#add-task-draft').hidden = sample || creating;
    $('#add-task-draft').disabled = taskStack.length >= 8 || taskStarting || pendingRequest();
    const progress = workspace.repositoryWorkflow?.imports?.find(item => item.requestId === pendingTaskStart?.requestId);
    const status = $('#task-creation-status');
    status.hidden = !taskStarting && !pendingRequest() && !unloadedSource;
    $('#open-saved-project').hidden = !unloadedSource;
    $('#open-saved-project').disabled = taskStarting;
    $('#release-task-request').hidden = !pendingTaskStart || taskStarting;
    status.textContent = progress ? progress.phase + (progress.total ? ' · ' + progress.completed + ' / ' + progress.total + ' objects' : '') + ' · ' + Math.max(0, Math.round((Date.now() - progress.startedAt) / 1000)) + 's'
      : taskStarting ? creating ? 'Creating your private repository and connecting its initial commit…' : sample ? 'Starting agents with this request…' : 'Saving this task stack…'
      : unloadedSource ? 'This saved work belongs to another project. Open the original project before reviewing or retrying it.'
      : pendingRepositoryStart ? 'Repository creation has not been confirmed. Retry resumes this same request. Keep its name and description until the result is confirmed.'
      : pendingModelStart ? 'This model start has not been confirmed. The original allowance is locked. Retry uses the same request ID; refreshing this page does not start another run.'
      : pendingTaskStart ? 'This request has not been confirmed. Retry uses the same request ID.' : '';
    for (const control of $('#task-form').querySelectorAll('input, textarea, select')) control.disabled = taskStarting || pendingRequest();
    for (const button of $('#task-drafts').querySelectorAll('button')) button.disabled = taskStarting || pendingRequest();
    if (pendingModelStart) updateModelBudget();
    $('#model-availability').textContent = workspace.capabilities?.model ? 'Model: ' + workspace.execution.model + '. Starting model work sends paid requests within this allowance.' : 'Model execution is not configured.';
  }
  function syncProjectOptions() {
    const {workspace} = getContext();
    const select = $('#task-source');
    const projects = Object.values(workspace.projects ?? {});
    const modelRequest = pendingModelStart ?? savedComposer?.modelStart;
    const repositoryRequest = pendingRepositoryStart ?? savedComposer?.repositoryStart;
    const retainedSource = composerSource ?? savedComposer?.source;
    const unloadedSource = retainedSource?.startsWith('project:') && !Object.hasOwn(workspace.projects ?? {}, retainedSource.slice(8));
    const signature = JSON.stringify([projects.map(project => [project.id, project.name, project.codeConnected]), workspace.capabilities, modelRequest?.key, repositoryRequest?.key, unloadedSource ? retainedSource : null]);
    if (select.dataset.projects === signature) return;
    const selected = select.value;
    select.replaceChildren(...projects.map(project => el('option', { value: 'project:' + project.id, disabled: project.codeConnected === false }, project.name)),
      ...(unloadedSource ? [el('option',{value:retainedSource,disabled:true},'Saved project · load before continuing')] : []),
      el('option', { value: 'repository', disabled: !workspace.capabilities?.repository }, 'New project · connect code'),
      ...(workspace.capabilities?.repositoryCreate || repositoryRequest ? [el('option', {value: 'new-repository', disabled: !workspace.capabilities?.repositoryCreate}, 'New project · Create repository')] : []),
      ...(workspace.capabilities?.demo || workspace.capabilities?.model || modelRequest
        ? [el('option', { value: 'sample', disabled: !workspace.capabilities?.demo && !workspace.capabilities?.model }, modelRequest ? 'Sample project · unconfirmed model start' : 'New project · checkout starter')] : []));
    if ([...select.options].some(option => option.value === selected)) select.value = selected;
    select.dataset.projects = signature;
  }
  function configureTaskForm() {
    const {workspace} = getContext();
    const source = $('#task-source').value, sample = source === 'sample', connecting = source === 'repository';
    const creating = source === 'new-repository';
    const hosted = workspace.provider === 'cloudflare-artifacts';
    document.querySelector('label[for="repository-path"]').textContent = hosted ? 'Artifacts repository name' : 'Local repository path';
    $('#repository-path').placeholder = hosted ? 'customer-portal' : 'C:/code/my-project';
    $('#repository-base').placeholder = hosted ? 'Full commit ID at the default branch head' : 'Paste git rev-parse HEAD';
    if (sample && workspace.sampleTask) taskStack = [{ ...workspace.sampleTask, criteria: workspace.sampleTask.criteria.join('\n') }];
    $('#repository-source-fields').hidden = !connecting;
    for (const id of ['repository-path', 'repository-base', 'project-name-input']) $('#' + id).required = connecting;
    $('#repository-create-name').required = creating;
    for (const option of $('#task-execution').options) option.disabled = option.hidden = sample ? option.value === 'external' || option.value === 'model' && !workspace.capabilities?.model : option.value !== 'external';
    $('#task-execution').value = sample ? pendingModelStart || !workspace.capabilities?.demo ? 'model' : 'scripted' : 'external';
    $('#task-source-note').textContent = sample ? 'A sample project with one fixed checkout task. Choose how its agents run below.' : connecting ? hosted ? 'Connect an Artifacts repository. Agents use isolated forks; accepted changes merge back here.' : 'Connect committed code. The project keeps a Git copy; your source checkout stays untouched.' : 'Tasks enter this queue in order. Unstarted tasks use the latest merged code.';
    if (creating) $('#task-source-note').textContent = 'After the repository is connected, describe your first task.';
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
    const source = $('#task-source').value, mode = $('#task-execution').value, isCurrent = requestScope(), retryingRequest = pendingRequest();
    taskStarting = true; clearError(); updateChrome(); schedulePoll();
    try {
      let result;
      if (mode === 'model') {
        pendingModelStart ??= {key: crypto.randomUUID(), body: modelInput()};
        saveSession(); updateChrome();
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
      saveSession();
      await showSavedTasks(result, source, isCurrent);
    } catch (error) {
      if (!isCurrent()) return;
      // A refused retry cannot prove that an earlier uncertain request failed.
      if (!retryingRequest && error.status >= 400 && error.status < 500 && error.status !== 409) { pendingTaskStart = null; pendingModelStart = null; }
      showError(error.message); saveSession();
    } finally {
      if (isCurrent()) {
        taskStarting = false; updateChrome(); schedulePoll();
        if ($('#task-launcher').open && document.activeElement === document.body) $('#create-task').focus({preventScroll:true});
      }
    }
  }
  async function createRepository() {
    if (taskStarting || $('#create-repository').disabled || $('#task-source').value !== 'new-repository') return;
    if (!pendingRepositoryStart && !$('#repository-create-name').reportValidity()) return;
    const isCurrent = requestScope();
    pendingRepositoryStart ??= {key: crypto.randomUUID(), body: {name: $('#repository-create-name').value.trim(), description: $('#repository-create-description').value.trim()}};
    taskStarting = true; clearError(); saveSession(); updateChrome();
    try {
      const result = await api('/api/repositories', pendingRepositoryStart.body, pendingRepositoryStart.key);
      if (!isCurrent()) return;
      if (result?.workspaceId !== getContext().workspace.id || typeof result.projectId !== 'string' || !/^[a-f0-9-]{36}$/.test(result.projectId)
        || result.name !== pendingRepositoryStart.body.name || result.defaultBranch !== 'main' || !/^[a-f0-9]{40}$/.test(result.baseCommit))
        throw new Error('The server did not confirm this repository. Retry the same request to check its result.');
      await selectProject(result.projectId);
      if (!isCurrent()) return;
      if (!getContext().workspace.projects?.[result.projectId]) throw new Error('Repository created. Its project could not be loaded; retry this request to open the same project.');
      pendingRepositoryStart = null; taskStarting = false;
      composerSources.delete('new-repository'); composerSource = null;
      activateComposer('project:' + result.projectId);
      if (!$('#task-launcher').open) $('#task-launcher').showModal();
      $('#task-source-note').textContent = 'Private repository created and connected. Describe your first task.';
      announce('Private repository created and connected. Describe your first task.');
      saveSession(); updateChrome();
      $('#draft-editor').querySelector('input').focus();
    } catch (error) {
      if (!isCurrent()) return;
      // Session/authority failures can arrive after creation. Only a definite
      // input/name refusal proves this request can be edited safely.
      if (['REPOSITORY_NAME_TAKEN','REPOSITORY_NAME_RESERVED','INVALID_REPOSITORY_CREATION','INVALID_REPOSITORY','INVALID_INPUT'].includes(error.code)) pendingRepositoryStart = null;
      showError(error.message); saveSession();
    } finally {if (isCurrent()) {taskStarting = false; updateChrome();}}
  }
  $('#create-repository').addEventListener('click', createRepository);
  for (const field of ['name','description']) $('#repository-create-'+field).addEventListener('input', saveSession);
  $('#repository-next').addEventListener('click', () => {
    if (taskStarting || pendingTaskStart || inspectingRepository) return;
    for (const id of ['project-name-input','repository-path','repository-base']) if (!$('#'+id).reportValidity()) return;
    codeConfirmed = true; updateChrome(); saveSession(); $('#draft-editor').querySelector('input').focus();
  });
  $('#repository-back').addEventListener('click', () => {
    if (taskStarting || pendingTaskStart) return;
    codeConfirmed = false; $('#task-source-note').textContent = 'Choose the repository and exact committed baseline for this project. Your task draft is kept while you change the code selection.';
    updateChrome(); saveSession(); $('#repository-path').focus();
  });
  $('#inspect-repository').addEventListener('click', async () => {
    if (taskStarting || pendingTaskStart || inspectingRepository || !getContext().workspace.capabilities?.inspectRepository) return;
    const repo = $('#repository-path').value.trim();
    if (!repo) { $('#repository-path').reportValidity(); return; }
    const request = ++inspectionRequest, isCurrent = requestScope(), previousBase = $('#repository-base').value;
    const current = () => isCurrent() && request === inspectionRequest && $('#task-source').value === 'repository' && $('#repository-path').value.trim() === repo;
    inspectingRepository = true; $('#repository-inspection-status').textContent = 'Reading committed code…'; updateChrome();
    try {
      const result = await api('/api/repositories/inspect', {repo});
      if (!current() || $('#repository-base').value !== previousBase) return;
      if (!/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(result?.headCommit)) throw new Error('The server did not return a valid commit.');
      $('#repository-base').value = result.headCommit;
      if (!$('#project-name-input').value.trim()) $('#project-name-input').value = result.name;
      $('#repository-inspection-status').textContent = 'Current committed HEAD loaded. Confirm the selected commit before continuing. Uncommitted files are not included.';
      saveSession();
    } catch (error) { if (current()) $('#repository-inspection-status').textContent = error.message; }
    finally { if (isCurrent() && request === inspectionRequest) { inspectingRepository = false; updateChrome(); } }
  });
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
    if (taskStack.length >= 8 || taskStarting || pendingRequest()) return;
    taskStack.push({ title: '', purpose: '', criteria: '', owner: taskStack.at(-1).owner });
    renderTaskDrafts(); updateChrome(); saveSession();
    $('#task-title-input-' + (taskStack.length - 1)).focus();
  });
  for (const id of ['project-name-input', 'repository-path', 'repository-base']) $('#' + id).addEventListener('input', () => {
    if (id === 'repository-path') { $('#repository-base').value = ''; codeConfirmed = false; }
    if (id !== 'project-name-input') { inspectionRequest++; inspectingRepository = false; $('#repository-inspection-status').textContent = ''; updateChrome(); }
    saveSession();
  });
  function updateExecutionForm() { $('#model-form').hidden = $('#task-execution').value !== 'model'; updateModelBudget(); }
  $('#task-source').addEventListener('change', () => {
    const source = $('#task-source').value;
    if (!activateComposer(source)) return;
    updateChrome(); saveSession();
  });
  $('#task-execution').addEventListener('change', () => { if (pendingModelStart) $('#task-execution').value = 'model'; updateExecutionForm(); updateChrome(); });
  function modelInput() {
    return { candidates: Number($("#model-candidates").value), limits: {
      maxRequests: Number($("#model-requests").value), maxOutputTokens: Number($("#model-output").value),
      timeoutMs: Number($("#model-seconds").value) * 1000, maxInputBytes: Number($("#model-input").value),
    } };
  }
  function updateModelBudget() {
    if (pendingModelStart) {
      const {candidates,limits} = pendingModelStart.body;
      for (const [name,value] of Object.entries({candidates,requests:limits.maxRequests,output:limits.maxOutputTokens,seconds:limits.timeoutMs/1000,input:limits.maxInputBytes}))
        $('#model-'+name).value = String(value);
    }
    const { candidates, limits } = modelInput();
    $("#model-budget").textContent = `Total allowance: at most ${candidates * limits.maxRequests} requests and ${candidates * limits.maxRequests * limits.maxOutputTokens} output tokens. Input is limited to ${limits.maxInputBytes} bytes per request. These are execution limits, not a dollar estimate.`;
  }
  $("#model-form").addEventListener("input", updateModelBudget);
  updateModelBudget();

  $('#task-form').addEventListener('submit', createWorkbenchTask);
  $('#release-task-request').addEventListener('click', releaseRequest);
  $('#open-saved-project').addEventListener('click', () => {
    const source = $('#task-source').value;
    if (!taskStarting && source.startsWith('project:')) void selectProject(source.slice(8));
  });
  return {update, restore, snapshot, activate: activateComposer,
    get starting() { return taskStarting; }, get locked() { return taskStarting || pendingRequest(); }};
}
