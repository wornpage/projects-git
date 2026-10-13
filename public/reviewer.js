import {createApiClient} from './api-client.js';
import {createErrorNotice} from './ui/error-notice.js';
import {captureFocus,restoreFocus} from './ui/dom.js';
import {linkedReview,reviewRequestLabel} from './review-handoff.js';
import {highlightSyntax,paintSyntax,syntaxLanguage,syntaxLabel,SYNTAX_RENDER_LINES,syntaxRenderWithinLimit} from './code-syntax.js';
import {recordedDiff} from './review-diff.js';
const byId=id=>document.getElementById(id);
const element=(tag,content='',className='')=>{const node=document.createElement(tag);node.textContent=content;if(className)node.className=className;return node;};
const errors=createErrorNotice(document);
byId('dismiss-error').addEventListener('click',()=>errors.clear());
const status=(message,error=false)=>{const node=byId('status');node.textContent=error?'Review request needs attention.':message;node.className=error?'error':'';
  if(error)errors.show(message,byId('review-submit')?'review-submit':undefined);else errors.clear();};
const pending=new Map(),activeSubmissions=new Map();
let inboxFilter='all',reviewEpoch=0,inboxEpoch=0,viewerKey='',viewerKind='',viewerSession={},refreshReviewControls=()=>{};
let openedLink='';
const api=createApiClient({captureSession:()=>{const session=viewerSession;return()=>session===viewerSession;},onAuthRequired:()=>{byId('reviewer-sign-in').hidden=false;}});

function sourceText(file){
  const binary=atob(file.base64),bytes=Uint8Array.from(binary,char=>char.charCodeAt(0));
  try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}
  catch{return null;}
}

function syntaxControls(onToggle){
  const toolbar=element('div','','syntax-toolbar'),note=element('span'),button=element('button','Syntax colors','syntax-toggle');
  note.setAttribute('role','status');button.type='button';button.setAttribute('aria-pressed','true');
  button.addEventListener('click',onToggle);toolbar.append(note,button);return {toolbar,note,button};
}

function sourcePanel(title,snapshot,paths){
  const section=element('section','','card');section.append(element('h3',title));
  const selected=snapshot.files.filter(file=>paths.includes(file.name));
  if(!selected.length){section.append(element('p','No regular text file on this side of the change.','muted'));return section;}
  const chooser=element('select');chooser.setAttribute('aria-label',title+' file');
  for(const file of selected){const option=element('option',file.name);option.value=file.name;chooser.append(option);}
  const code=element('pre');let enabled=true,generation=0;
  const controls=syntaxControls(()=>{enabled=!enabled;controls.button.setAttribute('aria-pressed',String(enabled));render();});
  const render=()=>{
    const epoch=++generation,file=selected.find(item=>item.name===chooser.value),text=file?sourceText(file):null,language=syntaxLanguage(file?.name);
    controls.button.disabled=!language||text===null;controls.note.textContent=syntaxLabel(language,null,enabled);
    if(text===null){code.textContent=file?'This committed file is not UTF-8 text.':'';controls.note.textContent='Plain text';return;}
    const lines=text.split('\n');if(lines.at(-1)==='')lines.pop();
    const numbered=lines.map((line,index)=>`${String(index+1).padStart(4,' ')} │ ${line}`);
    code.textContent=numbered.join('\n');
    if(!enabled||!language)return;
    if(lines.length>SYNTAX_RENDER_LINES){controls.note.textContent=syntaxLabel(language,{status:'plain',reason:'large'});return;}
    highlightSyntax(file.name,{mode:'source',text}).then(result=>{
      if(epoch!==generation||!code.isConnected)return;
      controls.note.textContent=syntaxLabel(language,result);
      if(result.status!=='colored')return;
      if(!syntaxRenderWithinLimit(result.lines?.slice(0,lines.length))){controls.note.textContent=syntaxLabel(language,{status:'plain',reason:'large'});return;}
      code.replaceChildren();
      lines.forEach((line,index)=>{const row=element('span');paintSyntax(row,line,result.lines?.[index]);
        code.append(document.createTextNode(`${String(index+1).padStart(4,' ')} │ `),row,...(index<lines.length-1?[document.createTextNode('\n')]:[]));});
    });
  };
  chooser.addEventListener('change',render);section.append(chooser,controls.toolbar,code);render();return section;
}

