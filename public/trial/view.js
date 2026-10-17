import {el} from '../ui/dom.js';
const sample='https://git-demo.projectsdemo.org/?view=projects';
const details=(pairs)=>el('dl',{class:'detail-list'},pairs.map(([term,value])=>el('div',{},el('dt',{},term),el('dd',{},value))));
const duration=ms=>ms%86400000===0?`${ms/86400000} ${ms===86400000?'day':'days'}`:ms%3600000===0?`${ms/3600000} ${ms===3600000?'hour':'hours'}`:ms%60000===0?`${ms/60000} ${ms===60000?'minute':'minutes'}`:`${ms/1000} seconds`;
const expiry=value=>new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'long'}).format(new Date(value));
const titles={checking:'Checking your trial',eligible:'Reserve a private trial',reserving:'Reserving your trial',admitted:'Your trial is reserved',
  'confirm-close':'Your trial is reserved',closing:'Closing your trial',closed:'Trial closed',expired:'Trial access has ended',capacity:'Trial capacity is full',
  failed:'We couldn’t confirm your trial',signedOut:'Verify your email to continue',blocked:'This login can’t start a trial'};
const errors={TRIAL_POLICY_CHANGED:'Trial settings changed. Check your status again before continuing.',
  TRIAL_IDENTITY_CHANGED:'The signed-in identity changed. Verify your email again to continue.',
  WORKSPACE_FORBIDDEN:'The signed-in identity changed. Verify your email again to continue.',
  INVALID_RESPONSE:'We couldn’t read your trial status. Check it again before taking another action.',
  NETWORK_UNCERTAIN:'The connection was interrupted. Your last action may have completed. Check the trial status before trying again.'};

export function renderTrial(root,announcement,state,actions) {
  const previousPhase=root.dataset.trialPhase;root.dataset.trialPhase=state.phase;
  const {phase,identity,trial}=state,busy=['checking','reserving','closing'].includes(phase);
  const heading=el('h2',{id:'signup-heading',tabindex:'-1'},titles[phase]);
  const button=(text,callback,attrs={})=>el('button',{type:'button',class:'button primary',onclick:callback,disabled:busy,...attrs},text);
  const sampleLink=()=>el('a',{class:'button',href:sample},'Explore the read-only example →');
  const signIn=()=>el('a',{class:'button primary',href:'/trial/signup'},'Continue with email →');
  const nodes=[];
  const badges={eligible:'Email verified',reserving:'Saving reservation',admitted:'Reserved · workspace preview',
    'confirm-close':'Reserved · workspace preview',closing:'Closing',closed:'Closed',expired:'Expired',capacity:'Capacity reached',checking:'Checking status'};
  if(badges[phase])nodes.push(el('p',{class:'badge'+(['capacity','closed','expired'].includes(phase)?' warning':'')},badges[phase]));
  nodes.push(heading);
  if(identity)nodes.push(el('p',{class:'identity'},'Signed in as',el('strong',{},identity.email)));
  if(phase==='checking')nodes.push(el('p',{class:'muted'},'Checking your verified identity and saved reservation…'));
  if(phase==='eligible'||phase==='reserving')nodes.push(
    el('p',{},'Reserve a separate private space. The trial clock starts when the reservation is saved.'),
    details([['Duration',duration(identity.policy.durationMs)+' from reservation'],['Available','Workspace preview'],['Model credits','Not included']]),
    button(phase==='reserving'?'Reserving…':'Reserve trial',actions.reserve),
    el('p',{class:'small muted'},'A reservation does not start an agent, create a repository or run checks.'));
  if(['admitted','confirm-close','closing'].includes(phase))nodes.push(
    el('p',{},'Your separate workspace preview is available. Repository setup and coding runs still need to be prepared.'),
    el('p',{class:'expiry'},'Expires ',expiry(trial.expiresAt)),
    phase==='closing'?button('Closing…',()=>{}):el('a',{class:'button primary',href:'/workspace/?view=projects'},'View private workspace preview →'),
    el('p',{class:'small muted'},'The preview is read-only. No code or tasks have been created by signing up.'),
    el('div',{class:'secondary-actions'},el('button',{type:'button',class:'text-button',disabled:busy,onclick:actions.refresh},'Check status'),
      el('button',{type:'button',class:'text-button',id:'close-trial',disabled:busy,onclick:actions.confirmClose},'Close trial')));
  if(phase==='closed'||phase==='expired')nodes.push(
    el('p',{},phase==='closed'?'Trial access is closed. This reservation won’t reopen or restart automatically.':'The trial period has ended. Signing in again won’t restart its clock.'),
    el('p',{class:'notice'},'Retained records have not been deleted. Export and automatic cleanup are not available in this preview.'),sampleLink());
  if(phase==='capacity')nodes.push(el('p',{},'We can’t reserve another trial right now. The public example is still available without an account.'),sampleLink(),
    el('button',{type:'button',class:'text-button',onclick:actions.refresh},'Check availability'));
  if(phase==='signedOut')nodes.push(el('p',{class:'notice'},errors[state.error]??'Your sign-in is needed or has expired. Verify your email to inspect your trial.'),signIn());
  if(phase==='blocked')nodes.push(el('p',{class:'notice'},'Trial signup requires a verified human email login. No reservation has been created.'),sampleLink());
  if(phase==='failed')nodes.push(el('p',{class:'notice',role:'alert'},errors[state.error]??'Trial signup is unavailable. Check your reservation status before trying again.'),button('Check reservation status',actions.refresh),sampleLink());
  if(['eligible','admitted'].includes(phase))nodes.push(el('details',{class:'reservation-help'},el('summary',{},'About this early preview'),
    el('p',{},'Your identity owns one reservation. Repeating signup keeps the original expiry. Closing a trial stops access but does not delete retained records. No model credits, repository setup, exports or automatic cleanup are included.')));
  let dialog;
  if(phase==='confirm-close') {
    dialog=el('dialog',{class:'confirmation','aria-labelledby':'close-heading','aria-describedby':'close-description',oncancel:event=>{event.preventDefault();actions.cancelClose();}},
      el('h2',{id:'close-heading'},'Close this trial?'),el('p',{id:'close-description'},'This stops access for the signed-in identity. The reservation cannot reopen automatically, and retained records will not be deleted.'),
      el('div',{class:'actions'},button('Keep trial',actions.cancelClose,{autofocus:true}),button('Close trial',actions.close,{class:'button danger'})));
    nodes.push(dialog);
  }
  root.setAttribute('aria-busy',String(busy));root.replaceChildren(...nodes);
  announcement.textContent=titles[phase];
  if(dialog)dialog.showModal();
  else if(previousPhase==='confirm-close'&&phase==='admitted')root.querySelector('#close-trial')?.focus({preventScroll:true});
  else if(!busy)heading.focus({preventScroll:true});
}
