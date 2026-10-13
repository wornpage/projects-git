import {createWorkbenchParts, mergeStatusNotice} from './ui/workbench-parts.js';
import {createRetainedSearch} from './ui/retained-search.js';
import {createTaskViews} from './ui/views/queue.js';
import {createWorkView} from './ui/views/work.js';
import {createReviewView} from './ui/views/review.js';
import {createEvidenceView} from './ui/views/evidence.js';
import {$, el, shortSha, dateTime, timeOnly, explainDisabledButtons, panel, captureFocus, restoreFocus} from './ui/dom.js';
import {createApiClient} from './api-client.js';
import {createWorkspaceConnection} from './workspace-connection.js';
import {parseWorkspacePage, projectWorkspace} from './workspace-page.js';
import {createWorkbenchActions, sha256Text} from './workbench-actions.js';
import {createDialogManager} from './ui/dialogs.js';
import {createErrorNotice} from './ui/error-notice.js';
import {createNavigation} from './ui/navigation.js';
import {createCompactNavigation} from './ui/compact-navigation.js';
import {createProjectDiscovery} from './ui/project-discovery.js';
import {createCollectionPager} from './ui/collection.js';
import {createContinuationDialog} from './ui/continuation-dialog.js';
import {createRequirementsForm} from './ui/requirements-form.js';
import {createBrowserSession} from './browser-session.js';
import {createTaskCreation} from './ui/task-creation.js';
import {createReviewForm} from './ui/review-form.js';
import {createPublicationView} from './ui/publication.js';
import {createProjectControls, automaticMergeControls} from './ui/project-controls.js';
import {createProjectsView} from './ui/views/projects.js';
import "./vendor/wornpage-button-0.2.3/worn-button.js";
import { independentlyVerified as verifiedAtCurrentHead, connectionLabel, mergeState, workspacePresentationKey, taskOutcome, projectContext, dependencyState, readLocation, locationSearch } from './workbench-state.js';
import { localAgentInstructions, hostedAgentInstructions } from './agent-instructions.js';

const content = $("#content");
const demo = document.body.dataset.demo === 'read-only' ? await import('./demo/client.js') : null;
if(demo)demo.installDemoGuide(document,{onOpen:body=>{
  openInspector('Example guide',body);
  demo.updateDemoGuide(document,{view,taskId:selectedTask,runId:selectedRun,hash:location.hash});
}});
const errorNotice = createErrorNotice(document);
const drafts = new Map();
const disclosures = new Map();
const verificationDrafts = new Map();
const assignmentRequests = new Map();
const operationRequests = new Map();
const actionFeedback = new Map();
const projectSelections = new Map();
const retainedSearches = new Map();
let navigationKey = '', projectHeaderKey = '';
// One-time fork credentials stay in this tab's memory, never in saved drafts.
const forkCredentials = new Map();
const initialLocation = readLocation(location.search);
let workspace = null;
let view = initialLocation.view;
let selectedTask = initialLocation.taskId;
let selectedProject = initialLocation.projectId;
let selectedRun = initialLocation.runId;
let projectOffset = Math.max(0, Number(new URLSearchParams(location.search).get('offset')) || 0);
let pageRevision = null;
function workspacePath() {
  if (['queue','history'].includes(view) && selectedProject) return '/api/workspace?limit=1&project='+encodeURIComponent(selectedProject);
  if (view !== 'projects' && selectedTask) return '/api/workspace?limit=1&task='+encodeURIComponent(selectedTask);
  return '/api/workspace?limit=10&offset='+projectOffset+(pageRevision===null?'':'&at='+pageRevision);
}
let renderKey = "";
let lastError = "";

// Compose UI owners here; they receive current state and explicit operations.
function getContext() { return {workspace, view, selectedProject, selectedTask, selectedRun, demo:Boolean(demo), busy: actions.busy, sessionWarning: browserSession.warning}; }
const api = demo ? demo.createDemoApi() : createApiClient({captureSession: () => connection.captureSession(), onAuthRequired: () => {
  for(const dialog of document.querySelectorAll('dialog[open]')) { dialogs.skipFocusRestore(dialog.id); dialog.close(); }
  $('#auth-panel').hidden = false;
  $('#auth-panel').querySelector('a').focus();
}});
const connection = createWorkspaceConnection({api, getWorkspace: () => workspace, setWorkspace: value => { workspace = value; },
  getPath: workspacePath,
  normalizeSnapshot: value => value.page ? value : projectWorkspace(value,{...parseWorkspacePage(workspacePath().split('?')[1]),at:null},value.sourceRevision??value.version),
  activity: () => ({taskStarting: taskCreation.starting, active: workspace?.runs.some(run => mergeState(workspace, run) === 'running' || run.verificationPending || ['assigned','running'].includes(run.status))}),
  onChange: updateChrome, onSnapshot: workspaceReceived, onError: connectionFailed});
const {refresh, schedulePoll} = connection;
const actions = createWorkbenchActions({getContext, captureSession: connection.captureSession, applySnapshot: connection.applySnapshot,
  getPath: workspacePath, refresh,
  api, actionFeedback, operationRequests, saveSession, render, clearError, showError, announce,
  captureActionFocus:()=>captureFocus(document.body), restoreActionFocus:restoreFocus});
const {mutate, runOperation, actionKey} = actions;
const dialogs = createDialogManager(document);
dialogs.register('project-connection-dialog');
dialogs.register('inspector-dialog',()=>!actions.busy);
dialogs.register('task-launcher',()=>!taskCreation.starting);
$('#close-inspector').addEventListener('click',()=>{if(!actions.busy)$('#inspector-dialog').close();});
$('#close-task-composer').addEventListener('click',()=>{if(!taskCreation.starting)$('#task-launcher').close();});
const projectDiscovery=createProjectDiscovery({getContext,api,captureSession:()=>connection.captureSession(),onChange:()=>updateChrome()});
const compactNavigation=createCompactNavigation({document,getWorkspace:()=>workspace,openInspector,onRestore:()=>{
  navigationKey=null;if(workspace)updateProjectNavigation();
}});
const collections=createCollectionPager({getScope:()=>JSON.stringify([workspace.id,workspace.authentication?.principal??null]),render});
createNavigation({getContext, dialogs, announce, selectProject, switchView, projectDiscovery});
const {openContinuation} = createContinuationDialog({getContext, api, dialogs, showError});
const {openRevision, renderRevisionPreview} = createRequirementsForm({getContext, api, dialogs, refresh, announce});
const browserSession = createBrowserSession({drafts, disclosures, assignmentRequests, operationRequests, projectSelections, onWarning: showError});
const taskCreation = createTaskCreation({getContext, currentProject,
  selectTask: taskId => { selectedTask = taskId; selectedRun = null; }, switchView, api, refresh,
  render, updateChrome, schedulePoll, saveSession, clearError, showError, announce});
