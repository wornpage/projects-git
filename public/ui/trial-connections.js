import {el} from './dom.js';
import {downloadJson} from './json-download.js';

export function trialConnectionDownload(result,workspaceId,role,origin) {
  const principal=result?.principal;
  if(!principal||principal.provider!=='trial-credential'||principal.workspaceId!==workspaceId||principal.kind!==role
    ||!Number.isSafeInteger(principal.expiresAt)||principal.expiresAt*1000<=Date.now()
    ||typeof result.token!=='string'||!/^pgt1_[a-f0-9]{64}$/.test(result.token))throw Error('A current connection was not returned.');
  return {format:'projects-git-trial-connection/v1',origin,role,token:result.token,workspaceId};
}

// Ephemeral connection controls. Download only on an explicit click; never store
// the credential in localStorage, sessionStorage, a URL, or the task record.
export function createTrialConnections({workspaceId,captureSession,fetcher=fetch,origin=location.origin}) {
  let disposed=false,busy=false,pending=null,secret=null,abort=null,generation=0;
  const current=captureSession();
  const role=el('select',{'aria-label':'Connection role'},el('option',{value:'agent'},'Coding agent'),el('option',{value:'reviewer'},'Independent reviewer'));
  const notice=el('p',{role:'status','aria-live':'polite',class:'small'}),download=el('button',{type:'button',class:'button',hidden:true,onclick:()=>{
    if(!secret||!current()||disposed)return;
    downloadJson(secret,'projects-git-trial-'+secret.role+'.json');
  }},'Download private connection');
  const clear=()=>{secret=null;download.hidden=true;};
  async function call(path,body,key,identityKey) {
    const response=await fetcher(path,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',redirect:'manual',signal:abort.signal,
      headers:{Accept:'application/json',...(path==='/api/trial/session'?{}:{'X-Workspace-Id':workspaceId}),...(body===undefined?{}:{'Content-Type':'application/json','Idempotency-Key':key,'X-Trial-Identity':identityKey})},body:body===undefined?undefined:JSON.stringify(body)});
    if(response.status===401||response.status===403||response.type==='opaqueredirect'||response.status>=300&&response.status<400)throw Error('Sign in again and reopen this trial before managing connections.');
    if(!response.ok)throw Error('The connection request was not confirmed. Inspect trial status before retrying.');
    return response.json();
  }
  async function act(revoke=false) {
    if(busy||disposed||!current())return;
    clear();busy=true;role.disabled=true;create.disabled=true;remove.disabled=true;abort=new AbortController();
    const selected=role.value,action=revoke?'revoke':'create',attempt=generation;
    const live=()=>!disposed&&attempt===generation&&!document.hidden&&current();
    pending??={role:selected,action,key:crypto.randomUUID()};
    try {
      if(pending.role!==selected||pending.action!==action)throw Error('Retry the pending connection operation before switching actions.');
      const session=await call('/api/trial/session');
      if(!live())return;
      if(typeof session.identityKey!=='string'||!/^[a-f0-9]{64}$/.test(session.identityKey))throw Error('The signed-in identity could not be confirmed.');
      const result=await call('/api/trial/credentials'+(revoke?'/revoke':''),{role:selected},pending.key,session.identityKey);
      if(!live()||root.isConnected===false)return;
      pending=null;
      if(revoke){if(result.revoked!==true)throw Error('Revocation was not confirmed.');notice.textContent='Connection revoked.';}
      else if(result.replayed&&result.token===null)notice.textContent='That creation was recorded, but its secret is no longer available. Create a replacement to revoke it and receive a new connection.';
      else {secret=trialConnectionDownload(result,workspaceId,selected,origin);download.hidden=false;notice.textContent='Save this connection now. It expires '+new Date(result.principal.expiresAt*1000).toLocaleTimeString()+'.';}
    }catch(error){if(live())notice.textContent=error.name==='AbortError'?'Connection request interrupted. Check its outcome before retrying.':error.message;}
    finally {busy=false;create.disabled=Boolean(pending&&pending.action!=='create');remove.disabled=Boolean(pending&&pending.action!=='revoke');role.disabled=Boolean(pending);create.textContent=pending?.action==='create'?'Retry same creation':'Create / replace connection';}
  }
  const create=el('button',{type:'button',class:'button button-primary',onclick:()=>act()},'Create / replace connection');
  const remove=el('button',{type:'button',class:'button',onclick:()=>act(true)},'Revoke connection');
  const root=el('section',{class:'connection-dialog-body trial-connections'},el('p',{},'Use separate connections for your coding agent and independent reviewer. Each connection is limited to this trial.'),
    role,el('p',{class:'small'},'Replacing a connection revokes its previous credential. Keep the downloaded file outside repositories and shared chats.'),
    el('div',{class:'trial-connection-actions'},create,remove,download),notice,
    el('details',{},el('summary',{},'Connect your coding tool'),el('p',{},'Install the Projects Git source, then configure your tool to launch this MCP server with the absolute path to the private connection file:'),
      el('pre',{class:'output'},'node scripts/trial-agent-mcp.mjs --connection <absolute-private-connection.json>'),
      el('p',{class:'small'},'The agent supplies the checkout implementation. Publishing, checks, independent review, your decision and merge remain separate.')));
  const suspend=()=>{generation++;clear();abort?.abort();};
  const hidden=()=>{if(document.hidden)suspend();};document.addEventListener('visibilitychange',hidden);
  globalThis.addEventListener?.('pagehide',suspend);
  return {node:root,dispose(){disposed=true;suspend();document.removeEventListener('visibilitychange',hidden);globalThis.removeEventListener?.('pagehide',suspend);}};
}
