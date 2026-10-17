import {el} from './dom.js';
const MAX_BYTES=1024*1024;
const count=value=>Number.isSafeInteger(value)&&value>=0;
export function canInspectWorkspaceBackup({workspace,demo}){
  return !demo&&workspace?.authentication?.mode==='cloudflare-access'&&workspace.authentication.permissions?.manage===true;
}
export function createWorkspaceBackupPanel({getContext,captureSession,api,downloadJson}){
  const root=el('section',{id:'workspace-backup-settings','aria-label':'Workspace backup'}),session=captureSession(),workspaceId=getContext().workspace?.id;
  let busy=false,error='',preview=null,selection=0;
  const current=()=>root.isConnected&&session()&&getContext().workspace?.id===workspaceId&&canInspectWorkspaceBackup(getContext());
  async function download(){
    if(!current()||busy)return;busy=true;error='';const request=++selection;render();
    try{
      const archive=await api('/api/workspace/backup');if(!current()||request!==selection)return;
      if(archive?.format!=='projects-git-workspace-backup/v1'||archive.payload?.workspace?.id!==workspaceId||!/^[a-f0-9]{64}$/.test(archive.sha256))throw Error('A complete backup for this workspace was not returned.');
      downloadJson(archive,'projects-git-workspace-backup-'+archive.sha256.slice(0,12)+'.json');
    }catch(failure){if(!current()||request!==selection)return;error=failure.message;}
    if(!current()||request!==selection)return;busy=false;render();
  }
  async function inspect(file){
    if(!current()||busy||!file)return;busy=true;error='';preview=null;const request=++selection;render();
    try{
      if(!count(file.size)||file.size<2||file.size>MAX_BYTES)throw Error('Choose a complete backup JSON file, at most 1 MiB.');
      const bytes=await file.slice(0,MAX_BYTES+1).arrayBuffer();if(bytes.byteLength>MAX_BYTES)throw Error('Backup file exceeds 1 MiB.');
      const archive=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));if(!current()||request!==selection)return;
      const result=await api('/api/workspace/backup-preview',{method:'POST',body:{archive,expectedSha256:archive.sha256}});
      if(!current()||request!==selection)return;
      if(result?.format!=='projects-git-workspace-backup/v1'||result.archiveSha256!==archive.sha256||result.historical!==true||result.restoresAuthority!==false||result.resumesWork!==false
        ||!result.counts||['projects','tasks','runs','operations','events','pendingOperations','unsettledJobs'].some(key=>!count(result.counts[key]))
        ||result.counts.pendingOperations>result.counts.operations||!Array.isArray(result.projects)||result.projects.length!==result.counts.projects)throw Error('The backup preview is incomplete.');
      preview=result;
    }catch{if(!current()||request!==selection)return;error='Could not validate this backup. Keep the original file and its separately recorded digest.';}
    if(!current()||request!==selection)return;busy=false;render();
  }
  function render(){
    if(!canInspectWorkspaceBackup(getContext())){root.replaceChildren(el('p',{},'Workspace backup is available to the signed-in owner.'));return;}
    root.replaceChildren(...[el('h3',{},'Workspace backup'),
      el('p',{},'Download retained history, operation receipts and required Git commit references. Package Git objects separately on your computer.'),
      el('button',{type:'button',class:'button button-small',disabled:busy,onclick:download},'Download backup metadata'),
      el('p',{class:'small'},'Metadata alone cannot recover code. Offline recovery restores isolated Git repositories and history; it does not resume work or install an active database.'),
      el('label',{for:'workspace-backup-file'},'Preview a saved backup'),
      el('input',{id:'workspace-backup-file',type:'file',accept:'.json,application/json',disabled:busy,onchange:event=>inspect(event.target.files?.[0])}),
      el('p',{class:'small'},'The selected file is sent to this private app for validation only. It is not stored or applied.'),
      busy?el('p',{role:'status'},'Reading backup metadata…'):null,error?el('p',{role:'alert'},error):null,
      preview?el('div',{},el('p',{},`${preview.counts.projects} repositories · ${preview.counts.tasks} tasks · ${preview.counts.runs} candidates · ${preview.counts.operations} operation receipts`),
        el('p',{},`${preview.counts.pendingOperations} unresolved operation receipts · ${preview.counts.unsettledJobs} unsettled job records. No work will be resumed.`),
        el('p',{class:'small'},`Source workspace ${preview.sourceWorkspaceId} · revision ${preview.sourceRevision} · digest ${preview.archiveSha256}`),
        ...preview.projects.map(project=>el('p',{class:'small'},`${project.name} · ${project.commits} required commits`))):null,
      el('details',{},el('summary',{},'Recover offline and understand the boundary'),
        el('p',{},'Use scripts/workspace-bundle.mjs from the source checkout to package every referenced commit from explicit local repositories. Record the returned manifest digest separately. Restore only to a new directory.'),
        el('p',{},'Backup size is bounded at 1 MiB and Git packaging at 64 MiB. Exceeding a limit fails; nothing is silently truncated. A checksum proves integrity, not who created an archive.'),
        el('p',{},'Credentials, access grants and runnable jobs are excluded. Historical decisions remain history. Unresolved receipts are retained; an expired lease does not prove an external process stopped. Reconnecting restored code to a live installation requires separate owner action and fresh authorization.'))].filter(Boolean));
  }
  render();return root;
}
