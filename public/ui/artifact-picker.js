import {$,el} from './dom.js';

// Read-only discovery. Existing task creation still owns drafts and submission.
export function createArtifactPicker({getContext,api,isLocked,saveSession}) {
  let scope='',wasActive=false,page=null,cursor=null,previous=[],listRequest=0,headRequest=0;
  let listing=false,reading=false,error='',head=null,optionsKey='';
  const name=$('#repository-path'),base=$('#repository-base'),select=$('#artifact-repository-select');
  const key=()=>{const {workspace,demo}=getContext();return JSON.stringify([workspace?.id,workspace?.provider,workspace?.authentication?.principal??null,workspace?.authentication?.permissions?.manage,Boolean(demo)]);};
  const hosted=()=>!getContext().demo&&getContext().workspace?.provider==='cloudflare-artifacts';
  const supported=()=>hosted()&&getContext().workspace?.authentication?.permissions?.manage===true&&getContext().workspace?.capabilities?.repositoryCatalog===true;
  const active=()=>supported()&&$('#task-launcher').open&&$('#task-source').value==='repository'&&!$('#repository-source-fields').hidden&&!isLocked();
  const current=(saved,request,kind)=>saved===scope&&key()===saved&&active()&&(kind==='list'?listRequest:headRequest)===request;
  const validName=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value);
  function leave() {listRequest++;headRequest++;listing=false;reading=false;wasActive=false;}
  function paint() {
    if(!hosted())return;
    const locked=isLocked(),ready=head?.name===name.value&&head?.baseCommit===base.value&&/^[a-f0-9]{40}$/.test(base.value);
    const signature=JSON.stringify([page?.repositories,name.value,listing]);
    if(signature!==optionsKey){
      const names=page?.repositories.map(repo=>repo.name)??[];
      select.replaceChildren(el('option',{value:''},listing?'Loading repositories…':'Choose an Artifacts repository'),
        ...(name.value&&!names.includes(name.value)?[el('option',{value:name.value},name.value+' · selected')]:[]),
        ...names.map(value=>el('option',{value},value)));
      select.value=name.value;optionsKey=signature;
    }
    select.disabled=locked||listing||!supported()||!page;
    $('#artifact-previous').disabled=locked||listing||previous.length===0;
    $('#artifact-next').disabled=locked||listing||!page?.nextCursor;
    $('#artifact-refresh').disabled=locked||listing||!supported();
    $('#artifact-refresh-base').disabled=locked||reading||!name.value||!supported();
    $('#artifact-catalog-status').textContent=!supported()?'Repository discovery is unavailable in this workspace. Ask the operator to check the hosted configuration.':listing?'Loading repositories…':page?`${page.repositories.length} on this page · ${page.total} repositories in the workspace namespace.`:'Choose a repository from this workspace’s Artifacts namespace.';
    $('#artifact-empty').hidden=!page||page.total!==0;
    $('#artifact-picker-error').hidden=!error;$('#artifact-picker-error').textContent=error;
    $('#artifact-base-status').textContent=reading?'Reading the current default branch…':head?head.baseCommit?`Base: ${head.defaultBranch} · current commit loaded. Confirm it before continuing.`:`${head.defaultBranch} has no commit yet. Add a commit in Artifacts before connecting.`:name.value?'Select or refresh this repository to load its current base.':'Selecting a repository loads its current default-branch commit.';
    if($('#task-source').value==='repository'&&!$('#repository-source-fields').hidden)
      $('#repository-next').disabled=locked||!supported()||reading||Boolean(error)||!ready;
  }
  async function loadPage(nextCursor=null,direction='refresh') {
    if(!active()||listing)return;
    const saved=scope,request=++listRequest;listing=true;error='';paint();
    try {
      const result=await api('/api/repositories'+(nextCursor?'?'+new URLSearchParams({cursor:nextCursor}):''));
      if(!current(saved,request,'list'))return;
      if(result.workspaceId!==getContext().workspace.id||!Array.isArray(result.repositories)||result.repositories.length>20||!Number.isSafeInteger(result.total)||result.total<result.repositories.length
        ||result.nextCursor!==null&&(typeof result.nextCursor!=='string'||!result.nextCursor||result.nextCursor.length>2048)
        ||result.repositories.some(repo=>!validName(repo?.name))||new Set(result.repositories.map(repo=>repo.name)).size!==result.repositories.length)throw Error('Repository list is invalid. Refresh before selecting code.');
      if(direction==='next')previous.push(cursor);else if(direction==='previous')previous.pop();else previous=[];
      page=result;cursor=nextCursor;
      if(result.total===0){headRequest++;reading=false;head=null;name.value='';base.value='';saveSession();}
    } catch(failure){if(current(saved,request,'list'))error=failure.message;}
    finally{if(current(saved,request,'list')){listing=false;paint();}}
  }
  async function readBase(selected) {
    if(!active())return;
    const saved=scope,request=++headRequest;
    name.value=selected;base.value='';head=null;error='';reading=Boolean(selected);saveSession();paint();
    if(!selected)return;
    try {
      const result=await api('/api/repositories/head?'+new URLSearchParams({name:selected}));
      if(!current(saved,request,'head')||name.value!==selected)return;
      if(result.workspaceId!==getContext().workspace.id||result.name!==selected||typeof result.defaultBranch!=='string'||!result.defaultBranch||result.defaultBranch.length>500
        ||result.baseCommit!==null&&(typeof result.baseCommit!=='string'||!/^[a-f0-9]{40}$/.test(result.baseCommit)))throw Error('Repository base is invalid. Refresh before continuing.');
      head=result;base.value=result.baseCommit??'';saveSession();
    } catch(failure){if(current(saved,request,'head')&&name.value===selected)error=failure.message;}
    finally{if(current(saved,request,'head')&&name.value===selected){reading=false;paint();}}
  }
  function update() {
    const next=key();
    if(next!==scope){leave();scope=next;page=null;cursor=null;previous=[];head=null;error='';optionsKey='';}
    const enabled=hosted();
    $('#repository-manual-fields').hidden=enabled;
    $('#artifact-picker-field').hidden=!enabled;
    $('#artifact-base-controls').hidden=!enabled;
    $('#repository-inspection-controls').hidden=!getContext().workspace?.capabilities?.inspectRepository;
    if(enabled){base.setAttribute('readonly','');base.setAttribute('aria-describedby','artifact-base-status');}
    else{base.removeAttribute('readonly');base.removeAttribute('aria-describedby');}
    $('#repository-source-fields').dataset.mode=enabled?'hosted':'local';
    if(!active()){if(wasActive)leave();paint();return;}
    if(!wasActive){
      wasActive=true;const entered=scope,selected=name.value;head=null;
      queueMicrotask(()=>{if(scope===entered&&active()){if(!page)void loadPage();if(selected)void readBase(selected);}});
    }
    paint();
  }
  select.addEventListener('change',()=>{void readBase(select.value);});
  $('#artifact-refresh').addEventListener('click',()=>{void loadPage();});
  $('#artifact-next').addEventListener('click',()=>{if(page?.nextCursor)void loadPage(page.nextCursor,'next');});
  $('#artifact-previous').addEventListener('click',()=>{if(previous.length)void loadPage(previous.at(-1),'previous');});
  $('#artifact-refresh-base').addEventListener('click',()=>{void readBase(name.value);});
  $('#repository-back').addEventListener('click',()=>{if(active())select.focus();});
  $('#task-launcher').addEventListener('close',leave);
  function reset() {
    leave();scope='';page=null;cursor=null;previous=[];head=null;error='';optionsKey='';
    select.replaceChildren(el('option',{value:''},'Choose an Artifacts repository'));select.value='';select.disabled=true;
    for(const id of ['artifact-catalog-status','artifact-picker-error','artifact-base-status'])$('#'+id).textContent='';
  }
  return {update,reset};
}
