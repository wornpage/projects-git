import {metrics} from './workspace-metrics.js';
// A page is a read projection, never a replacement for authoritative state.
export function parseWorkspacePage(search) {
  const params = new URLSearchParams(search);
  if (!params.size) return null; // Explicit full-workspace export and operator reads.
  const invalid = () => { throw Object.assign(new Error('Use a project page of 1–20 items, a nonnegative offset, and the supplied revision.'), {code:'INVALID_WORKSPACE_PAGE', status:400}); };
  if ([...params.keys()].some(key => !['limit','offset','task','project','run','at'].includes(key) || params.getAll(key).length !== 1)) invalid();
  const number = (name, fallback, max) => {
    const value = params.get(name);
    if (value === null) return fallback;
    if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) invalid();
    return Number(value);
  };
  const limit = number('limit', 10, 20), offset = number('offset', 0, 100_000), at = number('at', null, Number.MAX_SAFE_INTEGER);
  const task = params.get('task'), project = params.get('project'), run = params.get('run');
  if (!limit || [task,project,run].filter(Boolean).length>1 || [task,project,run].some(id => id !== null && !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) || (task || project || run) && (limit !== 1 || offset !== 0)) invalid();
  return {limit,offset,at,task,project,run};
}

export function pageSelection(projects, tasks, request, revision) {
  if (request.at !== null && request.at !== revision) throw Object.assign(new Error('The workspace changed. Refresh this page before continuing.'), {status:409,code:'WORKSPACE_PAGE_CHANGED'});
  const entries = Object.values(projects ?? {});
  const projectId = request.task ? tasks.find(task => task.id === request.task)?.projectId : request.project;
  if ((request.task || request.project) && !entries.some(project => project.id === projectId)) throw Object.assign(new Error('The requested project or task is unavailable in this workspace.'), {status:404,code:'PROJECT_NOT_FOUND'});
  const offset = projectId ? entries.findIndex(project => project.id === projectId) : request.offset;
  if (offset > 0 && offset >= entries.length) throw Object.assign(new Error('This project page no longer exists. Return to the first page.'), {status:409,code:'WORKSPACE_PAGE_CHANGED'});
  return {ids:entries.slice(offset,offset + request.limit).map(project => project.id),offset,total:entries.length};
}

export function projectWorkspace(workspace, request, revision = workspace.version) {
  if (!request) return workspace;
  if(request.run){const run=workspace.runs.find(run=>run.id===request.run);if(!run)throw Object.assign(new Error('Assignment unavailable in this workspace.'),{status:404,code:'RUN_NOT_FOUND'});request={...request,task:run.taskId,run:null};}
  const {ids,offset,total} = pageSelection(workspace.projects, workspace.tasks, request, revision);
  const tasks = workspace.tasks.filter(task => ids.includes(task.projectId)), taskIds = new Set(tasks.map(task => task.id));
  const runs = workspace.runs.filter(run => taskIds.has(run.taskId)), runIds = new Set(runs.map(run => run.id));
  return {...workspace, projects:Object.fromEntries(ids.map(id => [id,workspace.projects[id]])),tasks,runs,
    metrics:metrics({...workspace,tasks,runs}),coordination:Object.fromEntries(Object.entries(workspace.coordination??{}).filter(([id])=>runIds.has(id))),
    reviewInferences:workspace.reviewInferences?.filter(item=>runIds.has(item.runId)),
    events:workspace.events.filter(event => ids.includes(event.projectId) || taskIds.has(event.taskId) || runIds.has(event.runId) || !event.projectId && !event.taskId && !event.runId),
    page:{offset,limit:request.limit,totalProjects:total,revision,nextOffset:offset + request.limit < total ? offset + request.limit : null,previousOffset:offset ? Math.max(0,offset-request.limit) : null,
      taskNumbers:Object.fromEntries(workspace.tasks.map((task,index) => [task.id,index+1]).filter(([id]) => taskIds.has(id))),
      workspaceTotals:{projects:total,tasks:workspace.tasks.length,runs:workspace.runs.length},scope:'loaded-projects'}};
}

/** Mutation replies contain the affected project, while explicit exports remain complete. */
export function projectMutationResult(value,path) {
  const state = Array.isArray(value?.tasks) ? value : value?.workspace;
  if(!state || !Array.isArray(state.tasks) || !Array.isArray(state.runs))return value;
  const resource=/^\/api\/(runs|tasks|projects)\/([^/]+)\//.exec(path);
  const runId=value.runId??(resource?.[1]==='runs'?resource[2]:null);
  const taskId=value.taskId??(resource?.[1]==='tasks'?resource[2]:null)??state.runs.find(run=>run.id===runId)?.taskId;
  const project=value.projectId??(resource?.[1]==='projects'?resource[2]:null)??state.tasks.find(task=>task.id===taskId)?.projectId;
  // The controller may already have read this complete project from SQL. Keep
  // its workspace-wide counts and position instead of paging that page again.
  if(state.page){
    if(state.page.scope!=='loaded-projects'||!project||Object.keys(state.projects??{}).length!==1||!Object.hasOwn(state.projects,project))throw new Error('Mutation projection does not match its affected project.');
    const projected={...state,page:{...state.page,revision:null}};
    return state===value?projected:{...value,workspace:projected};
  }
  const projected=projectWorkspace(state,{limit:project?1:10,offset:0,at:null,project,task:null,run:null});
  // Internal SQL revision is not part of a mutation result. Its next read obtains a fresh cursor.
  projected.page.revision=null;
  return state===value?projected:{...value,workspace:projected};
}