const parts = createWorkbenchParts({getContext, disclosure, currentRun, taskRuns, collections,
  switchView, showError, announce, independentlyVerified, checksFailed, openInspector});
const {loadIndexedSearch, rebuildSearch} = createRetainedSearch({getContext, retainedSearches, currentProject, api, render, announce, showError});
const {reviewPanel} = createReviewForm({getContext, drafts, api, mutate, refresh, saveSession, showError,
  getReviewerName: browserSession.getReviewerName, rememberReviewerName: browserSession.rememberReviewerName,
  runCoordination, comparisonKey, comparisonHeads, acceptanceReady, disclosure, evidenceChecks: parts.evidenceChecks, diffPanel: parts.diffPanel, switchView});
const publicationPanel = createPublicationView({getContext, captureSession:connection.captureSession, api, mutate, refresh, openInspector});

const taskViews = createTaskViews({getContext, parts, disclosure, currentProject, currentTask, tasksInProject, taskRuns, taskNumber,
  switchView, selectProject, openTaskComposer, openRevision, openInspector, downloadHandoff, collections, openAgentConnection});
const views = {
  projects: createProjectsView({getContext, disclosure, getProjectSelection:id=>projectSelections.get(id), selectProject, switchView, openTaskComposer, changeProjectPage, createStarter: async () => {
    const result = await mutate(() => api("/api/workspace/starter", {expectedWorkspaceId:workspace.id}), "Your starter project is ready.");
    if (result) await refresh(true);
  }}),
  queue: taskViews.queue,
  overview: taskViews.task,
  work: createWorkView({getContext, parts, disclosure, currentTask, currentRun, taskRuns, repositoryAgents, taskSettings, externalHandoff, collections,
    switchView, openContinuation, checksFailed, independentlyVerified, openInspector, openAgentConnection,
    hasPendingAssignment:taskId=>assignmentRequests.has(taskId)}),
  review: createReviewView({getContext, parts, disclosure, currentTask, currentRun, taskRuns, reviewPanel, publicationPanel, downloadReviewContext,
    verificationDrafts, actionFeedback, actionKey, actionNotice, mutate, runOperation, sha256Text, refresh, finishBaseUpdate, openContinuation, independentlyVerified, openInspector, onSectionChange:updateChrome, switchView, captureReviewSurface}),
  evidence: createEvidenceView({getContext, parts, disclosure, currentProject, currentTask, currentRun, taskNumber,
    retainedSearches, loadIndexedSearch, rebuildSearch, render, announce, switchView, downloadEvidence, independentlyVerified, checksFailed, collections}),
};
views.history = views.evidence;
const viewTitles = {
  projects: ["Projects", "Projects", "Your code, queued work and decisions stay together."],
  queue: ["Task queue", "Task queue", "All tasks in this project. Open a task for its requirements and candidates."],
  history: ["Project history", "Project history", "All retained candidates and activity in this project."],
  overview: ["Task details", "Task details", "The agreed work, current requirements and next step."],
  work: ["Candidates", "Candidates", "All candidates for this task. Open one to inspect its changes and checks."],
  review: ["Candidate", "Candidate", "One candidate: changes, checks, independent review and integration status."],
  evidence: ["Candidate record", "Candidate record", "Retained reports and decisions for this candidate."],
};

function taskNumber(task) { return workspace.page?.taskNumbers?.[task.id] ?? workspace.tasks.findIndex(entry => entry.id === task.id) + 1; }
function runCoordination(run) { return workspace.coordination?.[run.id]; }
function comparisonHeads(run) { return (runCoordination(run)?.overlaps ?? []).map(({ runId, headCommit }) => ({ runId, headCommit })).sort((a, b) => a.runId.localeCompare(b.runId)); }
function comparisonKey(run) { return JSON.stringify(comparisonHeads(run)); }
function taskRuns(taskId) { return workspace.runs.filter((run) => run.taskId === taskId); }
function currentTask() { return workspace.tasks.find((task) => task.id === selectedTask); }
function currentRun() {
  const task = currentTask();
  const runs = task ? taskRuns(task.id) : [];
  return runs.find((run) => run.id === selectedRun);
}
function independentlyVerified(run) {
  return verifiedAtCurrentHead(workspace, run);
}
function acceptanceReady(run) {
  const evidence = run.evidence;
  return Boolean(independentlyVerified(run) && evidence.total > 0 && evidence.passed === evidence.total && evidence.checks.length === evidence.total && evidence.checks.every((check) => check.passed));
}
function checksFailed(run) {
  const evidence = run.evidence;
  return Boolean(evidence && (evidence.passed < evidence.total || evidence.checks.some((check) => !check.passed)));
}
function recoveryAlert() {
  return mergeStatusNotice(workspace, String);
}
function announce(message) { $("#announcement").textContent = message; }
function showError(message, focus) {
  lastError = message;
  errorNotice.show(message, focus?.id);
}
function clearError() { lastError = ""; errorNotice.clear(); }

function openInspector(title,...body) {
  const opener=document.activeElement;
  if (document.querySelector('dialog[open]') && !$('#inspector-dialog').open) return;
  const restoredNavigation=compactNavigation.restore();
  $('#inspector-title').textContent=title;
  $('#inspector-content').replaceChildren(...body);
  if (!$('#inspector-dialog').open) dialogs.show('inspector-dialog','#close-inspector',opener);
  else if(restoredNavigation) $('#close-inspector').focus();
}

function captureReviewSurface() {
  const isCurrent=connection.captureSession(), surfaces=[...document.querySelectorAll('dialog[open]')];
  const contents=[...$('#inspector-content').childNodes], focusId=document.activeElement?.id;
  const sameNodes=(saved,current)=>saved.length===current.length&&saved.every((node,index)=>node===current[index]);
  return ()=>isCurrent()&&document.activeElement?.id===focusId
    &&sameNodes(surfaces,[...document.querySelectorAll('dialog[open]')])
    &&sameNodes(contents,[...$('#inspector-content').childNodes]);
}