function patchPanel(candidate){
  const section=element('section','','card'),code=element('pre');let enabled=true,generation=0;
  const controls=syntaxControls(()=>{enabled=!enabled;controls.button.setAttribute('aria-pressed',String(enabled));render();});
  const sections=recordedDiff(candidate.diff,candidate.changedFiles).sections;
  const total=sections.reduce((count,item)=>count+item.rows.length,0);
  const render=async()=>{
    const epoch=++generation;code.textContent=candidate.diff;controls.note.textContent=enabled?'Coloring changed files…':'Plain text';
    if(!enabled)return;
    if(total>SYNTAX_RENDER_LINES){controls.note.textContent='Plain text · large change';return;}
    // One section at a time; source is visible immediately and large patches
    // retain their single text node when coloring is deliberately bounded out.
    const results=[];let colored=0;
    for(const item of sections){
      const result=await highlightSyntax(item.path,{mode:'diff',rows:item.rows});
      if(epoch!==generation||!code.isConnected)return;
      results.push(result);if(result.status==='colored')colored++;
    }
    controls.note.textContent=`${colored} / ${sections.length} sections colored`;
    if(!colored)return;
    if(!syntaxRenderWithinLimit(results.flatMap(result=>result.lines??[]))){controls.note.textContent='Plain text · large change';return;}
    code.replaceChildren();let position=0;
    sections.forEach((item,index)=>item.rows.forEach((line,rowIndex)=>{
      const row=element('span','','syntax-row '+line.kind);paintSyntax(row,line.text,results[index].lines?.[rowIndex]);code.append(row);
      if(++position<total||candidate.diff.endsWith('\n'))code.append(document.createTextNode('\n'));
    }));
  };
  section.append(element('h3','Changes'),controls.toolbar,code);render();return section;
}

function findingFields(paths,onRemove){
  const row=element('fieldset');row.append(element('legend','Finding'));
  const field=(label,tag='input')=>{const wrapper=element('label');wrapper.append(element('span',label));const input=element(tag);input.setAttribute('aria-label',label);wrapper.append(input);row.append(wrapper);return input;};
  const title=field('Title'),body=field('Explanation','textarea'),evidence=field('Evidence from this source','textarea');
  for(const input of [title,body,evidence])input.required=true;
  const path=field('Changed file','select');for(const name of paths){const option=element('option',name);option.value=name;path.append(option);}
  const side=field('Source side','select');for(const name of ['head','base']){const option=element('option',name);option.value=name;side.append(option);}
  const priority=field('Priority','select');for(const value of [0,1,2,3]){const option=element('option','P'+value);option.value=String(value);priority.append(option);}priority.value='2';
  const start=field('Start line'),end=field('End line');for(const input of [start,end]){input.type='number';input.min='1';input.step='1';input.value='1';}
  const remove=element('button','Remove finding');remove.type='button';remove.addEventListener('click',()=>onRemove(row));row.append(remove);
  const read=()=>({title:title.value,body:body.value,priority:Number(priority.value),
    location:{path:path.value,side:side.value,startLine:Number(start.value),endLine:Number(end.value)},evidence:evidence.value});
  return {row,read,firstField:title};
}

