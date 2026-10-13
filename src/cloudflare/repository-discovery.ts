import {ApiError} from './security.ts';

export const REPOSITORY_PAGE_SIZE = 20;
const REPOSITORY_READ_MS = 10_000;
const namePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const plain = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const invalidProvider = () => new ApiError(502,'INVALID_REPOSITORY_RESPONSE','Artifacts returned incomplete repository details. Refresh the list.');

export function discoveryParameter(search: string, key: 'cursor'|'name'): string | undefined {
  const params = new URLSearchParams(search);
  if ([...params.keys()].some(name=>name!==key) || params.getAll(key).length>1)
    throw new ApiError(400,'INVALID_REPOSITORY_QUERY','Use only the requested repository lookup parameter.');
  const value=params.get(key);
  if (value===null) return undefined;
  if (!plain(value,key==='cursor'?2048:100)) throw new ApiError(400,'INVALID_REPOSITORY_QUERY','Repository lookup parameter is empty or too long.');
  return value;
}

function providerCode(error: unknown): unknown {
  return error && typeof error==='object' && 'code' in error ? error.code : null;
}

async function read<T>(operation:(check:()=>void)=>Promise<T>):Promise<T> {
  let timer:ReturnType<typeof setTimeout>|undefined;
  let expired=false;
  const timeout=()=>new ApiError(504,'REPOSITORY_READ_TIMEOUT','Artifacts is taking too long. Retry this read.');
  const check=()=>{if(expired)throw timeout();};
  try {
    const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{expired=true;reject(timeout());},REPOSITORY_READ_MS);});
    return await Promise.race([operation(check),deadline]);
  } catch(error) {
    if(error instanceof ApiError)throw error;
    const code=providerCode(error);
    if(code==='NOT_FOUND')throw new ApiError(404,'REPOSITORY_NOT_FOUND','This repository is no longer available in the workspace namespace.');
    if(['CREATE_IN_PROGRESS','IMPORT_IN_PROGRESS','FORK_IN_PROGRESS'].includes(String(code)))throw new ApiError(409,'REPOSITORY_NOT_READY','This repository is still being prepared. Refresh it when ready.');
    throw new ApiError(502,'REPOSITORY_READ_FAILED','Could not read Artifacts repositories. Retry or ask the workspace operator to check the binding.');
  } finally {if(timer!==undefined)clearTimeout(timer);}
}

export async function listRepositories(artifacts:Artifacts,cursor:string|undefined,validate:()=>void) {
  validate();
  return read(async check=>{
    const page=await artifacts.list({limit:REPOSITORY_PAGE_SIZE,...(cursor?{cursor}:{})});
    check();validate();
    if(!page || !Array.isArray(page.repos) || page.repos.length>REPOSITORY_PAGE_SIZE || !Number.isSafeInteger(page.total) || page.total<page.repos.length
      || page.cursor!=null && !plain(page.cursor,2048))throw invalidProvider();
    const names=new Set<string>();
    const repositories=page.repos.map(repo=>{
      if(!repo || typeof repo.name!=='string' || !namePattern.test(repo.name) || names.has(repo.name))throw invalidProvider();
      names.add(repo.name);return {name:repo.name};
    });
    return {repositories,total:page.total,nextCursor:page.cursor??null};
  });
}

export async function inspectRepository(artifacts:Artifacts,name:string,validate:()=>void) {
  validate();
  return read(async check=>{
    using repo=await artifacts.get(name);
    check();validate();
    const info=await repo.info();
    check();validate();
    if(!info || info.name!==name || !plain(info.defaultBranch,500))throw invalidProvider();
    let history:ArtifactsCommitMetadata[];
    try {history=await repo.log({ref:info.defaultBranch,limit:1});}
    catch(error){if(providerCode(error)!=='NOT_FOUND')throw error;history=[];}
    check();validate();
    if(!Array.isArray(history) || history.length>1)throw invalidProvider();
    const baseCommit=history.length===0?null:history[0]?.hash;
    if(baseCommit!==null && (typeof baseCommit!=='string'||!/^[a-f0-9]{40}$/.test(baseCommit)))throw invalidProvider();
    return {name,defaultBranch:info.defaultBranch,baseCommit};
  });
}
