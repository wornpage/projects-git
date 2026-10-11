const validId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
export function createProjectDiscovery({getContext,api,captureSession,onChange,storage=localStorage}) {
  let scope=null,workspaceId=null,revision=null,preferences={pinned:[],recent:[]},shortcuts=[],request=0,preferenceError='',catalogError='',unreadable=false;
  const key=()=> 'projects-git-project-shortcuts-v1:'+scope;
  const currentScope=()=>{const workspace=getContext().workspace,principal=workspace?.authentication?.principal;return JSON.stringify([workspace?.id,principal?.kind??null,principal?.id??null]);};
  function save(){try{storage.setItem(key(),JSON.stringify(preferences));preferenceError='';}catch{preferenceError='Project shortcuts could not be saved in this browser.';}onChange();}
  async function find(query='',offset=0,{ids=null,at=null}={}) {
    const id=getContext().workspace.id,isCurrent=captureSession(),params=new URLSearchParams({q:query,offset:String(offset),limit:'20'});
    if(ids)params.set('ids',ids.join(','));if(at!==null)params.set('at',String(at));
    const result=await api('/api/projects/catalog?'+params);
    if(!isCurrent())return null;
    if(result.workspaceId!==id||result.scope!=='project-names-across-workspace'||result.query!==query.trim()||result.limit!==20||result.offset!==offset
      ||!Number.isSafeInteger(result.revision)||result.revision<0||!Array.isArray(result.items)||result.items.length>20
      ||!Number.isSafeInteger(result.total)||result.total<0||!Number.isSafeInteger(result.matched)||result.matched<0||result.matched>result.total||offset+result.items.length>result.matched
      ||result.previousOffset!==(offset?Math.max(0,offset-20):null)||result.nextOffset!==(offset+20<result.matched?offset+20:null)
      ||result.items.some(item=>!validId(item.id)||typeof item.name!=='string'||!Number.isSafeInteger(item.taskCount)||item.taskCount<0||!Number.isSafeInteger(item.candidateCount)||item.candidateCount<0)
      ||new Set(result.items.map(item=>item.id)).size!==result.items.length)throw new Error('Project search returned an invalid workspace catalog.');
    return result;
  }
  async function sync(selectedId=null) {
    const workspace=getContext().workspace;if(!workspace)return;
    const next=currentScope();
    if(next!==scope){scope=next;workspaceId=workspace.id;preferences={pinned:[],recent:[]};shortcuts=[];revision=null;preferenceError='';catalogError='';unreadable=false;request++;
      try {const raw=storage.getItem(key());if(raw){const saved=JSON.parse(raw);if(!saved||Object.keys(saved).some(key=>!['pinned','recent'].includes(key))
        ||!Array.isArray(saved.pinned)||!Array.isArray(saved.recent)||saved.pinned.length>4||saved.recent.length>8
        ||new Set(saved.pinned).size!==saved.pinned.length||new Set(saved.recent).size!==saved.recent.length||[...saved.pinned,...saved.recent].some(id=>!validId(id)))throw Error();preferences=saved;}}
      catch{unreadable=true;preferenceError='Saved project shortcuts are unreadable. Reset shortcuts to start a new list.';}
    }
    if(selectedId&&!unreadable&&preferences.recent[0]!==selectedId){preferences.recent=[selectedId,...preferences.recent.filter(id=>id!==selectedId)].slice(0,8);save();}
    const ids=[...new Set([selectedId,...preferences.pinned,...preferences.recent].filter(Boolean))].slice(0,8);
    const signature=JSON.stringify([scope,workspace.sourceRevision??workspace.version,ids]);if(signature===revision)return;revision=signature;
    const started=++request,isCurrent=captureSession();
    if(!ids.length){shortcuts=[];onChange();return;}
    try {const result=await find('',0,{ids});if(!result||started!==request||!isCurrent()||workspaceId!==getContext().workspace.id)return;
      shortcuts=ids.map(id=>result.items.find(item=>item.id===id)).filter(Boolean);catalogError='';onChange();}
    catch(failure){if(started===request&&isCurrent()){catalogError=failure.message;onChange();}}
  }
  function togglePin(id){if(!validId(id))throw Error('Invalid project shortcut.');if(unreadable){onChange();return;}if(preferences.pinned.includes(id))preferences.pinned=preferences.pinned.filter(value=>value!==id);
    else if(preferences.pinned.length>=4){preferenceError='Pin up to four projects. Unpin one before adding another.';onChange();return;}else preferences.pinned.push(id);save();revision=null;void sync(getContext().selectedProject);}
  function retry(){revision=null;void sync(getContext().selectedProject);}
  function reset(){preferences={pinned:[],recent:[]};preferenceError='';catalogError='';unreadable=false;save();retry();}
  return {find,sync,togglePin,reset,retry,needsReset:()=>unreadable,items:()=>shortcuts,pinned:id=>preferences.pinned.includes(id),error:()=>preferenceError||catalogError};
}
