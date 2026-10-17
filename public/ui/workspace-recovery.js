import {el} from './dom.js';

export function createWorkspaceRecoveryPanel({getContext,captureSession,api,downloadJson,getSelection,canManage}){
  const root=el('section',{'aria-label':'Historical workspace recovery'}),session=captureSession(),workspaceId=getContext().workspace.id;
  let history=null,busy=false,error='',pending=null,detail=null,records=null,source='',expectedDigest='',confirmation='';
  const current=()=>root.isConnected&&session()&&getContext().workspace?.id===workspaceId&&canManage(getContext());
  async function readHistory(){
    if(!current()||busy)return;busy=true;error='';render();
    try{const result=await api('/api/workspace/recovery-imports');if(!current())return;
      if(result.workspaceId!==workspaceId||!Number.isSafeInteger(result.revision)||!Array.isArray(result.imports)||typeof result.restoreAllowed!=='boolean'
        ||!Number.isSafeInteger(result.current?.liveLedgerRows)||result.current.liveLedgerRows<0
        ||result.restoreAllowed&&(result.current.liveLedgerRows>0||result.current.projects>0||result.current.tasks>0||result.current.runs>0))throw Error('Incomplete history readback.');
      history=result;if(pending&&history.imports.some(item=>item.id===pending.body.expectedSha256))pending=null;
    }catch{if(current())error='Could not read current recovery history. Preserve the earlier request; do not assume an unconfirmed restore failed.';}
    if(current()){busy=false;render();}
  }
  async function restore(){
    if(!current()||busy)return;const selected=getSelection();
    if(!pending){
      if(!history||!selected?.archive||expectedDigest.trim()!==selected.archive.sha256||source.trim()!==selected.preview.sourceWorkspaceId||confirmation!=='RESTORE HISTORY ONLY'){
        error='Enter the separately recorded archive digest, source workspace and exact history-only confirmation.';render();return;}
      pending={key:crypto.randomUUID(),body:{archive:selected.archive,expectedSha256:expectedDigest.trim(),expectedSourceWorkspaceId:source.trim(),expectedWorkspaceId:workspaceId,
        expectedRevision:history.revision,confirmation}};
    }
    busy=true;error='';render();
    try{const result=await api('/api/workspace/restore',pending.body,pending.key);if(!current())return;
      if(result.workspaceId!==workspaceId||result.recoveryImportId!==pending.body.expectedSha256||result.historical!==true||result.restoresAuthority!==false||result.resumesWork!==false)throw Error('Restore outcome unconfirmed.');
      pending=null;confirmation='';busy=false;await readHistory();
    }catch{if(current()){error='Restore outcome is not confirmed. Read recovery history before deliberately retrying the same saved request.';busy=false;render();}}
  }
  async function inspect(id,download=false){
    if(!current()||busy)return;busy=true;error='';render();
    try{const value=await api('/api/workspace/recovery-imports/'+id+(download?'/archive':''));if(!current())return;
      if(download){if(value.sha256!==id)throw Error('Wrong archive.');downloadJson(value,'projects-git-recovery-'+id+'.json',{compact:true});}
      else {if(value.id!==id)throw Error('Wrong history.');detail=value;records=null;}
    }catch{if(current())error='Could not read the retained archive. Earlier history remains preserved.';}
    if(current()){busy=false;render();}
  }
  async function readRecords(){
    if(!current()||busy||!detail)return;busy=true;render();
    try{const value=await api('/api/workspace/recovery-imports/'+detail.id+'/archive');if(!current())return;if(value.sha256!==detail.id)throw Error('Wrong history.');records=value;}
    catch{if(current())error='Could not read the original records.';}
    if(current()){busy=false;render();}
  }
  function render(){
    const selected=pending?{archive:pending.body.archive,preview:{sourceWorkspaceId:pending.body.expectedSourceWorkspaceId}}:getSelection(),exists=history?.imports.some(item=>item.id===selected?.archive.sha256);
    root.replaceChildren(...[
      el('h3',{},'Restore and read historical workspace records'),
      el('p',{},'Destination workspace: '+workspaceId+'. Current identity and permissions stay in force. Historical imports do not restore code, activate tasks or resume external effects.'),
      el('button',{type:'button',class:'button button-small',disabled:busy,onclick:readHistory},'Read destination and recovery history'),
      history?el('div',{},el('p',{},`Destination revision ${history.revision} · current projects ${history.current.projects}, tasks ${history.current.tasks}, candidates ${history.current.runs} · ${history.current.liveLedgerRows} live provider ledger records · ${history.imports.length} historical imports`),
        el('p',{},history.quarantinedNames.length+' original resource names quarantined. Use explicitly fresh names when connecting independently restored code.'),
        ...history.imports.map(item=>el('div',{},el('p',{},`Historical source ${item.sourceWorkspaceId} · ${item.id} · imported by current owner ${item.importedBy} at ${item.importedAt} · code unavailable here`),
          el('button',{type:'button',class:'button button-small',disabled:busy,onclick:()=>inspect(item.id)},'Read historical import'),
          el('button',{type:'button',class:'button button-small',disabled:busy,onclick:()=>inspect(item.id,true)},'Download original archive')))):null,
      selected&&history&&!exists?el('div',{},el('p',{},'Selected historical source '+selected.preview.sourceWorkspaceId+' · digest '+selected.archive.sha256),
        el('label',{for:'restore-source-workspace'},'Expected source workspace'),el('input',{id:'restore-source-workspace',value:source,disabled:busy||Boolean(pending),oninput:event=>{source=event.target.value;}}),
        el('label',{for:'restore-archive-digest'},'Separately recorded archive SHA-256'),el('input',{id:'restore-archive-digest',value:expectedDigest,disabled:busy||Boolean(pending),oninput:event=>{expectedDigest=event.target.value;}}),
        el('label',{for:'restore-history-confirmation'},'Type RESTORE HISTORY ONLY to confirm this destination and revision'),
        el('input',{id:'restore-history-confirmation',value:confirmation,disabled:busy||Boolean(pending),oninput:event=>{confirmation=event.target.value;}}),
        el('button',{type:'button',class:'button button-small',disabled:busy||!history.restoreAllowed,onclick:restore},pending?'Retry same history restore request':'Restore history into this empty workspace')):null,
      detail?el('div',{},el('h4',{},'Historical records · '+detail.sourceWorkspaceId),
        el('p',{},`Historical tasks ${detail.counts.tasks}, candidates ${detail.counts.runs}, events ${detail.counts.events}, operation receipts ${detail.counts.operations}. Earlier approvals and uncertain effects grant no current authority.`),
        el('button',{type:'button',class:'button button-small',disabled:busy,onclick:readRecords},'Read all original historical records'),
        records?el('pre',{class:'code-block'},JSON.stringify(records.payload,null,2)):null):null,
      pending?el('p',{role:'status'},'Saved restore request '+pending.key+'. Read recovery history before retrying. No automatic request replay will occur.'):null,
      busy?el('p',{role:'status'},'Reading or retaining historical records…'):null,error?el('p',{role:'alert'},error):null
    ].filter(Boolean));
  }
  render();return {root,render};
}
