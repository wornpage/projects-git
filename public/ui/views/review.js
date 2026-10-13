import {$, el, panel, shortSha, dateTime} from '../dom.js';
import {candidateOutcome, reviewContext} from '../../workbench-state.js';
import {mergeReportPanel, earlierReportPanel} from '../workbench-parts.js';
import {independentReviewBinding,independentReviewStatus} from '../../review-boundary.js';
import {reviewerChoices,reviewRequestLabel,humanReviewLink,reviewNextStep} from '../../review-handoff.js';

export function createReviewView({
  getContext,
  parts, disclosure, currentTask, currentRun, taskRuns, reviewPanel, publicationPanel, downloadReviewContext,
  verificationDrafts, actionFeedback, actionKey, actionNotice,
  mutate, runOperation, sha256Text, refresh, finishBaseUpdate, openContinuation, independentlyVerified, openInspector, onSectionChange, switchView, captureReviewSurface
}) {
  const {emptyState, taskHeader, candidateNav, evidenceChecks, diffPanel} = parts;
  const findingDecisionDrafts = new Map();
  const reviewerSelections = new Map();
  const reviewerNameDrafts = new Map();
  const decisionLabel = value => value === 'changes_requested' ? 'Changes requested' : value === 'pass' ? 'Passed' :
    value === 'resolved' ? 'Resolved' : value === 'deferred' ? 'Deferred' : value === 'dismissed' ? 'Dismissed' : value;
  const countLabel = (count, singular, plural) => `${count} ${count === 1 ? singular : plural}`;
  async function revealVerification(workspaceId, taskId, runId, surfaceCurrent) {
    if (!await refresh(true) || !surfaceCurrent()) return false;
    const current = getContext();
    if (current.workspace.id === workspaceId && current.view === 'review' && current.selectedTask === taskId && current.selectedRun === runId) {
      await switchView('review', taskId, runId, {section:'verification'});
      return true;
    }
    return false;
  }
  function reviewerAssignmentPanel(workspace,run) {
    const actor=workspace.authentication?.principal;
    if(getContext().demo||workspace.provider!=='cloudflare-artifacts'||actor?.kind!=='owner'||!['awaiting_review','accepted'].includes(run.status))return null;
    const options=reviewerChoices(workspace);
    const current=run.reviewAssignments?.at(-1);
    const assignmentId=current?.id;
    const requestState=workspace.reviewRequests?.[run.id]??(current?'unknown':'unassigned');
    const selectionKey=[workspace.id,run.id,current?.id??'unassigned'].join(':');
    if(!reviewerSelections.has(selectionKey))reviewerSelections.set(selectionKey,new Set(current?.reviewerIds??[]));
    const selected=reviewerSelections.get(selectionKey),task=workspace.tasks.find(task=>task.id===run.taskId);
    for(const id of selected)if(!options.some(option=>option.id===id))selected.delete(id);
    const selectedCount=el('p',{class:'small',role:'status'},`${selected.size} / 8 reviewers selected`);
    const canAssign=independentlyVerified(run)&&run.evidence?.total>0&&run.evidence.passed===run.evidence.total&&run.evidence.exitCode===0&&!run.verificationPending;
    const assignButton=el('button',{id:'assign-reviewers-'+run.id,type:'submit',class:'button button-small',
      disabled:getContext().busy||!selected.size||selected.size>8||!canAssign,'aria-describedby':'reviewer-selection-help-'+run.id},current?'Renew review request':'Request review');
    const assigned=options.filter(option=>current?.reviewerIds.includes(option.id));
    const canShare=current&&['pending','pass','changes_requested'].includes(requestState);
    const humanAssigned=assigned.some(option=>option.kind==='human');
    const agentAssigned=assigned.some(option=>option.kind==='agent');
    const notice=el('p',{class:'small review-link-notice',role:'status','aria-live':'polite'});
    const link=humanAssigned&&canShare?humanReviewLink(location.origin,location.pathname??'',workspace.id,run.id,current.id):null;
    const linkField=link?el('input',{id:'human-review-link-'+run.id,readonly:true,value:link}):null;
    const copy=link?el('button',{type:'button',class:'button button-small',disabled:getContext().busy,onclick:async()=>{
      const latest=getContext().workspace,latestRun=latest.runs.find(item=>item.id===run.id);
      if(latest.id!==workspace.id||latestRun?.reviewAssignments?.at(-1)?.id!==assignmentId||!['pending','pass','changes_requested'].includes(latest.reviewRequests?.[run.id])){
        notice.textContent='This request changed. Refresh it before copying a review link.';return;
      }
      try{await navigator.clipboard.writeText(link);notice.textContent='Link copied. Send it to the assigned person; sign-in is still required.';}
      catch{linkField.focus();linkField.select();notice.textContent='Clipboard unavailable. Copy the selected link and send it to the assigned person.';}
    }},'Copy human review link'):null;
    const naming=options.length?el('details',{class:'reviewer-names'},el('summary',{},'Reviewer names and identities'),
      el('p',{class:'small'},'Names help you recognize reviewers already configured for this workspace. Saving a name does not invite anyone or change access or recorded review attribution.'),
      options.map(option=>{
        const key=workspace.id+':'+option.id;
        if(!reviewerNameDrafts.has(key))reviewerNameDrafts.set(key,workspace.reviewerNames?.[option.id]??'');
        const input=el('input',{id:'reviewer-name-'+option.id,value:reviewerNameDrafts.get(key),required:true,maxlength:80,
          placeholder:option.kind==='human'?'e.g. Alex Chen':'e.g. Code review agent',disabled:getContext().busy,
          oninput:event=>reviewerNameDrafts.set(key,event.target.value)});
        return el('form',{class:'reviewer-name-form',onsubmit:async event=>{
          event.preventDefault();const latest=getContext().workspace;if(getContext().busy||latest.id!==workspace.id)return;
          const result=await mutate(()=>runOperation('/api/workspace/reviewer-name',{reviewerId:option.id,name:input.value,expectedVersion:latest.version}),
            'Reviewer display name saved. Permissions are unchanged.',{key:actionKey('reviewer-name:'+option.id,task,run),pending:'Saving reviewer name.'});
          if(result){reviewerNameDrafts.delete(key);await refresh(true);}
        }},el('label',{for:'reviewer-name-'+option.id},option.role+' display name'),input,
          el('code',{class:'reviewer-identity'},option.id),el('button',{type:'submit',class:'button button-small',disabled:getContext().busy},'Save name'));
      })):null;
    return el('section',{class:'reviewer-assignment'},el('h3',{},'Request independent review'),
      el('p',{class:'review-request-status','data-state':requestState,role:'status'},reviewRequestLabel(requestState)),
      current ? el('p',{class:'head-hint'},`${current.reviewerIds.length} reviewer${current.reviewerIds.length===1?'':'s'} assigned · ${dateTime(current.at)}`) : null,
      current ? el('p',{},'Assigned to: '+current.reviewerIds.map(id=>options.find(option=>option.id===id)?.name??'Reviewer no longer allowed').join(', ')) : null,
      !options.length?el('p',{class:'head-hint'},'An operator must first allow the reviewer in Cloudflare Access and this workspace. There is no email invitation or self-enrollment here.'):null,
      options.length?
      el('form',{onsubmit:async event=>{
        event.preventDefault();if(getContext().busy||!task||!selected.size||selected.size>8||!canAssign)return;
        const currentWorkspace=getContext().workspace;
        if(currentWorkspace.id!==workspace.id)return;
        const contextId=await sha256Text(JSON.stringify(independentReviewBinding(currentWorkspace,run)));
        const result=await mutate(()=>runOperation(`/api/runs/${run.id}/review-assignments`,{
          contextId,expectedVersion:currentWorkspace.version,reviewerIds:[...selected]}),
        'Review assigned. No notification was sent and no agent was started. Follow the handoff instructions.',
        {key:actionKey('review-assignments',task,run),pending:'Assigning reviewers to this exact candidate.'});
        if(result)await refresh(true);
      }},el('fieldset',{class:'reviewer-choices'},el('legend',{},'Configured reviewers'),options.map(option=>el('label',{class:'reviewer-choice'},
        el('input',{type:'checkbox',checked:selected.has(option.id),disabled:getContext().busy,onchange:event=>{
          if(event.target.checked)selected.add(option.id);else selected.delete(option.id);
          selectedCount.textContent=`${selected.size} / 8 reviewers selected`;
          assignButton.disabled=getContext().busy||!selected.size||selected.size>8||!canAssign;}}),
        el('span',{class:'reviewer-choice-text'},el('strong',{},option.name),el('span',{class:'small'},option.role))))),
      selectedCount,el('p',{id:'reviewer-selection-help-'+run.id,class:'small'},!canAssign?'Finish current passing checks before requesting review.':current?
        'Renewing replaces the current request and any acceptance. A fresh assessment is required.':'Select one to eight configured reviewers, then save the request.'),assignButton):null,
      disclosure('review-delivery-'+run.id,'Review delivery instructions',el('div',{class:'review-handoff'},
        el('p',{},'Assigning records the request only. No email is sent and no reviewer agent is launched.'),
        !current?el('p',{class:'small'},'After assigning, give the agent its review task or copy the human review link.'):null,
        current&&!canShare?el('p',{class:'small'},'Refresh the candidate and checks, then renew the request before handing it off.'):null,
        agentAssigned?el('p',{},'Agent review: give the task to a separate agent session using its reviewer credentials. It reads the assigned review context and submits an assessment.'):null,
        humanAssigned?el('p',{},'Human review: send the link yourself. The assigned person signs in and reviews the candidate. Login codes authenticate them; they are not review invitations.'):null)),
      link?el('div',{class:'review-link'},el('label',{for:'human-review-link-'+run.id},'Link for the saved human review assignment'),linkField,copy,notice):null,
      naming);
  }
  function assessmentDetails(workspace, run, assessment) {
    if (!Array.isArray(assessment.findings)) return el('p',{},`Historical prose assessment: ${assessment.findings}`);
    return el('div',{class:'review-assessment-details'},el('p',{class:'review-assessment-summary'},assessment.summary),assessment.findings.length
      ? el('ol',{class:'review-findings','aria-label':'Review findings'},assessment.findings.map(finding=>el('li',{},
          el('strong',{},`P${finding.priority} · ${finding.title}`),
          el('p',{class:'review-finding-location'},`${finding.location.path} · ${finding.location.side === 'head' ? 'current source' : 'baseline'} · ${finding.location.startLine === finding.location.endLine ? `line ${finding.location.startLine}` : `lines ${finding.location.startLine}–${finding.location.endLine}`}`),
          el('p',{},finding.body),el('p',{class:'head-hint'},finding.evidence),
          findingHistory(workspace,run,assessment,finding))))
      : el('p',{class:'head-hint'},'No new findings recorded.'),
      assessment.resolvedPriorFindingIds?.length ? el('p',{class:'head-hint'},`${countLabel(assessment.resolvedPriorFindingIds.length,'earlier blocking finding','earlier blocking findings')} explicitly resolved in this assessment.`) : null,
      assessment.unresolvedFindingIds?.length ? el('p',{class:'head-hint'},`${countLabel(assessment.unresolvedFindingIds.length,'blocking finding','blocking findings')} remained open after this assessment.`) : null);
  }
  function findingHistory(workspace, run, assessment, finding) {
    const history=(run.findingDecisions??[]).filter(item=>item.assessmentId===assessment.id&&item.findingId===finding.id);
    const status=history.length ? `Latest owner decision: ${decisionLabel(history.at(-1).decision)}` : 'No owner finding decision recorded';
    const canDecide=workspace.authentication?.principal?.kind==='owner';
    const key=assessment.id+':'+finding.id;
    if(!findingDecisionDrafts.has(key))findingDecisionDrafts.set(key,{decision:'resolved',note:''});
    const draft=findingDecisionDrafts.get(key);
    const task=workspace.tasks.find(task=>task.id===run.taskId);
    return el('div',{class:'finding-history'},el('p',{class:'head-hint'},status),
      history.length ? el('ol',{class:'finding-decision-history','aria-label':'Finding decision history'},history.map(item=>el('li',{},
        el('strong',{},decisionLabel(item.decision)),el('span',{class:'head-hint'},`${item.identity.displayName} · ${dateTime(item.at)}`),el('p',{},item.note)))) : null,
      canDecide && task ? el('form',{class:'finding-decision-form',onsubmit:async event=>{
        event.preventDefault();if(getContext().busy)return;
        const result=await mutate(()=>runOperation(`/api/runs/${run.id}/findings/${finding.id}/decision`,{
          assessmentId:assessment.id,decision:draft.decision,note:draft.note,expectedVersion:getContext().workspace.version}),
        'Finding decision recorded. The independent assessment and owner acceptance remain separate.',
        {key:actionKey('finding-decision',task,run),pending:'Recording this finding decision.'});
        if(result){findingDecisionDrafts.delete(key);await refresh(true);}
      }},
        el('label',{},'Owner finding decision',el('select',{value:draft.decision,onchange:event=>{draft.decision=event.target.value;}},
          el('option',{value:'resolved'},'Resolved'),el('option',{value:'deferred'},'Deferred'),el('option',{value:'dismissed'},'Dismissed'))),
        el('label',{},'Decision note',el('textarea',{required:true,maxlength:2000,oninput:event=>{draft.note=event.target.value;}},draft.note)),
        el('button',{id:'finding-decision-'+finding.id,type:'submit',class:'button button-small',disabled:getContext().busy},'Record finding decision')) : null);
  }
  function independentReviewPanel(workspace, run) {
    const state = independentReviewStatus(workspace, run), assessment = run.codeReview;
    const hosted = workspace.provider === 'cloudflare-artifacts';
    const demo = getContext().demo;
    const actor=workspace.authentication?.principal;
    const canReadContext=workspace.authentication?.permissions.review || actor?.kind==='reviewer'&&run.reviewAssignments?.at(-1)?.reviewerIds.includes(actor.id);
    const next = reviewNextStep(workspace, run, {demo});
    const requestControls = reviewerAssignmentPanel(workspace, run);
    const resultLabel = demo ? 'Sample review: ' + ({passed:'passed',pending:'not recorded','changes-requested':'changes requested',stale:'stale',historical:'historical',invalid:'invalid',unavailable:'unavailable'}[state.state]) : state.label;
    const boundaries = el('ol', {class:'review-boundaries', 'aria-label':'Review authority boundaries'},
      el('li',{},el('strong',{},'Builder'),el('span',{},'Produces the candidate commit')),
      el('li',{},el('strong',{},'Verifier'),el('span',{},'Runs trusted checks')),
      el('li',{},el('strong',{},'Independent reviewer'),el('span',{},'Reads source and records an assessment')),
      el('li',{},el('strong',{},'Owner'),el('span',{},'Sets integration policy and resolves exceptions; can accept or reject and request a guarded merge')));
    return panel('Independent code review',el('div',{class:'panel-body'},
      el('div',{class:'review-result','data-state':state.state},el('p',{class:'review-result-label',role:'status'},resultLabel),
        demo ? el('p',{class:'small review-sample-note'},'Illustrative review · invented example records. Browsing does not authenticate a reviewer or run checks.') : null,
        !demo && !hosted ? el('p',{class:'small'},'Local loopback decisions are attribution. This mode does not authenticate an independent reviewer or establish a security boundary between local processes.') : null),
      el('section',{class:'review-next-step','aria-label':'Next review step'},
        el('h3',{},'Next step'),el('p',{class:'review-next-owner'},next.owner),el('p',{},next.next),
        el('dl',{class:'review-waiting'},el('dt',{},'Waiting on'),el('dd',{},next.waiting.length === 0 ? 'Nothing for this candidate.' : next.waiting.length === 1 ? next.waiting[0] : el('ul',{},next.waiting.map(text=>el('li',{},text))))),
        el('p',{class:'small review-integration-mode'},'Integration: '+next.integration)),
      assessment ? el('article',{class:'review-assessment-card'},
        el('h3',{},state.passed ? 'Recorded assessment' : state.state === 'changes-requested' ? 'Requested changes' : 'Earlier assessment · not current approval'),
        el('p',{class:'review-assessment-meta'},`${assessment.identity.displayName} · ${dateTime(assessment.at)} · commit ${shortSha(assessment.context.headCommit)}`),
        assessmentDetails(workspace,run,assessment)) : null,
      !demo && hosted && actor?.kind==='owner' && !workspace.authentication?.reviewerClientIds?.length && !workspace.authentication?.reviewerSubjects?.length ? el('p',{class:'small'},'No independent reviewer is configured. Allowlist a separate Access reviewer identity before owner acceptance.') : null,
      state.passed && requestControls ? disclosure('review-assignment-settings-'+run.id,'Reviewer assignment and renewal',requestControls) : requestControls,
      hosted && canReadContext && ['awaiting_review','accepted'].includes(run.status) && independentlyVerified(run) ? el('button',{id:'review-context-'+run.id,type:'button',class:'button button-small review-context-download',disabled:getContext().busy,onclick:()=>downloadReviewContext(run)},'Download read-only review context') : null,
      disclosure('review-authorities-'+run.id,'Roles and security checks',boundaries,
        el('p',{class:'small'},'These are permission boundaries, not four required people. The coding host runs the agents. Owner-enabled automatic integration handles eligible submissions after current checks and independent review.'),
        el('p',{class:'small'},'Reviewer credentials cannot claim work, edit code, run checks, accept candidates or merge. A changed commit, requirements, owner or verification policy makes the assessment stale.')),
      run.codeReviewHistory?.length ? disclosure('code-review-history-'+run.id, `${run.codeReviewHistory.length} earlier independent assessment(s)`,
        run.codeReviewHistory.map(item=>el('article',{class:'review-assessment-card review-assessment-earlier'},
          el('h3',{},decisionLabel(item.verdict)),
          el('p',{class:'review-assessment-meta'},`${item.identity?.displayName ?? 'Earlier reviewer'} · ${dateTime(item.at)} · commit ${shortSha(item.context.headCommit)}`),
          assessmentDetails(workspace,run,item)))) : null));
  }
  function verificationSetup(task, run) {
    const {workspace, busy} = getContext();
    if (workspace.authentication && !workspace.authentication.permissions.manage) return null;
    const hosted = task.origin === 'artifacts' && task.verificationProfile === 'commands';
    if ((!hosted && task.origin !== 'connected-git') || run.status !== 'awaiting_review' || task.acceptedRunId || task.mergedCommit) return null;
    if (hosted && !workspace.capabilities?.repositoryChecks) return panel('Independent verification', el('p', { class: 'panel-body' }, 'The server needs its repository verification container configured before this candidate can be checked.'));
    const key = reviewContext(workspace, run);
    if (!verificationDrafts.has(key)) verificationDrafts.set(key, { image: '', checks: [{ name: '', command: '', stdin: '', stdout: '', exitCode: 0 }] });
    const draft = verificationDrafts.get(key);
    const image = el('input', { id: 'check-image-' + run.id, value: draft.image, required: true, pattern: 'sha256:[a-f0-9]{64}', placeholder: 'sha256:… (installed Docker image ID)', oninput: event => { draft.image = event.target.value; } });
    const rows = el('div', { class: 'command-check-rows' });
    const addCheck = el('button', {id:'add-check-'+run.id,type:'button',class:'button button-small',
      title:'A check definition can contain up to 12 checks.',onclick:()=>{if(draft.checks.length<12){draft.checks.push({name:'',command:'',stdin:'',stdout:'',exitCode:0});drawRows();}}}, 'Add check');
    const drawRows = () => {
      addCheck.disabled=draft.checks.length>=12;
      rows.replaceChildren(...draft.checks.map((check,index)=> {
        const field = (key, label, multiline = false) => {
          const id = 'check-' + run.id + '-' + index + '-' + key;
          const attrs = { id, name: key, required: ['name','command'].includes(key), maxlength: key === 'name' ? '200' : key === 'command' ? '8192' : '16384', oninput: event => { check[key] = key === 'exitCode' ? Number(event.target.value) : event.target.value; } };
          const input = multiline ? el('textarea', attrs, check[key]) : el('input', { ...attrs, value: check[key], ...(key === 'exitCode' ? { type:'number', min:'0', max:'124' } : {}) });
          return el('div', {}, el('label', { for:id }, label), input);
        };
        return el('fieldset', { class:'command-check' }, el('legend', {}, 'Check ' + (index+1)),
          field('name','Check name'), field('command','Command inside the container'),
          field('stdin','Input · stdin',true), field('stdout','Expected stdout · include any final newline',true), field('exitCode','Expected exit code'),
          draft.checks.length > 1 ? el('button', { type:'button', class:'button button-small', onclick:()=>{draft.checks.splice(index,1);drawRows();} }, 'Remove check') : null);
      }));
    };
    drawRows();
    const resultNotice = el('p', {class:'small',role:'status',hidden:true});
    const reportButton = el('button', {type:'button',class:'button button-small',hidden:true,onclick:()=>loadReport()}, 'Load check report');
    async function loadReport() {
      if (getContext().busy || reportButton.disabled) return;
      const surfaceCurrent=captureReviewSurface(), draftBefore=JSON.stringify(draft);
      reportButton.disabled=true;
      try {
        if (await revealVerification(workspace.id,task.id,run.id,()=>surfaceCurrent()&&JSON.stringify(draft)===draftBefore)) verificationDrafts.delete(key);
      } finally { reportButton.disabled=false; }
    }
    const form = el('form', { class: 'verification-form', onsubmit: async event => {
      event.preventDefault(); if (getContext().busy) return;
      resultNotice.hidden = reportButton.hidden = true;
      const plan = { format: 'repository-command-checks/v1', commit: run.headCommit, taskRevision: task.revision,
        requirementsSha256: await sha256Text(JSON.stringify({ title:task.title, purpose:task.purpose, criteria:task.criteria, revision:task.revision })), timeoutMs:60000,
        checks:draft.checks.map(check=>({name:check.name,argv:['/bin/sh','-lc',check.command],stdin:check.stdin,expected:{exitCode:check.exitCode,stdout:check.stdout}})) };
      const definition = JSON.stringify(plan), definitionSha256 = await sha256Text(definition);
      const result = await mutate(() => runOperation('/api/runs/' + run.id + '/checks', { definition, definitionSha256, ...(hosted ? {} : { image:draft.image.trim() }) }), 'Check request recorded. Follow the verification report for completion and results.',
        {key:actionKey('checks',task,run),pending:'Checking this commit against the saved expectations. Allow up to 60 seconds; recording a request does not mean the checks passed.'});
      if (result) {
        resultNotice.hidden = reportButton.hidden = false;
        resultNotice.textContent = 'Check request recorded. Load the latest report without running the checks again.';
        await loadReport();
      }
    } }, el('p', { class:'small' }, hosted ? 'Choose Node or Python commands and their expected results.' : 'Choose commands and their expected results.'),
      el('p', { class:'head-hint' }, 'Commit ' + shortSha(run.headCommit) + ' · Requirements r' + task.revision + ' · 60-second total limit'),
      disclosure('check-runtime-help-'+run.id,'How checks run',
        el('p',{},hosted ? 'Each command runs in a fresh Linux container with the committed files, no Git credentials and no internet access. Expected outputs are compared outside the container. The workspace operator configures other runtimes in its pinned image; the result records that image’s digest.' : 'Commands run in an installed Linux container with read-only source, temporary scratch space and no network. Each result must match its expected exit code and output.'),
        el('p',{},'Choose checks independently of the agent. Written requirements also need review.')),
      hosted ? null : [el('label', { for:image.id }, 'Verification runtime · immutable Docker image'), image], rows,
      addCheck,
      el('button', { id:'check-submit-'+run.id, type:'submit', class:'button button-primary', disabled:busy, title:busy?'Wait for the current operation.':'Run these checks against this exact commit.' }, actionFeedback.get(actionKey('checks',task,run))?.phase==='pending' ? 'Checking commit…' : 'Run independent checks'),
      resultNotice, reportButton, actionNotice(actionKey('checks',task,run)));
    return el('button',{type:'button',class:'button button-small',onclick:()=>openInspector('Independent check setup',form)},run.evidence?'Configure checks for this revision':'Configure independent checks');
  }

  function revisionEvidence(run) {
    const {workspace, busy} = getContext();
    const task = workspace.tasks.find(task => task.id === run.taskId);
    const revision = task.revision ?? 1;
    const checked = run.evidence ? run.evidence.taskRevision ?? 1 : null;
    const stale = !!run.evidence && checked !== revision;
    const commands = task.origin === 'connected-git' || task.verificationProfile === 'commands';
    const hasChecks = run.checksConfigured || task.origin === 'connected-git' && run.evidence;
    const canVerify = !task.acceptedRunId && !task.mergedCommit && run.status === "awaiting_review" && workspace.capabilities?.verify && !independentlyVerified(run) && (!commands || hasChecks && !stale);
    const earlier=earlierReportPanel(workspace,run,disclosure);
    if (!stale && !canVerify && !earlier) return null;
    if (!stale && !canVerify) return earlier;
    return panel("Requirements and retained proof", el("div", { class: "panel-body" },
      el("p", {}, `Current requirements: revision ${revision}. ` + (checked === null ? 'No report recorded for this candidate yet.' : `This report: revision ${checked}.`)),
      stale ? el("p", { class: "inline-error" }, "The requirements changed. The commit is retained, but its earlier checks cannot authorize acceptance.") : null,
      el("p", { class: "small muted" }, commands && stale ? 'Open Configure checks for this revision below. Review and update the definition before running it; the previous definition cannot check revised requirements.' : commands ? 'Checks are pinned to a commit and requirements revision. Configure current checks below when requirements change.' : 'Rechecking runs the independent checkout contract without generating code. Additional written criteria still require human review.'),
      canVerify ? el("button", { id:'recheck-'+run.id, type:'button', class: "button button-small", disabled: busy, title: busy ? 'Wait for the current action to finish.' : 'Recheck this exact commit against the current requirements.', onclick: async () => {
        const result = await mutate(() => runOperation(`/api/runs/${encodeURIComponent(run.id)}/verify`, { headCommit: run.headCommit, taskRevision: revision }), 'Recheck request recorded. Follow the current verification report before accepting.',
          {key:actionKey('recheck',task,run),pending:'Rechecking the retained commit against current requirements. No agent code is regenerated.'});
        if (result) await revealVerification(workspace.id, task.id, run.id, captureReviewSurface());
      } }, run.evidence ? "Recheck retained commit" : "Run preserved checks") : null,
      canVerify ? actionNotice(actionKey('recheck',task,run)) : null,
      earlier));
  }

  function baseUpdatePanel(task, run) {
    const {workspace, busy} = getContext();
    if (workspace.authentication && !workspace.authentication.permissions.manage) return null;
    const project = workspace.projects?.[task.projectId];
    if (!project || task.mergedCommit || !run?.headCommit || run.status === 'superseded') return null;
    const advanced = project.mainCommit !== task.baseCommit;
    if (!advanced && workspace.provider !== 'cloudflare-artifacts') return null;
    const active = taskRuns(task.id).some(run => ['assigned', 'running'].includes(run.status));
    const client = workspace.authentication ? el('select', {id:'resolution-client',required:true}, el('option',{value:''},'Choose an Access agent client'), workspace.authentication.agentClientIds.map(id=>el('option',{value:id},id))) : null;
    async function update(mode) {
      if (mode === 'resolve' && client && !client.reportValidity()) return;
      const result = await mutate(() => runOperation('/api/runs/' + run.id + '/update-base', { headCommit: run.headCommit, taskRevision: task.revision, mode, ...(mode === 'resolve' && client ? {agentClientId:client.value} : {}) }),
        mode === 'reapply' ? 'Changes reapplied. Verify and review the new candidate.' : 'Resolution checkout prepared. Previous changes and decisions are retained.',
        {key:actionKey('base',task,run),pending:mode==='reapply' ? 'Reapplying the retained change to current main. A replacement candidate needs fresh checks and review.' : 'Preparing resolution work on current main. The earlier candidate remains in the record.'});
      if (result) await finishBaseUpdate(result, task.id, mode);
    }
    const body = el('div', { class: 'panel-body' },
      client ? el('label',{for:'resolution-client'},'Agent for resolution work',client) : null,
      el('p', { class: 'small' }, 'This candidate starts at ' + shortSha(task.baseCommit) + '; the last observed project main is ' + shortSha(project.mainCommit) + '. The server reads main again before updating. A new candidate keeps the earlier commits, reports and decisions in the record.'),
      el('div', { class: 'review-buttons' },
        el('button', { id:'reapply-'+run.id, type:'button', class: 'button button-primary', disabled: busy || active, title: active ? 'Finish this task’s assigned work first.' : 'Reapply this change to current main. New verification and review are required.', onclick: () => update('reapply') }, 'Update candidate base'),
        el('button', { id:'resolve-'+run.id, type:'button', class: 'button', disabled: busy || active || !project.acceptingWork, title: !project.acceptingWork ? 'Enable new agent work in the project home.' : 'Prepare a checkout on current main so an agent can resolve the original change.', onclick: () => update('resolve') }, 'Prepare resolution checkout')),
      actionNotice(actionKey('base',task,run)),
      el('p', { class: 'small muted' }, 'If changes conflict, prepare resolution work on current main and use the original candidate’s diff in the handoff. Both paths require fresh verification and review.'));
    return advanced ? panel('Project main has advanced',body) : el('button',{type:'button',class:'button button-small review-base-update',onclick:()=>openInspector('Update candidate base',body)},'Update to newer project code');
  }

  function reviewView() {
    const {workspace, demo} = getContext();
    const task = currentTask();
    if (!task) return panel('Review', emptyState('No candidates yet', 'Open Projects to create work.'));
    const run = currentRun();
    if (!run) return el('div', {}, taskHeader(task), panel('Review', el('p', { class: 'no-candidate' }, 'No candidates have been assigned.')));
    const checks = run.verificationPending ? 'Running' : !run.evidence ? 'Not run' : `${run.evidence.passed} / ${run.evidence.total} · ${independentlyVerified(run) ? 'current' : 'reported'}`;
    const decision = run.status === 'merged' ? 'Merged' : run.review?.decision === 'accept' ? 'Accepted' : run.review?.decision === 'reject' ? 'Rejected' : 'Not recorded';
    const fileCount = run.changedFiles?.length ?? 0;
    const tabs=[['Changes',fileCount+(fileCount===1?' file':' files'),'candidate-changes'],['Checks',checks,'verification'],['Independent review',independentReviewStatus(workspace,run).state,'code-review'],['Owner decision',decision,'review-decision']];
    const fragment=typeof location==='object'?location.hash?.slice(1):null;
    const nextSection=workspace.provider==='cloudflare-artifacts' && ['awaiting_review','accepted'].includes(run.status)
      && independentlyVerified(run) && run.evidence.passed===run.evidence.total && run.evidence.total>0 && run.evidence.exitCode===0
      ? independentReviewStatus(workspace,run).passed ? 'review-decision' : 'code-review' : 'verification';
    const active=tabs.some(([, ,id])=>id===fragment)?fragment:nextSection;
    const grid=el('div',{class:'review-grid','data-active-section':active},
      el('div',{class:'review-verification',id:'verification',tabindex:'-1'},evidenceChecks(run),mergeReportPanel(workspace,run,disclosure),revisionEvidence(run),verificationSetup(task,run)),
      el('div',{class:'review-independent',id:'code-review',tabindex:'-1'},independentReviewPanel(workspace,run)),
      el('div',{class:'review-decision'},reviewPanel(run,task)),
      el('div',{class:'review-changes',id:'candidate-changes',tabindex:'-1'},diffPanel(run),
        el('p',{class:'head-hint'},run.label+' · Head '+(run.headCommit||'Awaiting commit')),
        run.error?el('p',{class:'inline-error'},run.error):null));
    const links=tabs.map(([label,value,id])=>el('a',{href:'#'+id,'aria-controls':id,'aria-current':id===active?'location':null,
      onclick:event=>{
        event.preventDefault();grid.setAttribute('data-active-section',id);
        links.forEach((link,index)=>{if(tabs[index][2]===id)link.setAttribute('aria-current','location');else link.removeAttribute('aria-current');});
        if(typeof history==='object')history.replaceState(history.state,'','#'+id);
        onSectionChange(id);
        const target=document.getElementById(id);
        target?.focus({preventScroll:true});
        target?.scrollIntoView({block:'start',behavior:'instant'});
      }},el('span',{},label),el('strong',{},value)));
    const hasPrerequisites = Boolean(task.dependsOn?.length);
    return el('div',{},
      hasPrerequisites ? taskHeader(task) : el('p',{class:'review-identity'},task.title+' · Requirements r'+(task.revision??1)),
      baseUpdatePanel(task,run),
      publicationPanel(task,run),
      el('nav',{class:'review-jumps','aria-label':'Review sections'},links),
      el('p',{class:'review-next'},candidateOutcome(workspace,run).next),
      grid,
      disclosure('review-context-'+task.id+'-'+run.id,'Task brief, candidate details and agent summary',
        hasPrerequisites ? null : taskHeader(task),
        candidateNav(task,demo ? null : el('button',{id:'continue-agent-'+run.id,class:'button button-small',onclick:()=>openContinuation(run.id)},'Continue in your agent ↗')),
        run.summary?el('p',{class:'review-agent-summary'},run.summary):null));
  }
  return reviewView;
}