function actionNotice(key) {
  const state=actionFeedback.get(key);
  if (!state) return null;
  return el('div',{class:'action-notice action-' + state.phase,role:state.phase==='error'?'group':'status','aria-live':state.phase==='error'?'off':'polite','aria-atomic':'true'},
    el('strong',{},state.phase==='pending' ? 'In progress' : state.phase==='error' ? 'Request needs attention' : 'Request recorded'),
    el('p',{},state.message),
    state.phase==='error' ? el('p',{class:'small'},state.uncertain ? 'The outcome is not confirmed. Refresh status before trying the action again.' : 'Review the message and current state before trying the action again.') : null,
    state.phase==='error' ? el('button',{type:'button',class:'button button-small',disabled:connection.state.loading,onclick:()=>refresh(true)},'Refresh status') : null);
}
function updateConnectionStatus() {
  const {error: connectionError, lastSyncedAt, lastSyncedVersion} = connection.state;
  const status=$('#connection-status');
  const label = demo ? 'Read-only example' : connectionLabel(connection.state);
  if (status.textContent !== label) status.textContent = label;
  status.classList.toggle('live',Boolean(lastSyncedAt && !connectionError));
  $('#last-updated').textContent=demo ? 'Invented example records · no live operations' : lastSyncedAt ? `Last synced ${timeOnly(lastSyncedAt)} · v${lastSyncedVersion}` : 'Waiting for workspace';
}

function saveSession() { browserSession.save(taskCreation.snapshot()); }
function loadSession() {
  const saved = browserSession.enter(workspace);
  if (!saved.changed) return;
  clearError();
  if (browserSession.warning) showError(browserSession.warning);
  actions.reset(); forkCredentials.clear(); retainedSearches.clear();
  navigationKey = ''; projectHeaderKey = '';
  taskCreation.restore(saved.composer);
  if ($('#project-connection-dialog').open) $('#project-connection-dialog').close();
  for(const id of ['inspector-dialog','task-launcher']) if ($('#'+id).open) { dialogs.skipFocusRestore(id); $('#'+id).close(); }
}
function disclosure(key, title, ...body) {
  const node = el('details', { id: key, class: 'context-disclosure', open: disclosures.get(key) === true }, el('summary', { id: `${key}-summary` }, title), ...body);
  node.addEventListener('toggle', () => {
    if (!node.isConnected) return;
    disclosures.set(key, node.open);
    saveSession();
  });
  return node;
}
function saveLocation(push = false) {
  const next = locationSearch(view, selectedTask, selectedRun, selectedProject)+(view==='projects'&&projectOffset?'&offset='+projectOffset:'');
  if (next !== location.search) history[push ? 'pushState' : 'replaceState'](null, '', next);
}

