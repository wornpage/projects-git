import {el, panel, dateTime, restoreFocus} from './dom.js';

export function publicationLabel(record) {
  if (!record) return 'Locally merged';
  return {pending:'Publication incomplete', needs_attention:'Publication needs attention', open:'PR open', closed:'PR closed without merge',
    merged:'Merged on GitHub', changed:'GitHub source changed'}[record.status] ?? 'Unknown publication state';
}

export function publicationLink(record) {
  return /^https:\/\/github\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+\/pull\/[1-9][0-9]*$/i.test(record?.pr?.url ?? '')
    ? el('a', {href:record.pr.url, target:'_blank', rel:'noopener noreferrer'}, 'Open PR #' + record.pr.number + ' ↗') : null;
}

export function createPublicationView({getContext, captureSession, api, mutate, refresh, openInspector, downloadHandoff}) {
  function details(binding) {
    return el('dl', {class:'publication-details'}, [
      ['Private repository',binding.repository], ['Target branch',binding.baseBranch], ['GitHub base commit',binding.local.baseCommit],
      ['New branch',binding.headBranch], ['Approved commit',binding.local.headCommit], ['Requirements', 'Revision ' + binding.local.taskRevision]
    ].map(([name,value])=>el('div',{},el('dt',{},name),el('dd',{},value))));
  }

  function scoped(run) {
    const {workspace,selectedRun,selectedTask,view}=getContext(), workspaceId=workspace.id, isCurrent=captureSession();
    const selected=selectedRun===run.id || !selectedRun&&selectedTask===run.taskId;
    return ()=>selected && isCurrent() && getContext().workspace?.id===workspaceId
      && getContext().selectedRun===selectedRun && getContext().view===view
      && getContext().workspace.runs.some(item=>item.id===run.id&&item.headCommit===run.headCommit);
  }

  async function update(run, record, action) {
    const isCurrent=scoped(run);
    if(!isCurrent())return null;
    const result=await mutate(()=>api(`/api/runs/${run.id}/publication/${record.id}/${action}`,{}),'GitHub publication status recorded.');
    if(result&&isCurrent()){await refresh(true);return isCurrent()?result:null;}
    return null;
  }

  function recordBody(run, record, disabled, scope) {
    let current=record,updating=false;
    const root=el('div',{});
    const actionId=name=>scope==='panel'&&name==='refresh'?'publication-action-'+run.id:`publication-${scope}-${name}-${run.id}`;
    async function action(name){
      if(updating)return;
      const isCurrent=scoped(run);if(!isCurrent())return;
      updating=true;render();
      try {const result=await update(run,current,name);if(result)current=result;}
      finally {updating=false;if(isCurrent()){if(root.isConnected)render();restoreFocus({id:actionId(name)});}}
    }
    function render(){
      const canResume=!current.pr && current.status!=='changed' && !current.prStartedAt
        && (!current.pushStartedAt || current.branchHead===current.binding.local.headCommit);
      root.replaceChildren(...[
      el('p',{role:'status'},publicationLabel(current)),publicationLink(current),
      current.error?el('p',{class:'inline-error'},current.error.message):null,
      current.pr?.mergeCommit?el('p',{class:'small'},'GitHub merge commit · '+current.pr.mergeCommit):null,
      el('p',{class:'small'},'Last checked · '+dateTime(current.lastCheckedAt)),
      el('div',{class:'review-buttons'},
        el('button',{id:actionId('refresh'),type:'button',class:'button button-small',disabled:disabled||updating,onclick:()=>action('refresh')},'Refresh GitHub status'),
        canResume?el('button',{id:actionId('resume'),type:'button',class:'button button-small',disabled:disabled||updating,onclick:()=>action('resume')},'Continue publication'):null),
      el('button',{type:'button',class:'text-link',onclick:()=>openInspector('Publication record',details(current.binding),
        el('ol',{class:'publication-history'},current.observations.map(item=>el('li',{},el('strong',{},publicationLabel(item)),el('p',{},item.message),el('span',{class:'small'},dateTime(item.at))))))},'Read publication history')].filter(Boolean));
    }
    render();return root;
  }

  async function preview(run) {
    const isCurrent=scoped(run);
    if(!isCurrent())return;
    const prepared=await mutate(()=>api(`/api/runs/${run.id}/publication/preview`,{}),'Publication preview prepared.');
    if(!prepared||!isCurrent())return;
    restoreFocus({id:'publication-action-'+run.id});
    const request={previewId:prepared.id,requestId:crypto.randomUUID()};
    let submitted=false;
    const confirm=el('button',{type:'button',class:'button button-primary',onclick:async()=>{
      if(submitted||!isCurrent())return;
      submitted=true;confirm.disabled=true;confirm.textContent='Publishing…';
      const result=await mutate(()=>api(`/api/runs/${run.id}/publication/publish`,request),'GitHub publication status recorded.');
      if(!isCurrent())return;
      await refresh(true);
      if(!isCurrent()||!body.isConnected)return;
      body.replaceChildren(result?recordBody(run,result,false,'dialog'):el('p',{role:'alert'},'Publication was not confirmed. Close this preview and refresh the saved record before taking another action.'));
    }},'Publish private PR');
    const body=el('div',{class:'publication-preview'},details(prepared.binding),
      el('p',{},'Create this dedicated branch and a private pull request. Repository workflows may run. GitHub merge and deployment remain separate actions.'),
      el('p',{class:'small'},'Preview expires · '+dateTime(prepared.expiresAt)),
      el('h3',{},prepared.title),el('pre',{class:'publication-body'},prepared.body),
      el('div',{class:'review-buttons'},confirm));
    openInspector('Publish to GitHub',body);
  }

  return function publicationPanel(task,run) {
    const {workspace,busy}=getContext();
    if(workspace.provider==='cloudflare-artifacts'&&run.status==='merged'&&workspace.authentication?.permissions.manage&&downloadHandoff)
      return panel('Deliver to GitHub from your machine',el('div',{class:'panel-body publication-panel'},
        el('p',{},'Export this merged task, then use the operator-local delivery CLI with your exact Git objects and a private GitHub target. GitHub credentials stay on your machine.'),
        el('p',{class:'small'},'An export is historical evidence. Review its digest, candidate and target before approving local delivery. Creating a PR can run repository workflows; GitHub merge and deployment are separate.'),
        el('button',{type:'button',class:'button button-small',disabled:busy,onclick:()=>downloadHandoff(task)},'Export task for local delivery'),
        el('details',{},el('summary',{},'Local delivery instructions'),
          el('p',{},'In your source checkout, run node scripts/hosted-github-delivery.mjs --help. Follow docs/github-publication.md, including the offline prepare step and explicit preview and approval.'),
          el('p',{class:'small'},'Use a trusted local clone or verified recovery repository containing the recorded base and head. A rendered diff cannot recreate the original commit.'))));
    if(workspace.provider!=='local-git'||task.origin!=='connected-git'||run.status!=='merged')return null;
    const record=run.publication,configured=workspace.capabilities?.publish===true&&Boolean(workspace.githubPublication);
    const disabled=busy||workspace.repositoryWorkflow?.busyTaskIds?.includes(task.id)||!configured;
    return panel('Publish to GitHub',el('div',{class:'panel-body publication-panel'},
      el('ol',{class:'publication-steps','aria-label':'Repository progress'},
        el('li',{},'Locally merged'),el('li',{},record?.pr?'PR created':'PR not created'),el('li',{},record?.status==='merged'?'Merged on GitHub':'GitHub merge not recorded')),
      record?recordBody(run,record,disabled,'panel'):configured?el('div',{},
        el('p',{},'Your local merge is saved. Preview publication to the configured private repository: '+workspace.githubPublication.repository+'.'),
        el('button',{id:'publication-action-'+run.id,type:'button',class:'button button-small',disabled,onclick:()=>preview(run)},'Preview GitHub PR')):
        el('p',{},'Your local merge is saved. GitHub publication is not configured on this local server.')));
  };
}
