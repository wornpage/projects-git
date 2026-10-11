export const PROJECT_CATALOG_LIMIT = 20;
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
export class ProjectCatalogError extends Error {
  constructor(status,code,message){super(message);this.status=status;this.code=code;}
}
const invalid = () => { throw new ProjectCatalogError(400,'INVALID_PROJECT_CATALOG','Use a bounded project-name query, page and optional shortcut IDs.'); };

export function parseProjectCatalog(search) {
  const params=new URLSearchParams(search);
  if([...params.keys()].some(key=>!['q','offset','limit','ids','at'].includes(key)||params.getAll(key).length!==1))invalid();
  const number=(key,fallback,max)=>{const value=params.get(key);if(value===null)return fallback;if(!/^(0|[1-9]\d*)$/.test(value)||!Number.isSafeInteger(Number(value))||Number(value)>max)invalid();return Number(value);};
  const q=(params.get('q')??'').trim();if(q.length>200)invalid();
  const offset=number('offset',0,100000),limit=number('limit',PROJECT_CATALOG_LIMIT,50),at=number('at',null,Number.MAX_SAFE_INTEGER);
  const ids=params.has('ids')?params.get('ids').split(','):null;
  if(!limit||ids&&(!ids.length||ids.length>12||limit<ids.length||ids.some(id=>!idPattern.test(id))||new Set(ids).size!==ids.length)||ids&&(q||offset))invalid();
  return {q,offset,limit,at,ids};
}

export function selectCatalogEntries(entries,request,revision) {
  if(request.at!==null&&request.at!==revision)throw new ProjectCatalogError(409,'PROJECT_CATALOG_CHANGED','Projects changed while paging. Search again for the current list.');
  const words=request.q.toLowerCase().split(/\s+/).filter(Boolean);
  const matching=entries.filter(item=>(!request.ids||request.ids.includes(item.id))&&words.every(word=>item.name.toLowerCase().includes(word)))
    .sort((a,b)=>a.name.localeCompare(b.name)||a.id.localeCompare(b.id));
  if(request.offset&&request.offset>=matching.length)throw new ProjectCatalogError(409,'PROJECT_CATALOG_PAGE_UNAVAILABLE','That project page is no longer available. Search again for the current list.');
  const offset=request.offset;
  return {ids:matching.slice(offset,offset+request.limit).map(item=>item.id),
    page:{query:request.q,revision,total:entries.length,matched:matching.length,offset,limit:request.limit,
      previousOffset:offset?Math.max(0,offset-request.limit):null,nextOffset:offset+request.limit<matching.length?offset+request.limit:null,scope:'project-names-across-workspace'}};
}

export function projectCatalog(workspace,request,revision=workspace.sourceRevision??workspace.version) {
  const entries=Object.values(workspace.projects??{}),selection=selectCatalogEntries(entries,request,revision);
  const items=selection.ids.map(id=>{const project=workspace.projects[id],tasks=workspace.tasks.filter(task=>task.projectId===id),taskIds=new Set(tasks.map(task=>task.id));
    return {id,name:project.name,taskCount:tasks.length,candidateCount:workspace.runs.filter(run=>taskIds.has(run.taskId)).length};});
  return {workspaceId:workspace.id,...selection.page,items};
}
