import {readPrivateInput} from './hosted-agent-client.mjs';
import {trialCandidateSource} from '../cloudflare/trial-workflow.ts';

const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
export function trialConnection(value) {
  if(!object(value)||Object.keys(value).sort().join(',')!=='format,origin,role,token,workspaceId'
    ||value.format!=='projects-git-trial-connection/v1'||!['agent','reviewer'].includes(value.role)
    ||typeof value.token!=='string'||!/^pgt1_[a-f0-9]{64}$/.test(value.token)
    ||typeof value.workspaceId!=='string'||!/^trial-[a-f0-9]{64}$/.test(value.workspaceId))throw Error('Invalid trial connection. Use the private connection file supplied by the trial owner.');
  let url;try{url=new URL(value.origin);}catch{throw Error('A trial connection needs an HTTPS origin.');}
  if(url.protocol!=='https:'||url.origin!==value.origin||url.username||url.password)throw Error('A trial connection needs a credential-free HTTPS origin.');
  return {...value};
}
export async function loadTrialConnection(filename) {return trialConnection(await readPrivateInput(filename,16384,'--connection'));}
function rejectSecrets(value){
  if(Array.isArray(value)){value.forEach(rejectSecrets);return;}
  if(!object(value))return;
  for(const [key,item]of Object.entries(value)){
    if(/^(token|clientSecret|client_secret|access_token|credentials)$/i.test(key)&&item!==null&&item!==undefined)throw Error('Trial API returned an unexpected credential. Output was withheld.');
    rejectSecrets(item);
  }
}
export class TrialAgentClient {
  constructor(connection,{fetchImpl=fetch}={}){this.connection=trialConnection(connection);this.fetchImpl=fetchImpl;}
  sanitize(value){return String(value).split(this.connection.token).join('[redacted]').replace(/pgt1_[a-f0-9]{64}/g,'[redacted]');}
  serialize(value){rejectSecrets(value);return this.sanitize(JSON.stringify(value,null,2));}
  async execute(action,input={}) {
    const role=this.connection.role,builder=['workspace','claim','start','source','publish','submit','fail'],reviewer=['inbox','context','assess'];
    if(!(role==='agent'?builder:reviewer).includes(action))throw Error('This credential does not permit that trial action.');
    const id=(value,label)=>{if(!uuid(value))throw Error(label+' must be a UUID.');return value;};
    let endpoint,body;
    if(action==='workspace')endpoint='/api/workspace';
    else if(action==='inbox')endpoint='/api/review-inbox';
    else if(action==='claim'){endpoint='/api/projects/'+id(input.project,'Project')+'/claim';if(typeof input.label!=='string'||!input.label.trim()||input.label.length>160)throw Error('Supply a short agent label.');body={label:input.label};}
    else {
      const run=id(input.run,'Run');
      endpoint='/api/runs/'+run+'/'+({context:'review-context',assess:'code-review',publish:'source'}[action]??action);
      if(action==='publish')body=trialCandidateSource({source:input.source,headCommit:input.headCommit});
      else if(action==='start')body={};
      else if(action==='submit'){
        if(!/^[a-f0-9]{40}$/.test(input.headCommit)||typeof input.summary!=='string'||!input.summary.trim()||input.summary.length>2000)throw Error('Supply the exact published commit and a summary within 2,000 characters.');
        body={headCommit:input.headCommit,summary:input.summary};
      }else if(action==='fail'){
        if(typeof input.message!=='string'||!input.message.trim()||input.message.length>2000)throw Error('Supply a failure reason within 2,000 characters.');body={message:input.message};
      }else if(action==='assess'){
        if(!object(input.assessment))throw Error('Supply the structured independent assessment.');body=input.assessment;
      }
    }
    if(body!==undefined&&!uuid(input.requestId))throw Error('Supply an explicit operation UUID. Reuse it only for the same operation and inputs.');
    return this.request(endpoint,body,input.requestId);
  }
  async request(endpoint,body,key) {
    let response;
    try{response=await this.fetchImpl(this.connection.origin+'/agent'+endpoint,{method:body===undefined?'GET':'POST',redirect:'manual',signal:AbortSignal.timeout(120000),
      headers:{Authorization:'Bearer '+this.connection.token,'X-Workspace-Id':this.connection.workspaceId,'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{})},body:body===undefined?undefined:JSON.stringify(body)});}
    catch{throw Error('Trial response is unknown. Read status before explicitly retrying the same operation; nothing was retried automatically.');}
    if(response.redirected||response.status>=300&&response.status<400){await response.body?.cancel();throw Error('Trial redirects are refused. Check the configured origin and credential.');}
    if(!response.headers.get('Content-Type')?.startsWith('application/json')||!response.body)throw Error('Trial API did not return JSON. Check the trial connection.');
    const chunks=[],reader=response.body.getReader();let bytes=0;
    try{for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.length;if(bytes>4*1024*1024)throw Error('Trial response exceeds 4 MiB.');chunks.push(part.value);}}
    finally{await reader.cancel();reader.releaseLock();}
    let value;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{throw Error('Trial API returned invalid JSON.');}
    if(!response.ok){const code=typeof value?.code==='string'&&/^[A-Z_]{1,80}$/.test(value.code)?' '+value.code:'';throw Error('Trial request refused: HTTP '+response.status+code+'. Inspect status; no automatic retry occurred.');}
    rejectSecrets(value);
    if(value?.workspaceId&&value.workspaceId!==this.connection.workspaceId||value?.workspace?.id&&value.workspace.id!==this.connection.workspaceId
      ||endpoint==='/api/workspace'&&value?.id!==this.connection.workspaceId)throw Error('Trial response belongs to a different workspace.');
    return value;
  }
}
