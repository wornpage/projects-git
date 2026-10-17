import {el} from './dom.js';
import {createWorkspaceRecoveryPanel} from './workspace-recovery.js';
import {MAX_WORKSPACE_BACKUP_BYTES as MAX_BYTES,WORKSPACE_BACKUP_MIB,BACKUP_LIMITS} from '../workspace-backup-limits.js';
const count=value=>Number.isSafeInteger(value)&&value>=0;
export function readWorkspaceBackupPreview(result,expectedSha256){
  const c=result?.counts,keys=["currentProjects","historicalProjects","projects","currentOperations","historicalOperations","priorImports","resources","currentTasks","historicalTasks","tasks","currentRuns","historicalRuns","runs","currentEvents","historicalEvents","events","currentPolicies","historicalPolicies","policies","repositoryMappings","forkMappings","gitMappings","operations","operationReports","jobs","pendingOperations","unsettledJobs","artifactSubscriptions","pendingArtifactSubscriptions","artifactSubscriptionAttempts","pendingArtifactSubscriptionAttempts","artifactEvents","pendingArtifactEvents","artifactEventAttempts","pendingArtifactEventAttempts","artifactDeliveries","reservedArtifactSubscriptions","creatingArtifactSubscriptions","boundArtifactSubscriptions","readyArtifactSubscriptions","completedArtifactSubscriptionAttempts","failedArtifactSubscriptionAttempts","supersededArtifactSubscriptionAttempts","completedArtifactEvents","failedArtifactEvents","completedArtifactEventAttempts","failedArtifactEventAttempts","supersededArtifactEventAttempts","currentArtifactSubscriptions","historicalArtifactSubscriptions","currentArtifactSubscriptionAttempts","historicalArtifactSubscriptionAttempts","currentArtifactEvents","historicalArtifactEvents","currentArtifactEventAttempts","historicalArtifactEventAttempts","currentArtifactDeliveries","historicalArtifactDeliveries"];
  if(result?.format!=='projects-git-workspace-backup/v1'||result.archiveSha256!==expectedSha256||result.ledgerCapture!=='coherent-sqlite-transaction'||result.historical!==true||result.restoresAuthority!==false||result.resumesWork!==false
    ||!c||keys.some(key=>!count(c[key]))||['Projects','Operations','Tasks','Runs','Events','Policies'].some(name=>c['current'+name]+c['historical'+name]!==c[name.toLowerCase()])
    ||c.repositoryMappings+c.forkMappings!==c.gitMappings||c.pendingOperations>c.operations||c.operationReports>c.operations||c.unsettledJobs>c.jobs
    ||c.pendingArtifactSubscriptions>c.artifactSubscriptions||c.pendingArtifactSubscriptionAttempts>c.artifactSubscriptionAttempts
    ||c.pendingArtifactEvents>c.artifactEvents||c.pendingArtifactEventAttempts>c.artifactEventAttempts
    ||c.reservedArtifactSubscriptions+c.creatingArtifactSubscriptions+c.boundArtifactSubscriptions+c.readyArtifactSubscriptions!==c.artifactSubscriptions
    ||c.reservedArtifactSubscriptions+c.creatingArtifactSubscriptions+c.boundArtifactSubscriptions!==c.pendingArtifactSubscriptions
    ||c.pendingArtifactSubscriptionAttempts+c.completedArtifactSubscriptionAttempts+c.failedArtifactSubscriptionAttempts+c.supersededArtifactSubscriptionAttempts!==c.artifactSubscriptionAttempts
    ||c.pendingArtifactEvents+c.completedArtifactEvents+c.failedArtifactEvents!==c.artifactEvents
    ||c.pendingArtifactEventAttempts+c.completedArtifactEventAttempts+c.failedArtifactEventAttempts+c.supersededArtifactEventAttempts!==c.artifactEventAttempts
    ||['artifactSubscriptions','artifactSubscriptionAttempts','artifactEvents','artifactEventAttempts','artifactDeliveries'].some(name=>c['current'+name[0].toUpperCase()+name.slice(1)]+c['historical'+name[0].toUpperCase()+name.slice(1)]!==c[name])
    ||!Array.isArray(result.projects)||result.projects.length!==c.currentProjects||!Array.isArray(result.priorImports)
    ||result.priorImports.some(item=>!item?.counts||keys.some(key=>!count(item.counts[key]))||!/^[a-f0-9]{64}$/.test(item.id))
    ||result.priorImports.reduce((total,item)=>total+1+item.counts.priorImports,0)!==c.priorImports||!Array.isArray(result.resources)||result.resources.length!==c.resources)throw Error('The backup preview is incomplete.');
  return result;
}
export function canInspectWorkspaceBackup({workspace,demo}){
  return !demo&&workspace?.authentication?.mode==='cloudflare-access'&&workspace.authentication.permissions?.manage===true;
}
export function createWorkspaceBackupPanel({getContext,captureSession,api,downloadJson}){
  const root=el('section',{id:'workspace-backup-settings','aria-label':'Workspace backup'}),session=captureSession(),workspaceId=getContext().workspace?.id;
  let busy=false,error='',preview=null,archive=null,selection=0;
  const recovery=createWorkspaceRecoveryPanel({getContext,captureSession,api,downloadJson,canManage:canInspectWorkspaceBackup,getSelection:()=>archive&&preview?{archive,preview}:null});
  const current=()=>root.isConnected&&session()&&getContext().workspace?.id===workspaceId&&canInspectWorkspaceBackup(getContext());
  async function download(){
    if(!current()||busy)return;busy=true;error='';const request=++selection;render();
    try{
      const archive=await api('/api/workspace/backup');if(!current()||request!==selection)return;
      if(archive?.format!=='projects-git-workspace-backup/v1'||archive.payload?.workspace?.id!==workspaceId||!/^[a-f0-9]{64}$/.test(archive.sha256))throw Error('A complete backup for this workspace was not returned.');
      downloadJson(archive,'projects-git-workspace-backup-'+archive.sha256.slice(0,12)+'.json',{compact:true});
    }catch(failure){if(!current()||request!==selection)return;error=failure.message;}
    if(!current()||request!==selection)return;busy=false;render();
  }
  async function inspect(file){
    if(!current()||busy||!file)return;busy=true;error='';preview=null;archive=null;const request=++selection;render();
    try{
      if(!count(file.size)||file.size<2||file.size>MAX_BYTES)throw Error(`Choose a complete backup JSON file, at most ${WORKSPACE_BACKUP_MIB} MiB.`);
      const bytes=await file.slice(0,MAX_BYTES+1).arrayBuffer();if(bytes.byteLength>MAX_BYTES)throw Error(`Backup file exceeds ${WORKSPACE_BACKUP_MIB} MiB.`);
      const selected=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));if(!current()||request!==selection)return;
      const result=await api('/api/workspace/backup-preview',{archive:selected,expectedSha256:selected.sha256});
      if(!current()||request!==selection)return;
      preview=readWorkspaceBackupPreview(result,selected.sha256);archive=selected;
    }catch{if(!current()||request!==selection)return;error='Could not validate this backup. Keep the original file and its separately recorded digest.';}
    if(!current()||request!==selection)return;busy=false;render();
  }
  function render(){
    if(!canInspectWorkspaceBackup(getContext())){root.replaceChildren(el('p',{},'Workspace backup is available to the signed-in owner.'));return;}
    recovery.render();root.replaceChildren(...[el('h3',{},'Workspace backup'),
      el('p',{},'Download retained history, operation receipts and required Git commit references. Package Git objects separately on your computer.'),
      el('button',{type:'button',class:'button button-small',disabled:busy,onclick:download},'Download backup metadata'),
      el('p',{class:'small'},'Metadata alone cannot recover code. Offline recovery restores isolated Git repositories and history; it does not resume work or install an active database.'),
      el('label',{for:'workspace-backup-file'},'Preview a saved backup'),
      el('input',{id:'workspace-backup-file',type:'file',accept:'.json,application/json',disabled:busy,onchange:event=>inspect(event.target.files?.[0])}),
      el('p',{class:'small'},'The selected file is sent to this private app for validation only. It is not stored or applied.'),
      busy?el('p',{role:'status'},'Reading backup metadata…'):null,error?el('p',{role:'alert'},error):null,
      preview?el('div',{},el('p',{},`${preview.counts.projects} repositories · ${preview.counts.resources} Git recovery resources · ${preview.counts.operations} operation receipts`),
        el('table',{},el('caption',{},'Complete retained record coverage'),el('thead',{},el('tr',{},...['Collection','Current','Historical','Total'].map(name=>el('th',{scope:'col'},name)))),
          el('tbody',{},...[['Repository records','Projects'],['Operation receipts','Operations'],['Task records','Tasks'],['Candidate records','Runs'],['Event records','Events'],['Check policies','Policies']].map(([label,key])=>el('tr',{},
            el('th',{scope:'row'},label),el('td',{},String(preview.counts['current'+key])),el('td',{},String(preview.counts['historical'+key])),el('td',{},String(preview.counts[key.toLowerCase()])))))),
        el('p',{class:'small'},`${preview.counts.operationReports} operation verifier reports · ${preview.counts.repositoryMappings} repository mappings + ${preview.counts.forkMappings} fork mappings = ${preview.counts.gitMappings} Git mappings · ${preview.counts.jobs} job records`),
        el('table',{},el('caption',{},'Provider ledger coverage: current SQL and retained historical captures'),el('thead',{},el('tr',{},...['Ledger','Current','Historical','Total'].map(name=>el('th',{scope:'col'},name)))),
          el('tbody',{},...['artifactSubscriptions','artifactSubscriptionAttempts','artifactEvents','artifactEventAttempts','artifactDeliveries'].map(name=>{
            const suffix=name[0].toUpperCase()+name.slice(1);return el('tr',{},el('th',{scope:'row'},name),el('td',{},String(preview.counts['current'+suffix])),
              el('td',{},String(preview.counts['historical'+suffix])),el('td',{},String(preview.counts[name])));}))),
        el('p',{class:'small'},'Phase and status counts below include historical imports. They do not authorize resuming any effect.'),
        el('p',{class:'small'},`${preview.counts.artifactSubscriptions} artifact subscriptions: reserved ${preview.counts.reservedArtifactSubscriptions} · creating ${preview.counts.creatingArtifactSubscriptions} · bound ${preview.counts.boundArtifactSubscriptions} · ready ${preview.counts.readyArtifactSubscriptions}`),
        el('p',{class:'small'},`${preview.counts.artifactSubscriptionAttempts} subscription attempts: pending ${preview.counts.pendingArtifactSubscriptionAttempts} · complete ${preview.counts.completedArtifactSubscriptionAttempts} · failed ${preview.counts.failedArtifactSubscriptionAttempts} · superseded ${preview.counts.supersededArtifactSubscriptionAttempts}`),
        el('p',{class:'small'},`${preview.counts.artifactEvents} artifact events: pending ${preview.counts.pendingArtifactEvents} · complete ${preview.counts.completedArtifactEvents} · failed ${preview.counts.failedArtifactEvents}`),
        el('p',{class:'small'},`${preview.counts.artifactEventAttempts} event attempts: pending ${preview.counts.pendingArtifactEventAttempts} · complete ${preview.counts.completedArtifactEventAttempts} · failed ${preview.counts.failedArtifactEventAttempts} · superseded ${preview.counts.supersededArtifactEventAttempts} · ${preview.counts.artifactDeliveries} delivery identities`),
        el('p',{class:'small'},'Workflow and provider-effect ledgers were captured in one coherent SQLite read transaction.'),
        el('p',{},`${preview.counts.pendingOperations} unresolved operation receipts · ${preview.counts.unsettledJobs} unsettled job records. No work will be resumed.`),
        el('p',{class:'small'},`Source workspace ${preview.sourceWorkspaceId} · revision ${preview.sourceRevision} · digest ${preview.archiveSha256}`),
        ...preview.projects.map(project=>el('p',{class:'small'},`${project.name} · ${project.commits} required commits`)),
        ...preview.priorImports.map(item=>el('p',{class:'small'},`Prior historical workspace ${item.workspaceId} · ${item.id} · ${item.counts.tasks} task records`)),
        ...preview.resources.filter(resource=>resource.kind!=='project').map(resource=>el('p',{class:'small'},`Unattached Git resource ${resource.id} · ${resource.commits} required commits · recovery anchor ${resource.anchorCommit}`))):null,
      recovery.root,
      el('details',{},el('summary',{},'Recover offline and understand the boundary'),
        el('p',{},'Use scripts/workspace-bundle.mjs from the source checkout to package every referenced commit from explicit local repositories. Record the returned manifest digest separately. Restore only to a new directory.'),
        el('p',{},`Backup metadata is bounded at ${WORKSPACE_BACKUP_MIB} MiB and ${BACKUP_LIMITS.currentProjects} current repositories. Current and historical records share the other limits. Encoded and expanded Git objects each have an aggregate 64 MiB budget, with at most 16,384 objects. Exceeding a limit fails; nothing is silently truncated. A checksum proves integrity, not who created an archive.`),
        el('p',{},'Credentials, access grants and runnable jobs are excluded. Historical decisions remain history. Unresolved receipts are retained; an expired lease does not prove an external process stopped. Reconnecting restored code to a live installation requires separate owner action and fresh authorization.'))].filter(Boolean));
  }
  render();return root;
}