async function openReview(item,opener=document.activeElement){
  const epoch=++reviewEpoch,session=viewerSession,path=`/api/runs/${item.runId}/code-review`;
  refreshReviewControls=()=>{};
  status('Reading the committed candidate…');const container=byId('review');container.replaceChildren();
  let packet;try{packet=await api(`/api/runs/${item.runId}/review-context`);}catch(error){if(epoch===reviewEpoch)status(error.message,true);return;}
  if(epoch!==reviewEpoch)return;
  if(packet.context.workspaceId!==item.workspaceId||packet.context.runId!==item.runId||packet.context.reviewAssignmentId!==item.assignmentId){
    status('This assignment changed while opening it. Refresh your inbox and ask the owner for the current review link.',true);return;
  }
  const title=element('h2',item.taskTitle+' · '+item.runLabel),context=packet.context;title.id='review-title';title.tabIndex=-1;
  const details=element('section','','card');details.append(title,
    element('p',`Head ${context.headCommit} · Base ${context.baseCommit} · requirements r${context.taskRevision}`),
    element('p',context.requirements?.purpose??''));
  const criteria=element('ol');for(const criterion of context.requirements?.criteria??[])criteria.append(element('li',criterion));
  details.append(criteria,element('p',`Independent checks: ${packet.evidence?.passed??0} / ${packet.evidence?.total??0} reported passing.`));
  const paths=packet.candidate.changedFiles;
  container.append(details,sourcePanel('Candidate source',packet.source,paths),sourcePanel('Task base source',packet.baseSource,paths));
  container.append(patchPanel(packet.candidate));
  const form=element('form','','card'),controls=element('fieldset','','assessment-fields');controls.setAttribute('aria-label','Assessment details');form.append(element('h3','Your assessment'),controls);
  const verdictLabel=element('label','Verdict'),verdict=element('select');
  verdict.setAttribute('aria-label','Verdict');
  for(const [value,label] of [['pass','Pass'],['changes_requested','Changes requested']]){const option=element('option',label);option.value=value;verdict.append(option);}verdictLabel.append(verdict);
  const summaryLabel=element('label','What you inspected and remaining limitations'),summary=element('textarea');summary.required=true;summary.maxLength=2000;summaryLabel.append(summary);
  const resolved=new Set(),prior=packet.priorReview?.unresolvedFindings??[];
  if(prior.length){const previous=element('fieldset');previous.append(element('legend','Earlier blocking findings'));
    previous.append(element('p','Select an earlier finding only after verifying its resolution in this candidate. Unselected findings remain open.','muted'));
    for(const issue of prior){const label=element('label'),checkbox=element('input');checkbox.type='checkbox';checkbox.style.width='auto';
      checkbox.addEventListener('change',()=>{if(checkbox.checked)resolved.add(issue.id);else resolved.delete(issue.id);});
      label.append(checkbox,document.createTextNode(`${issue.title??issue.id} · ${issue.location?.path??'earlier source'}`));previous.append(label);}
    controls.append(previous);
  }
  const findings=element('div'),rows=[];const add=element('button','Add finding');add.type='button';
  const count=element('p','','muted'),canSubmit=viewerKind==='reviewer';
  const submit=element('button','Submit independent assessment');submit.type='submit';submit.id='review-submit';
  function updateButtons(){const total=rows.filter(field=>field.row.isConnected).length;
    const submitting=activeSubmissions.has(path);controls.disabled=!canSubmit||submitting;
    add.disabled=total>=50||!canSubmit;submit.disabled=!canSubmit||submitting||verdict.value==='changes_requested'&&!total;
    count.textContent=submitting?'An assessment for this candidate is still being submitted. Wait for its outcome before submitting again.':
      `${total} / 50 findings. Changes requested requires at least one finding.`;}
  refreshReviewControls=updateButtons;
  add.addEventListener('click',()=>{if(rows.filter(field=>field.row.isConnected).length>=50)return;
    const field=findingFields(paths,row=>{
      const index=rows.findIndex(field=>field.row===row),restore=row.contains(document.activeElement);
      const neighbor=rows[index+1]??rows[index-1];
      rows.splice(index,1);row.remove();updateButtons();
      if(restore)(neighbor?.firstField??add).focus();
    });rows.push(field);findings.append(field.row);updateButtons();field.firstField.focus();});
  verdict.addEventListener('change',updateButtons);
  const actions=element('div','','buttons review-actions');actions.append(add,submit);
  controls.append(verdictLabel,summaryLabel,findings,count,actions);
  if(!canSubmit){controls.disabled=true;form.append(element('p','Only an assigned independent reviewer can submit an assessment. You can inspect the source and recorded evidence.','muted'));}
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(activeSubmissions.has(path)||session!==viewerSession||epoch!==reviewEpoch||submit.disabled)return;
    const body={format:'projects-code-review-assessment/v2',contextId:packet.contextId,
      verdict:verdict.value,summary:summary.value,findings:rows.filter(field=>field.row.isConnected).map(field=>field.read()),
      resolvedPriorFindingIds:[...resolved]};
    const fingerprint=JSON.stringify(body);
    const retrying=pending.get(path)?.fingerprint===fingerprint&&pending.get(path)?.session===session;
    if(!retrying)
      pending.set(path,{fingerprint,key:crypto.randomUUID(),session});
    const request=pending.get(path),clearRequest=()=>{if(session===viewerSession&&pending.get(path)===request)pending.delete(path);};
    activeSubmissions.set(path,request);updateButtons();status('Submitting assessment for this exact source…');
    try{const result=await api(path,body,request.key);
      if(typeof result?.codeReview?.id!=='string'||!result.codeReview.id){
        const error=new Error('The server did not confirm this assessment. Its original request is retained.');error.uncertain=true;throw error;
      }
      clearRequest();
      if(session!==viewerSession||epoch!==reviewEpoch)return;
      const saved=element('p',`Receipt ${result.codeReview.id}`,'pass');form.append(saved);await loadInbox();
      if(epoch===reviewEpoch)status('Assessment recorded. Acceptance and merge are handled separately.');
    }catch(error){if(retrying)error.uncertain=true;
      else if(error.status>=400&&error.status<500&&!['OPERATION_IN_PROGRESS','STATE_CONFLICT'].includes(error.code))clearRequest();
      if(session===viewerSession&&epoch===reviewEpoch)status(error.message+(error.uncertain?' The outcome is not confirmed. Refresh the assigned review before retrying.':''),true);}
    finally{if(activeSubmissions.get(path)===request)activeSubmissions.delete(path);refreshReviewControls();
      if(session===viewerSession&&epoch===reviewEpoch&&submit.isConnected)submit.focus({preventScroll:true});}
  });
  container.append(form);updateButtons();status(`Reviewing ${item.taskTitle} at ${context.headCommit.slice(0,10)}.`);
  if(document.activeElement===opener||document.activeElement===document.body){
    title.focus({preventScroll:true});container.scrollIntoView({behavior:'instant',block:'start'});
  }
}