function updateChrome() {
  if(demo)demo.updateDemoGuide(document,{view,taskId:selectedTask,runId:selectedRun,hash:location.hash});
  $('#adopt-owner').disabled = actions.busy;
  $('#revoke-sessions').disabled = actions.busy;
  $('#inspector-content').disabled = actions.busy;
  $('#close-inspector').disabled = actions.busy;
  $('#open-workspace-navigation').disabled = !workspace;
  $('#inspector-pending').hidden = !actions.busy;
  const [label, title, subtitle] = viewTitles[view];
  const task = workspace ? currentTask() : null,run=workspace ? currentRun() : null,taskView=!['projects','queue','history'].includes(view);
  const heading = ['review','evidence'].includes(view) && run ? run.label : taskView && task ? task.title : title;
  if ($("#view-name").textContent!==label) $("#view-name").textContent=label;
  $('#view-crumb').hidden=view==='projects';
  if ($("#page-title").textContent!==heading) $("#page-title").textContent=heading;
  $("#page-kicker").textContent = taskView && task ? 'TASK '+taskNumber(task)+' · '+label : view==='projects' ? 'PROJECT LIST' : view==='queue' ? 'TASK LIST' : 'PROJECT HISTORY';
  $("#page-subtitle").textContent = taskView ? label+' · '+subtitle : subtitle;
  $('#page-kicker').hidden=!taskView;
  $('#page-subtitle').hidden=view!=='projects';
  $('#main').classList.toggle('compact-view', view !== 'overview' || Boolean(workspace?.tasks.length));
  $('#new-project').disabled = !workspace || taskCreation.starting;

  for (const button of document.querySelectorAll(".nav-item")) {
    const active = button.dataset.view === view;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  if (!workspace) return;
  $('#workspace-home').setAttribute('aria-current',view==='projects'?'page':'false');
  $('#project-total').textContent=workspace.page?.totalProjects??Object.keys(workspace.projects??{}).length;
  updateProjectNavigation();
  updateProjectHeader();
  const local = workspace.provider === "local-git";
  $("#workspace-name").textContent = workspace.name;
  $("#provider-label").textContent = demo ? 'Example records' : local ? "Local Git workspace" : "Cloudflare Artifacts";
  $("#provider-dot").classList.toggle("connected", !connection.state.error);
  const project = currentProject();
  const context = project ? projectContext(workspace, project.id) : null;
  $('#task-views').hidden = !currentTask();
  $('#candidate-views').hidden = !currentRun();
  $('#task-count').textContent = context?.tasks.length ?? 0;
  const candidateCount = currentTask() ? taskRuns(currentTask().id).length : 0;
  $("#work-count").textContent = candidateCount;
  $("#work-count").setAttribute('aria-label',candidateCount+' retained candidates for this task');
  const pendingTasks = context?.reviewTasks.length ?? 0;
  $("#review-count").textContent = pendingTasks;
  $("#review-count").setAttribute('aria-label', `${pendingTasks} project tasks needing review or merge`);
  taskCreation.update();
  $('#new-project').hidden = Boolean(workspace.authentication && !workspace.authentication.permissions.manage);
  $('#task-launcher').hidden = Boolean(workspace.authentication && !workspace.authentication.permissions.manage);
  updateConnectionStatus();
  explainDisabledButtons();
}

function render(force = false) {
  updateChrome();
  if (!workspace) return;
  const key = `${workspacePresentationKey(workspace)}:${view}:${selectedTask}:${selectedRun}:${actions.busy}`;
  if (!force && key === renderKey) return;
  renderKey = key;
  const focus = captureFocus(content);
  for (const details of content.querySelectorAll('details[id]')) disclosures.set(details.id, details.open);
  const node = views[view](), recovery = recoveryAlert(), task=currentTask(), project=currentProject();
  const back = task ? el('nav',{class:'scope-return','aria-label':'Return to collection'},
    el('button',{class:'text-link',onclick:()=>view==='overview'||view==='work'?selectProject(project.id):switchView('work',task.id,null)},
      view==='overview'||view==='work'?'← Task queue':'← All candidates')) : null;
  content.replaceChildren(...[recovery,node,back].filter(Boolean));
  content.setAttribute("aria-busy", "false");
  explainDisabledButtons();
  restoreFocus(focus);
}

async function switchView(next, taskId = selectedTask, runId = selectedRun, {preservePosition=false,section=null,projectId=null}={}) {
  const reviewSection = next === 'review' && ['candidate-changes','verification','code-review','review-decision'].includes(section) ? section : null;
  if (next === view && taskId === selectedTask && runId === selectedRun && (!projectId || projectId===selectedProject) && !reviewSection) return;
  rememberProjectSelection();
  const previousSelection={view,selectedProject,selectedTask,selectedRun};
  const previousPath = workspacePath();
  if ($('#task-launcher').open) $('#task-launcher').close();
  if ($('#project-connection-dialog').open) $('#project-connection-dialog').close();
  if ($('#continuation-dialog').open) $('#continuation-dialog').close();
  if ($('#inspector-dialog').open) { dialogs.skipFocusRestore('inspector-dialog'); $('#inspector-dialog').close(); }
  selectedProject = projectId ?? workspace.tasks.find(task=>task.id===taskId)?.projectId ?? selectedProject;
  view = next; selectedTask = taskId; selectedRun = ['review','evidence'].includes(next) ? runId : null;
  if(['projects','queue','history'].includes(next)){selectedTask=null;selectedRun=null;}
  if(next==='projects') selectedProject=null;
  if ((workspacePath() !== previousPath || next!=='projects' && taskId && !workspace.tasks.some(task=>task.id===taskId)) && !await refresh(true)) {
    ({view,selectedProject,selectedTask,selectedRun}=previousSelection);
    render(true);
    return;
  }
  selectedRun = currentRun()?.id ?? null;
  saveLocation(true);
  if(reviewSection) history.replaceState(history.state, '', locationSearch(view, selectedTask, selectedRun, selectedProject) + '#' + reviewSection);
  render(true);
  const target = reviewSection && document.getElementById(reviewSection);
  if(target){
    target.focus({preventScroll:true});
    target.scrollIntoView({block:'start',behavior:'instant'});
  }else if(!preservePosition){
    const heading = $("#page-title");
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
    ($('#project-header').hidden ? heading : $('#project-header')).scrollIntoView({ block: "start", behavior: "instant" });
  }
  announce(`${viewTitles[next][0]} view opened.`);
}
function rememberProjectSelection() {
  const task=currentTask();
  if (view!=='projects' && task) {
    projectSelections.set(task.projectId,{taskId:task.id,runId:currentRun()?.id??null});
    saveSession();
  }
}
function currentProject() { return view==='projects' ? null : workspace?.projects?.[currentTask()?.projectId ?? selectedProject]; }
async function changeProjectPage(offset, fresh=false) {
  if(actions.busy) return;
  const previous = projectOffset;
  projectOffset = offset; pageRevision = fresh ? null : workspace.page?.revision ?? null;
  if(!await refresh(true)) projectOffset = previous;
  pageRevision = null;
  saveLocation(true);
}
function tasksInProject(project) { return workspace.tasks.filter(task => task.projectId === project?.id); }
async function selectProject(projectId) {
  rememberProjectSelection();
  await switchView('queue', null, null, {projectId});
  if(currentProject()?.id!==projectId)return;
  if (!taskCreation.locked) taskCreation.activate('project:' + projectId);
  void projectDiscovery.sync(projectId);
}
function projectPicker() {
  const project = currentProject(), projects = Object.values(workspace.projects ?? {});
  const totalProjects = workspace.page?.totalProjects ?? projects.length;
  if (totalProjects < 2) return null;
  return el('div', { class: 'project-selector shell-project-picker' }, el('label', { for: 'shell-project-selection' }, 'PROJECT'),
    el('select', { id: 'shell-project-selection', onchange: event => {
      if (event.target.value === 'all') { switchView('projects'); }
      else selectProject(event.target.value);
    } }, projects.map(item => el('option', { value: item.id, selected: item.id === project?.id,
      disabled:Boolean(workspace.authentication && !workspace.authentication.permissions.manage && !tasksInProject(item).length) }, item.name)),
      totalProjects > projects.length ? el('option',{value:'all'},'Browse all '+totalProjects+' projects…') : null));
}
function updateProjectNavigation() {
  const project = currentProject(), projects = projectDiscovery.items().slice();
  if(project&&!projects.some(item=>item.id===project.id))projects.unshift({id:project.id,name:project.name,taskCount:tasksInProject(project).length});
  projects.splice(8);
  const key = JSON.stringify([workspace.id, project?.id, projects.map(item => [item.id, item.name, item.taskCount,projectDiscovery.pinned(item.id)]),projectDiscovery.error()]);
  $('#project-views').hidden = !project;
  if (key === navigationKey) return;
  navigationKey = key;
  const nav = $('#project-views'), focus = document.activeElement?.id;
  const groups = projects.map(item => {
    const chosen = item.id === project?.id;
    const count = item.taskCount;
    const button = el('button', { id: 'project-link-' + item.id, type: 'button', class: 'project-link', 'aria-current': chosen ? 'true' : null,
      'aria-controls': chosen ? 'project-views' : null, onclick: () => selectProject(item.id) },
      el('span', { class: 'project-nav-icon', 'aria-hidden': true }, '◫'), el('span', {}, item.name), el('span', { class: 'project-task-count' }, count + (count === 1 ? ' task' : ' tasks')));
    return el('div', { class: 'project-nav-group' + (chosen ? ' selected' : '') }, button,
      el('button',{class:'project-pin',type:'button','aria-label':(projectDiscovery.pinned(item.id)?'Unpin ':'Pin ')+item.name,'aria-pressed':projectDiscovery.pinned(item.id),onclick:()=>projectDiscovery.togglePin(item.id)},projectDiscovery.pinned(item.id)?'Pinned':'Pin'),chosen && !compactNavigation.isOpen() ? nav : null);
  });
  if (!project && !compactNavigation.isOpen()) $('#new-project').before(nav);
  $('#project-navigation').replaceChildren(...[el('p',{class:'nav-scope-label'},'Recent & pinned'),...groups,
    !groups.length?el('p',{class:'small'},'Open Projects or Find work to choose a project.'):null,
    projectDiscovery.error()?el('p',{class:'small',role:'status'},projectDiscovery.error(),el('button',{class:'text-link',onclick:projectDiscovery.needsReset()?projectDiscovery.reset:projectDiscovery.retry},projectDiscovery.needsReset()?'Reset shortcuts':'Retry shortcuts')):null].filter(Boolean));
  if (focus?.startsWith('project-link-')) document.getElementById(focus)?.focus({preventScroll:true});
}
function admissionSwitch(project) {
  return el('button', { id: 'shell-admission', class: 'project-switch', role: 'switch', 'aria-checked': project.acceptingWork,
    disabled: actions.busy || project.codeConnected === false || workspace.authentication && !workspace.authentication.permissions.manage, title: actions.busy ? 'Wait for the current action.' : project.codeConnected === false ? 'Restore this project’s code before admitting agent work.' : 'The owner controls new checkouts and starts. Existing running agents continue in their chat host.',
    onclick: () => mutate(() => api('/api/projects/' + project.id + '/policy', { acceptingWork: !project.acceptingWork, expectedVersion: project.policyVersion }), project.acceptingWork ? 'New agent work paused. Existing work can finish.' : 'New agent work enabled.') },
    el('span', { class: 'switch-track', 'aria-hidden': true }, el('span')), 'Accept new agent work', el('strong', {}, project.acceptingWork ? 'On' : 'Off'));
}
function updateProjectHeader() {
  const project = currentProject(), header = $('#project-header');
  $('#project-breadcrumb').textContent = project?.name ?? workspace.name;
  header.hidden = !project;
  if (!project) { projectHeaderKey = ''; header.replaceChildren(); return; }
  const key = JSON.stringify([workspace.id, workspace.provider, workspace.page?.totalProjects, project.id, project.name, project.repositoryName, project.mainCommit, project.defaultBranch, project.acceptingWork, project.policyVersion, project.automaticMergePolicy, project.codeConnected, workspace.authentication?.permissions, actions.busy, Object.values(workspace.projects ?? {}).map(item => [item.id, item.name])]);
  if (key === projectHeaderKey) return;
  const focused = document.activeElement?.id;
  projectHeaderKey = key;
  const controlsId = 'project-controls-' + project.id;
  const controls = createProjectControls({id: controlsId, onOpen: (body,opener)=>openInspector('Project settings · '+project.name,body)},
    demo || workspace.personalWorkspace?.agentConnections === false ? null : el('button', { id: 'shell-connect-agent', class: 'button button-small', onclick: () => openAgentConnection(project.id, $('#shell-project-controls')) }, 'Connect agent'), admissionSwitch(project),
    automaticMergeControls({project, hosted:!demo && workspace.authentication?.mode === 'cloudflare-access', canManage:workspace.authentication?.permissions.manage,
      busy:actions.busy, onChange:(enabled, expectedVersion) => mutate(() => api('/api/projects/' + project.id + '/automatic-merge', {enabled, expectedVersion}),
        enabled ? 'Automatic approval and merge enabled for eligible changes in this project.' : 'Automatic approval and merge disabled. Inspect any in-progress merge separately.')}),
    el('p', {class: 'small'}, 'Your coding chat runs the agents. This project keeps their tasks, changes, checks and your decisions together.'));
  $('#inspector-content').querySelector('#'+controlsId)?.replaceWith(controls.panel);
  header.replaceChildren(...[projectPicker(),
    el('div', { class: 'project-shell-title' }, el('strong', {}, project.name), el('span', { class: 'project-code' }, (project.defaultBranch ?? (workspace.provider === 'local-git' ? 'main' : 'default branch')) + ' · ' + shortSha(project.mainCommit) + (project.acceptingWork ? '' : ' · Assignments paused'))),
    el('div', { class: 'project-shell-actions' },
      el('button', { id: 'shell-new-task', class: 'button button-primary button-small', hidden: Boolean(workspace.authentication && !workspace.authentication.permissions.manage), onclick: () => openTaskComposer('project:' + project.id) }, '+ New task'),
      controls.trigger)].filter(node=>node!==null));
  if (focused?.startsWith('shell-')) document.getElementById(focused)?.focus({preventScroll:true});
}
function openTaskComposer(source) {
  if (workspace.authentication && !workspace.authentication.permissions.manage) return;
  if (!taskCreation.locked && source && !taskCreation.activate(source)) return;
  let opener = document.activeElement;
  if (compactNavigation.isOpen()) {
    opener = $('#open-workspace-navigation');
    dialogs.skipFocusRestore('inspector-dialog');
    $('#inspector-dialog').close();
    compactNavigation.restore();
  }
  if (!$('#task-launcher').open) dialogs.show('task-launcher','#new-task-summary',opener);
  updateChrome();
  $('#new-task-summary').focus();
}
function openAgentConnection(projectId, opener = document.activeElement) {
  const project = workspace.projects[projectId];
  if (!project) throw new Error('The selected project is no longer available.');
  if ($('#inspector-dialog').open) { dialogs.skipFocusRestore('inspector-dialog'); $('#inspector-dialog').close(); }
  $('#project-connection-title').textContent = 'Connect agent · ' + project.name;
  $('#project-connection-content').replaceChildren(projectConnection(project));
  dialogs.show('project-connection-dialog', '#close-project-connection', opener);
}
function projectConnection(project) {
  const hosted = workspace.provider === 'cloudflare-artifacts';
  const instructions = workspace.provider === 'local-git'
    ? localAgentInstructions({ projectId: project.id, origin: location.origin, cli: workspace.repositoryWorkflow.cli })
    : hosted && location.protocol === 'https:' ? hostedAgentInstructions({projectId:project.id, workspaceId:workspace.id, origin:location.origin}) : null;
  return el('div', { class: 'connection-dialog-body' },
    el('p', { class: 'project-code' }, 'Code · ' + project.repositoryName + ' / ' + (project.defaultBranch ?? (hosted ? 'default branch' : 'main')) + ' · ' + shortSha(project.mainCommit) + (project.kind === 'sample' ? ' · Sample starter' : hosted ? ' · Artifacts repository' : ' · Workspace copy')),
      el('p', {}, hosted
        ? 'Copy these instructions into your coding chat. The same repository CLI can claim, check out, push and submit hosted work using a private Access connection file. Your chat host runs the agent; four reserved or running assignments share workspace execution capacity.'
        : 'Copy these instructions into your existing coding chat. Use the CLI on this computer in PowerShell 7. Your chat host directs the agent; queueing tasks does not launch a model. Four assigned or running agents can occupy this workspace at once.'),
      instructions ? el('button', { type: 'button', class: 'button button-small', onclick: async () => {
        try { await navigator.clipboard.writeText(instructions); announce('Agent instructions copied. Paste them into your coding chat.'); }
        catch { const message = 'Clipboard is unavailable. Select and copy the agent instructions shown below.'; showError(message); announce(message); }
      } }, 'Copy agent instructions') : null,
      instructions
        ? el('textarea', { class: 'output', readonly: true, rows: '10', spellcheck: 'false', 'aria-label': 'Agent instructions for this project' }, instructions)
        : el('p', {class:'capability-note'}, 'Hosted agent connections require the deployed HTTPS app. This local fixture cannot supply a hosted connection.'),
      hosted ? el('p', {}, 'Use a new UUID for each claim; reuse it only to retry the same claim. This returns work to your agent; it does not launch a model.') : null,
      hosted ? el('p', { class: 'small muted' }, 'The owner configures an allowlisted Access service identity separately. Keep the connection file and client receipt directory private and outside Git. The client saves temporary Git credentials there, never in stdout, Git URLs or Git configuration, and removes them after confirmed submission or failure.') : null,
      el('p', { class: 'small muted' }, 'Admission controls new checkouts and starts. Pause running agents through your chat host; existing submissions, checks and review can continue.'));
}
function taskSettings(task) {
  return el('button',{id:'settings-'+task.id,type:'button',class:'button button-small',
    onclick:()=>openInspector('Task settings · '+task.title,ownershipPanel(task),
      el('button',{class:'button button-small',disabled:actions.busy||task.status==='merged'||!workspace.capabilities?.revise,
        onclick:()=>{dialogs.skipFocusRestore('inspector-dialog');$('#inspector-dialog').close();$('#settings-'+task.id)?.focus();openRevision(task);}},'Revise requirements'))},'Task settings');
}
function repositoryAgents(task) {
  if (!['connected-git', 'artifacts'].includes(task.origin)) return null;
  if (workspace.authentication && !workspace.authentication.permissions.manage) return null;
  const hosted = workspace.provider === 'cloudflare-artifacts';
  const paused = workspace.projects?.[task.projectId]?.acceptingWork === false;
  const dependency = dependencyState(workspace, task);
  const disabled = actions.busy || paused || !dependency.ready || task.acceptedRunId || task.mergedCommit || workspace.repositoryWorkflow?.busyTaskIds.includes(task.id);
  if (workspace.personalWorkspace && !workspace.personalWorkspace.agentConnections) return panel('Agent connections', el('div', {class:'panel-body'}, el('p',{},'This isolated trial has no connected agents or model key. You can edit the queue, requirements and project policy; creating tasks does not start an agent.')));
  const pending = assignmentRequests.get(task.id);
  const feedbackKey=actionKey('assignment',task);
  const client = workspace.authentication ? el('select', {id:'agent-client',required:true,disabled:Boolean(pending)}, el('option',{value:''},'Choose an Access agent client'), workspace.authentication.agentClientIds.map(id=>el('option',{value:id,selected:pending?.agentClientId===id},id))) : null;
  const name = el('input', { id: 'agent-label', maxlength: '160', required: true, readonly: Boolean(pending), value: pending?.label ?? '', placeholder: 'For example: Codex · validation approach' });
  return panel('Agent assignments', el('div', { class: 'panel-body' },
    !dependency.ready ? el('p', { class: 'capability-note' }, dependency.invalid ?? 'Wait for prerequisite integration before preparing agent code access.') : null,
    el('p', { class: 'small' }, hosted ? 'Prepare an isolated Artifacts fork. Your agent clones it, reports its start, and submits a Git commit. Fork access is issued once and expires after 15 minutes.' : 'Prepare one isolated checkout for this task. Give it to your coding agent, which reports its start and submits a Git commit using the handoff commands.'),
    el('form', { class: 'assignment-form', onsubmit: async event => {
      event.preventDefault(); if (disabled) return;
      const isCurrent = connection.captureSession(), retrying = assignmentRequests.has(task.id);
      const form = event.currentTarget, inspector = form.closest('dialog');
      const request = assignmentRequests.get(task.id) ?? { label: name.value.trim(), ...(client ? {agentClientId: client.value} : {}), requestId: crypto.randomUUID() };
      assignmentRequests.set(task.id, request); saveSession();
      const result = await mutate(async () => {
        try {
          const result = await api('/api/tasks/' + task.id + '/agents', request, request.requestId);
          if (result?.taskId !== task.id || !/^[a-f0-9-]{36}$/.test(result?.runId ?? '')) {
            const error = new Error('The server did not confirm this assignment. Inspect its saved outcome before preparing another.');
            error.uncertain = true; throw error;
          }
          return result;
        }
        catch (error) {
          if (retrying) error.uncertain = true;
          else if (isCurrent() && assignmentRequests.get(task.id) === request && error.status >= 400 && error.status < 500 && !['assignment_preparing', 'repository_busy', 'ASSIGNMENT_PREPARING', 'OPERATION_IN_PROGRESS'].includes(error.code)) { assignmentRequests.delete(task.id); saveSession(); }
          throw error;
        }
      }, hosted ? 'Agent fork prepared. Give its handoff to your agent.' : 'Agent checkout prepared. No model was started.',
        {key:feedbackKey,pending:hosted ? 'Preparing isolated code access. Your coding agent starts work after receiving the handoff.' : 'Preparing an isolated checkout. This does not start a model.'});
      if (result) {
        if (result.credentials) forkCredentials.set(result.runId, result.credentials);
        assignmentRequests.delete(task.id); saveSession(); selectedRun = result.runId; await refresh(true);
        if (isCurrent()) {
          saveLocation();
          if (inspector?.open && inspector.contains(form)) inspector.close();
        }
      }
    } }, el('label', { for: 'agent-label' }, 'Agent or approach name'), name, client ? el('label', {for:'agent-client'}, 'Access agent client') : null, client,
      el('button', { id:'assign-'+task.id, type: 'submit', class: 'button button-primary', disabled, title: !dependency.ready ? dependency.invalid ?? 'Wait for prerequisite integration before preparing this checkout.' : paused ? 'New agent work is paused. Enable it in the project home.' : disabled ? 'Assignments close when a candidate is chosen, or while an operation is in progress.' : 'Prepare isolated code access without starting a model.' }, actionFeedback.get(feedbackKey)?.phase==='pending' ? 'Preparing code access…' : pending ? 'Retry same assignment' : hosted ? 'Prepare agent fork' : 'Prepare checkout')),
    actionNotice(feedbackKey)));
}
function externalHandoff(run) {
  if (run.origin !== 'external-agent') return null;
  if (workspace.provider === 'cloudflare-artifacts') return hostedHandoff(run);
  if (!run.repository) return null;
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  const cli = 'node ' + quote(workspace.repositoryWorkflow.cli);
  const suffix = ' --url ' + quote(location.origin) + ' --run ' + quote(run.id);
  const task = workspace.tasks.find(task => task.id === run.taskId);
  const instructions = 'Task: ' + task.title + '\nPurpose: ' + task.purpose + '\nRequirements r' + task.revision + ':\n' + task.criteria.map(text=>' - '+text).join('\n')
    + '\n\nCheckout: ' + run.repository + '\nBranch: ' + run.branch + '\nBase: ' + run.baseCommit
    + '\n\nReport start:\n' + cli + ' start' + suffix
    + '\n\nCommit your changes, then submit the full Git commit ID:\n' + cli + ' submit' + suffix + ' --head <full-commit-id> --summary "Describe the change"'
    + '\n\nReport an execution failure:\n' + cli + ' fail' + suffix + ' --message "Describe the failure"'
    + (run.reconcilesRunId ? '\n\nResolve the retained change from candidate ' + run.reconcilesRunId + '. Read its diff and original requirements in the task handoff; apply the intended behavior to this new base.\n' + cli + ' show --url ' + quote(location.origin) + ' --task ' + quote(task.id) : '')
    + '\n\nSubmission records code only. Independent checks and a reviewer decision follow in the workspace.\n';
  return disclosure('agent-handoff-' + run.id, 'Checkout and agent handoff',
    el('p', { class: 'head-hint' }, run.repository),
    el('p', { class: 'small muted' }, 'These are PowerShell commands for an agent running on this computer. The app records the activity it reports; preparing a checkout does not launch a model.'),
    el('pre', { class: 'output' }, instructions),
    el('button', { class: 'button button-small', onclick: () => {
      const url = URL.createObjectURL(new Blob([instructions], { type: 'text/plain' }));
      const link = el('a', { href: url, download: 'agent-' + run.id + '.txt' }); document.body.append(link); link.click(); link.remove(); setTimeout(()=>URL.revokeObjectURL(url),1000);
    } }, 'Download agent instructions'));
}
function hostedHandoff(run) {
  const active = ['assigned', 'running'].includes(run.status);
  const credential = forkCredentials.get(run.id);
  const available = active && credential && Date.parse(credential.expiresAt) > Date.now();
  if (!available) forkCredentials.delete(run.id);
  const note = el('input', { id: 'close-reason-' + run.id, maxlength: '2000', required: true, placeholder: 'For example: Agent disconnected before starting' });
  return disclosure('agent-handoff-' + run.id, 'Fork access and agent handoff',
    run.repository ? el('pre', { class: 'output' }, 'Git remote: ' + run.repository + '\nBranch: ' + run.branch + '\nBase: ' + run.baseCommit
      + '\n\nReport start: POST /api/runs/' + run.id + '/start with {}'
      + '\nSubmit commit: POST /api/runs/' + run.id + '/submit with {"headCommit":"<full Git ID>","summary":"<what changed>"}'
      + (run.reconcilesRunId ? '\n\nResolve the intended change from retained candidate ' + run.reconcilesRunId + '. Read its original diff and requirements in GET /api/tasks/' + run.taskId + '/handoff. Start from the new base above and commit the resolution; old approval is not carried forward.' : '')
      + '\n\nAuthenticate API calls with the assigned Access service client. Only that client can start, submit or fail this assignment. For Git, use an ephemeral credential helper scoped to this exact remote: a nonempty username and the token secret before ?expires= as the password. Keep the remote and Git configuration credential-free. Submission does not verify, accept or merge the change.') : el('p', {}, 'Fork preparation has not finished. Retry the same assignment request to recover it. The reserved task cannot be claimed twice.'),
    available ? el('div', {}, el('p', { class: 'small' }, 'Temporary Git access expires ' + dateTime(credential.expiresAt) + '. The token is held only in this tab; refreshing loses it.'),
      el('button', { class: 'button button-small', onclick: async event => {
        if (Date.parse(credential.expiresAt) <= Date.now()) { forkCredentials.delete(run.id); event.currentTarget.disabled=true;
          event.currentTarget.textContent='Git access expired'; showError('This temporary Git credential has expired. Close the assignment and prepare another if fresh access is needed.'); return; }
        try { await navigator.clipboard.writeText(credential.token); announce('Temporary Git token copied. Keep it out of logs and saved configuration.'); } catch { showError('Clipboard access is unavailable. Use the authenticated agent API to receive credentials directly.'); }
      } }, 'Copy temporary Git token')) : active && run.repository ? el('p', { class: 'small muted' }, 'Git credentials were issued once to the assigning client. This page cannot retrieve them again. If that response was lost or access expired, close the assignment and prepare another.') : null,
    active ? el('form', { class: 'assignment-form', onsubmit: async event => {
      event.preventDefault();
      const result = await mutate(() => api('/api/runs/' + run.id + '/fail', { message: note.value.trim() }), 'Assignment closed. Its code and history are retained.');
      if (result) { forkCredentials.delete(run.id); await refresh(true); }
    } }, el('label', { for: note.id }, 'Reason to close unfinished work'), note, el('button', { id:'fail-'+run.id, type: 'submit', class: 'button', disabled: actions.busy }, 'Close assignment')) : null);
}
async function finishBaseUpdate(result, taskId, mode) {
  const isCurrent = connection.captureSession();
  if (result.credentials) forkCredentials.set(result.runId, result.credentials);
  selectedRun = result.runId;
  await refresh(true);
  if (!isCurrent()) return;
  switchView(mode === 'resolve' ? 'work' : 'review', taskId, result.runId);
}
async function downloadHandoff(task) {
  const handoff = await mutate(() => api(`/api/tasks/${encodeURIComponent(task.id)}/handoff`), 'Task handoff prepared. Review its private content before sharing.');
  if (!handoff) return;
  downloadJson(handoff,`projects-git-${task.id}-r${handoff.payload.task.revision}.json`);
}
function downloadJson(data, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function downloadReviewContext(run) {
  const packet=await mutate(()=>api(`/api/runs/${encodeURIComponent(run.id)}/review-context`),'Read-only review context prepared.');
  if(packet)downloadJson(packet,`review-context-${run.id}.json`);
}
function ownershipPanel(task) {
  if (workspace.authentication && !workspace.authentication.permissions.manage) return el('p',{class:'small'},'Coordinator: '+(task.owner ?? 'Not assigned')+'. Managed by the workspace owner.');
  if (!workspace.capabilities?.coordination) return el('p', { class: 'head-hint' }, 'Coordinator and overlap controls require the updated server. This preview is running an earlier backend.');
  const active = taskRuns(task.id).some(run => ['assigned', 'running'].includes(run.status));
  const field = el('input', { id: `owner-${task.id}`, value: task.owner ?? '', maxlength: '100', required: true, placeholder: 'Person or coordinating service', disabled: actions.busy || active || task.status === 'merged' });
  const form = el('form', { class: 'owner-form', onsubmit: async event => {
    event.preventDefault();
    const result = await mutate(() => api(`/api/tasks/${encodeURIComponent(task.id)}/owner`, { owner: field.value.trim(), expectedOwnerVersion: task.ownerVersion ?? 0 }), 'Coordinator updated. Earlier review decisions remain in history.');
    if (result) { await refresh(true); if ($('#inspector-dialog').open) $('#inspector-dialog').close(); }
  } }, el('label', { for: field.id }, 'Coordinator'), field, el('button', { id:'save-owner-'+task.id, type:'submit', class: 'button button-small', disabled: actions.busy || active || task.status === 'merged', title: actions.busy ? 'Wait for the current action to finish.' : active ? 'The coordinator stays fixed until assigned work finishes.' : task.status === 'merged' ? 'The coordinator of merged work remains in its history.' : 'Record the responsible person or agent.' }, 'Save coordinator'));
  return el('div', { class: 'settings-body' }, el('h3', {}, `Coordinator · ${task.owner ?? 'Not assigned'}`), el('p', { class: 'head-hint' }, 'Coordinator version ' + (task.ownerVersion ?? 0)),
    el('p', { class: 'small muted' }, 'The coordinator is a responsibility label, not an authenticated identity or access permission. Changing it invalidates earlier acceptance and requires a fresh review.'),
    active ? el('p', { class: 'small' }, 'The coordinator stays fixed while assigned work finishes.') : null, form,
    workspace.capacity ? el('p', { class: 'head-hint' }, workspace.authentication
      ? `Execution: ${workspace.capacity.occupied}/${workspace.capacity.limit} slots occupied (${workspace.capacity.running} running, ${workspace.capacity.reserved} reserved); ${workspace.capacity.queued} model jobs waiting. Verification: ${workspace.capacity.verification.occupied}/${workspace.capacity.verification.limit} attempts occupied.`
      : `Execution slots: ${workspace.capacity.running}/${workspace.capacity.limit} active · ${workspace.capacity.queued} assigned and waiting`) : null);
}
async function downloadEvidence() {
  if (!workspace) return;
  const isCurrent=connection.captureSession();
  try {
    const complete = await api('/api/workspace');
    if(!isCurrent())return;
    if(complete.page || complete.id!==workspace.id)throw new Error('A complete workspace export was not returned. No partial export was saved.');
    const file = { exportedAt: new Date().toISOString(), provider: complete.provider, workspace:complete };
    downloadJson(file,`projects-git-evidence-${new Date().toISOString().replaceAll(":", "-")}.json`);
    announce("Workspace evidence exported as JSON.");
  }catch(error){showError(error.message);}
}
function workspaceReceived(data, previous, {force, recoveredError}) {
  if(view==='projects' && data.page) projectOffset=data.page.offset;
  pageRevision=null;
  loadSession(); resolveLocation(); saveLocation();
  void projectDiscovery.sync(currentProject()?.id??null);
  $('#auth-panel').hidden = true;
  const identity = $('#identity-status');
  identity.textContent = demo ? 'No sign-in required' : workspace.authentication ? workspace.authentication.principal.kind + ' · ' + workspace.authentication.principal.displayName : 'Local attribution';
  identity.title = identity.textContent;
  $('#workspace-access-controls').hidden = !workspace.authentication?.permissions.manage;
  $('#adopt-owner').hidden = !workspace.authentication?.adoptionRequired;
  for (const run of data.runs) {
    const prior = previous?.runs.find(entry => entry.id === run.id);
    if (prior && prior.status !== run.status && ['awaiting_review','failed'].includes(run.status))
      announce(run.label + ': ' + (run.status === 'awaiting_review' ? 'ready for review' : 'failed') + '.');
  }
  if (recoveredError && lastError === recoveredError.message) clearError();
  render(force);
  if ($('#revision-dialog').open) renderRevisionPreview();
}
function connectionFailed(error) {
  showError(error.message); updateConnectionStatus();
  $('#provider-dot').classList.remove('connected');
  content.setAttribute('aria-busy', 'false');
  const unavailableItem = ['PROJECT_NOT_FOUND','RUN_NOT_FOUND'].includes(error.code);
  if (!workspace) content.replaceChildren(el('div', {class:'panel'}, el('div', {class:'empty-state'},
    el('h2', {}, error.auth ? 'Connect to continue' : unavailableItem ? 'Work unavailable' : 'Workspace unavailable'),
    el('p', {}, error.auth ? 'Sign in through Cloudflare Access to open this workspace.' : unavailableItem ? 'That project or task is not available in this workspace. Open Projects to choose available work.' : 'The workspace could not load. Check the connection, then reconnect.'),
    unavailableItem ? el('a',{class:'button',href:location.pathname+'?view=projects'},'Open Projects')
      : !error.auth ? el('button', {class:'button', onclick: () => refresh(true)}, 'Reconnect') : null)));
}

$('#adopt-owner').addEventListener('click',async()=>{
  if (!workspace?.authentication?.permissions.manage) return;
  const result=await mutate(()=>api('/api/workspace/adopt-owner',{}),'Workspace ownership authenticated. Historical attribution retained.');
  if(result)await refresh(true);
});
$('#revoke-sessions').addEventListener('click',async()=>{
  if (actions.busy || !workspace?.authentication?.permissions.manage || !window.confirm('Revoke all current owner and agent sessions for this workspace? You will need to sign in again. Existing Git credentials and jobs require separate handling.')) return;
  const result=await mutate(()=>api('/api/workspace/revoke-sessions',{}),'Workspace sessions revoked. Sign in again to continue.');
  if(result){forkCredentials.clear();await refresh(true);}
});
for (const button of document.querySelectorAll(".nav-item")) button.addEventListener("click", event => {
  if (button.tagName==='A' && (event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)) return;
  event.preventDefault(); switchView(button.dataset.view);
});
for(const selector of ['#brand-home','#workspace-return']) $(selector).addEventListener('click',event=>{
  if(event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;
  event.preventDefault();switchView('projects');
});
$('#new-project').addEventListener('click', () => openTaskComposer('repository'));
$('#close-project-connection').addEventListener('click', () => $('#project-connection-dialog').close());
function resolveLocation() {
  if(view==='projects'){selectedTask=null;selectedRun=null;selectedProject=null;return;}
  if(['queue','history'].includes(view)) {
    selectedTask=null;selectedRun=null;
    if(!selectedProject || !workspace.projects?.[selectedProject]) {view='projects';selectedProject=null;showError('Select a project to browse its tasks.');}
    return;
  }
  const task = workspace.tasks.find(task=>task.id===selectedTask);
  if (!task) {view='projects';selectedTask=null;selectedRun=null;selectedProject=null;showError('This task is unavailable. Select a project and task.');return;}
  selectedProject=task.projectId;
  if(['review','evidence'].includes(view) && !workspace.runs.some(run=>run.id===selectedRun&&run.taskId===task.id)) {
    view='work';selectedRun=null;
  }
  if(!['review','evidence'].includes(view))selectedRun=null;
}
window.addEventListener('popstate', async () => {
  rememberProjectSelection();
  if ($('#task-launcher').open) $('#task-launcher').close();
  if ($('#project-connection-dialog').open) $('#project-connection-dialog').close();
  const place = readLocation(location.search);
  view = place.view; selectedProject = place.projectId; selectedTask = place.taskId; selectedRun = place.runId;
  projectOffset=Math.max(0,Number(new URLSearchParams(location.search).get('offset'))||0);pageRevision=null;
  await refresh(true);
});
$("#dismiss-error").addEventListener("click", clearError);

document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
refresh();
