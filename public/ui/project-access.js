import {el} from './dom.js';

export function canManageProjectAccess({workspace,demo}) {
  return !demo && !workspace?.personalWorkspace && workspace?.authentication?.mode==='cloudflare-access' && workspace.authentication.permissions?.manage===true;
}

export function createProjectAccessPanel({projectId,getContext,captureSession,api,refresh}) {
  const root=el('section',{id:'project-access-settings','aria-label':'People and repository access'}),session=captureSession();
  const current=()=>root.isConnected&&session()&&canManageProjectAccess(getContext())&&getContext().selectedProject===projectId;
  let data=null,error='',message='',busy=false,read=0,attempt=null;
  const drafts=new Map();
  async function load() {
    if(!current())return;
    const request=++read;busy=true;render();
    try {const result=await api('/api/projects/'+projectId+'/access');if(!current()||request!==read)return;
      data=result;drafts.clear();error='';
    } catch(failure){if(!current()||request!==read)return;error=failure.message;}
    if(!current()||request!==read)return;busy=false;render();
  }
  async function save(event) {
    event.preventDefault();if(!current()||busy||!data)return;
    const pending=data.recovery;
    const input=pending?.input??attempt?.input??{expectedVersion:data.access.version,
      grants:data.identities.flatMap(identity=>{const role=drafts.get(identity.kind+':'+identity.id)
        ??data.access.grants.find(grant=>grant.kind===identity.kind&&grant.id===identity.id)?.role??'';
        return role?[{kind:identity.kind,id:identity.id,role}]:[];})};
    const id=pending?pending.requestId:attempt?.id??crypto.randomUUID();
    if(!id){error='The saved change needs operator inspection; no replacement request was created.';render();return;}
    attempt={id,input:structuredClone(input)};busy=true;error='';message='';render();
    try {
      const result=await api('/api/projects/'+projectId+'/access',input,id);
      if(!current())return;
      if(result?.projectId!==projectId||result.accessVersion!==input.expectedVersion+1||!['pending','confirmed'].includes(result.credentialCleanup))
        throw Error('The access change was not confirmed. Inspect access, then recover this saved request with its original ID.');
      attempt=null;
      message=result.credentialCleanup==='pending'?'Access changed. Credential cleanup still needs assignment recovery.'
        :'Repository access saved. Credential cleanup is confirmed for the recorded assignments.';
      await refresh(true);
    } catch(failure){if(!current())return;error=failure.message;}
    if(!current())return;
    busy=false;const savedError=error;await load();if(current()&&savedError){error=savedError;render();}
  }
  function render() {
    if(!canManageProjectAccess(getContext())){root.replaceChildren(el('p',{},'Repository access is available to the workspace owner.'));return;}
    const pending=data?.recovery;
    root.replaceChildren(...[el('h3',{},'People and repository access'),
      el('p',{},'Choose who can read, build or independently review this repository. Acceptance and merge stay with the workspace owner.'),
      !data?el('p',{role:'status'},busy?'Loading repository access…':'Repository access could not be loaded.'):null,
      error?el('p',{role:'alert'},error):null,message?el('p',{role:'status'},message):null,
      data?el('p',{class:'small'},data.access.configured?'Access version '+data.access.version:'Owner-only access. No repository grants have been configured.'):null,
      ...(data?.access.grants??[]).filter(grant=>!data.identities.some(identity=>identity.kind===grant.kind&&identity.id===grant.id))
        .map(grant=>el('p',{class:'capability-note'},grant.id+' is no longer configured. Its retained '+grant.role+' grant will be removed when you save.')),
      pending?el('p',{class:'capability-note',role:'status'},'Access is enforced. Credential cleanup is pending for '+pending.pendingRuns.length+' recorded assignments. Reconcile those assignments, then continue this saved change.'):null,
      attempt?el('p',{class:'capability-note'},'Saved request '+attempt.id+'. Recover it with its original grants and version before starting another change.'):null,
      data?el('form',{onsubmit:save},
        ...data.identities.map((identity,index)=>{
          const id='repository-grant-'+index,key=identity.kind+':'+identity.id;
          const selected=drafts.get(key)??data.access.grants.find(grant=>grant.kind===identity.kind&&grant.id===identity.id)?.role??'';
          return el('div',{class:'project-access-row'},el('label',{for:id},identity.id,el('span',{class:'small'},identity.kind)),
            el('select',{id,disabled:busy||Boolean(pending)||Boolean(attempt),onchange:event=>{
              if(!current()||busy||pending||attempt)return;drafts.set(key,event.target.value);root.querySelector('#save-project-access').disabled=false;
            }},
              el('option',{value:'',selected:selected===''},'No access'),
              ...identity.roles.map(role=>el('option',{value:role,selected:role===selected},role==='read'?'Read':role==='build'?'Read and build':'Independent review'))));
        }),
        !data.identities.length?el('p',{},'No team identities are configured. Add stable member subjects or service identities in the installation configuration first.'):null,
        el('p',{class:'small'},'Access changes require fresh independent review. Already downloaded code cannot be recalled.'),
        el('button',{id:'save-project-access',type:'submit',class:'button button-primary',disabled:busy||data.access.configured&&!pending&&!attempt&&!drafts.size},
          busy?'Saving…':pending?'Continue credential cleanup':attempt?'Recover saved access change':'Save repository access')):null,
      attempt&&!pending?el('button',{type:'button',class:'button button-small',disabled:busy,onclick:()=>{
        if(!current())return;const previous=attempt.id;attempt=null;drafts.clear();error='';message='New draft opened from current access. Earlier request '+previous+' remains in server history.';render();
      }},'Start a new draft from current access'):null,
      el('details',{},el('summary',{},'Identity and recovery details'),el('p',{class:'small'},
        'Members read only. Builders need build access before receiving an assignment. Reviewers also need a current candidate assignment. Roles use configured subjects, not matching email addresses. A pending credential cleanup is retained across reloads; continuing it does not create new work.')),
      el('button',{type:'button',class:'button button-small',disabled:busy,onclick:load},'Reload access')].filter(Boolean));
  }
  render();queueMicrotask(load);return root;
}