async function loadInbox(){
  const epoch=++inboxEpoch;
  status('Loading assigned reviews…');
  let inbox;try{inbox=await api('/api/review-inbox');}catch(error){if(epoch===inboxEpoch)status(error.message,true);return;}
  if(epoch!==inboxEpoch)return;
  const identity=[inbox.workspaceId,inbox.principal.kind,inbox.principal.id].join(':');
  if(viewerKey!==identity){viewerSession={};pending.clear();activeSubmissions.clear();refreshReviewControls=()=>{};openedLink='';
    reviewEpoch++;byId('review').replaceChildren();}
  viewerKey=identity;viewerKind=inbox.principal.kind;
  byId('reviewer-sign-in').hidden=true;
  byId('identity').textContent=(inbox.reviewerName?`${inbox.reviewerName} · `:'')+`Signed in: ${inbox.principal.displayName} · ${inbox.principal.kind}`;
  const section=byId('inbox'),focus=captureFocus(section);section.replaceChildren();
  const card=element('section','','card');card.append(element('h2',`${inbox.total} assigned review${inbox.total===1?'':'s'}`));
  const filters=element('div','','buttons'),counts={all:inbox.total,personal:inbox.items.filter(item=>item.assignmentScope==='personal').length,
    team:inbox.items.filter(item=>item.assignmentScope==='team').length};
  filters.setAttribute('role','group');filters.setAttribute('aria-label','Review assignment filter');
  for(const [key,label] of [['all','All'],['personal','Assigned only to me'],['team','Shared assignments']]){
    const button=element('button',`${label} · ${counts[key]}`);button.type='button';button.setAttribute('id','review-filter-'+key);button.setAttribute('aria-pressed',String(inboxFilter===key));
    button.addEventListener('click',()=>{inboxFilter=key;loadInbox();});filters.append(button);
  }
  const reload=element('button','Refresh reviews');reload.type='button';reload.setAttribute('id','review-inbox-refresh');reload.addEventListener('click',async()=>{
    const wasFocused=document.activeElement===reload;reload.disabled=true;
    try{await loadInbox();}finally{reload.disabled=false;if(wasFocused&&document.activeElement===document.body)byId('review-inbox-refresh')?.focus({preventScroll:true});}
  });filters.append(reload);
  card.append(filters);
  const visible=inboxFilter==='all'?inbox.items:inbox.items.filter(item=>item.assignmentScope===inboxFilter);
  if(!visible.length)card.append(element('p','No reviews in this view.','muted'));
  for(const item of visible){const row=element('div','','item'),text=element('div');text.append(element('strong',item.taskTitle),
    element('span',`${item.runLabel} · ${item.headCommit?.slice(0,10)??'No commit'}`),element('span',reviewRequestLabel(item.status),'request-state'));
    if(item.status==='stale')text.append(element('span','Ask the owner to renew the assignment for the current code and checks.'));
    const button=element('button','Inspect candidate');button.type='button';button.disabled=!['pending','pass','changes_requested'].includes(item.status);button.addEventListener('click',async()=>{button.disabled=true;button.textContent='Reading candidate…';
      const opening=openReview(item,button),openingEpoch=reviewEpoch;
      try{await opening;}finally{button.disabled=false;button.textContent='Inspect candidate';if(openingEpoch===reviewEpoch&&button.isConnected&&document.activeElement===document.body)button.focus({preventScroll:true});}});row.append(text,button);card.append(row);}
  section.append(card);restoreFocus(focus);status(inbox.total?'Choose an assigned candidate.':'No reviews are assigned to this identity.');
  const target=linkedReview(location.search,inbox),linkKey=identity+':'+(location.search??'');
  if(target.kind==='unavailable')status('This review link is unavailable to this signed-in identity or workspace. Ask the owner to check your assignment and access.',true);
  else if(target.kind==='stale')status('This review link needs a renewed assignment. Ask the owner for a current link; the old link will not open a different revision.',true);
  else if(target.kind==='ready'&&openedLink!==linkKey){openedLink=linkKey;await openReview(target.item);}
}
await loadInbox();
