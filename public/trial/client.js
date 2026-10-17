// Admission state and HTTP only. The view never reads credentials or selects a
// workspace. Identity preconditions prevent mutations from a stale signed-in tab.
export class TrialClientError extends Error {constructor(code){super(code);this.code=code;}}
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
function sessionValue(value) {
  if(!exact(value,['identityKey','email','policy'])||!hash(value.identityKey)||typeof value.email!=='string'||value.email.length>320||!/^\S+@\S+$/.test(value.email)
    ||!exact(value.policy,['revision','durationMs'])||typeof value.policy.revision!=='string'||!/^[a-z0-9-]{1,64}$/.test(value.policy.revision)
    ||!Number.isSafeInteger(value.policy.durationMs)||value.policy.durationMs<60000||value.policy.durationMs>604800000)throw new TrialClientError('INVALID_RESPONSE');
  return value;
}
function statusValue(value,identity) {
  const keys=['workspaceId','status','createdAt','expiresAt','remainingMs','policyRevision','workflowReady','capabilities','cleanup','identityKey'];
  const caps=['workspaceReads','repositoryCreation','agents','checks','modelCredits'];
  if(!exact(value,keys))throw new TrialClientError('INVALID_RESPONSE');
  if(value.identityKey!==identity.identityKey)throw new TrialClientError('TRIAL_IDENTITY_CHANGED');
  if(typeof value.workspaceId!=='string'||!/^trial-[a-f0-9]{64}$/.test(value.workspaceId)||!['admitted','expired','closed'].includes(value.status)
    ||!Number.isFinite(Date.parse(value.createdAt))||!Number.isFinite(Date.parse(value.expiresAt))||Date.parse(value.expiresAt)<=Date.parse(value.createdAt)
    ||!Number.isSafeInteger(value.remainingMs)||value.remainingMs<0||value.remainingMs>identity.policy.durationMs
    ||value.policyRevision!==identity.policy.revision||value.workflowReady!==false||!['not-implemented','not-due'].includes(value.cleanup)
    ||!exact(value.capabilities,caps)||caps.some(key=>typeof value.capabilities[key]!=='boolean')
    ||caps.filter(key=>key!=='workspaceReads').some(key=>value.capabilities[key]!==false)
    ||value.capabilities.workspaceReads!==(value.status==='admitted'))throw new TrialClientError('INVALID_RESPONSE');
  return value;
}
async function readReply(response) {
  if(response.status===401||response.type==='opaqueredirect')throw new TrialClientError('SESSION_REQUIRED');
  if(!response.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')||!response.body)throw new TrialClientError('INVALID_RESPONSE');
  const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let length=0,text='';
  try {for(;;){const part=await reader.read();if(part.done)break;length+=part.value.byteLength;if(length>32768){await reader.cancel();throw new TrialClientError('INVALID_RESPONSE');}text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();}
  finally {reader.releaseLock();}
  let value;try{value=JSON.parse(text);}catch{throw new TrialClientError('INVALID_RESPONSE');}
  if(!response.ok){
    const code=typeof value.code==='string'&&/^[A-Z_]{1,64}$/.test(value.code)?value.code:'UNAVAILABLE';
    const expected={TRIAL_NOT_ADMITTED:404,TRIAL_CAPACITY_FULL:429,TRIAL_IDENTITY_CHANGED:409,HUMAN_IDENTITY_REQUIRED:403};
    if(expected[code]&&response.status!==expected[code])throw new TrialClientError('INVALID_RESPONSE');
    throw new TrialClientError(code);
  }
  return value;
}

export function createTrialClient({fetcher=fetch,notify=()=>{},nonce=()=>crypto.randomUUID(),setTimer=setTimeout,clearTimer=clearTimeout,now=()=>performance.now()}={}) {
  let state={phase:'checking',identity:null,trial:null,error:null},generation=0,abort=null,lastIdentity=null;
  let keys={},expiryTimer=null,expiryDeadline=0;
  const cancelExpiry=()=>{if(expiryTimer!==null){clearTimer(expiryTimer);expiryTimer=null;}};
  const publish=value=>{
    cancelExpiry();state=value;
    // One server read at the observed expiry, not a polling loop or a local
    // assumption that the trial has expired. It never repeats a mutation.
    if(['admitted','confirm-close'].includes(value.phase))expiryTimer=setTimer(()=>{void refresh();},Math.max(0,expiryDeadline-now())+100);
    notify(structuredClone(value));
  };
  const begin=()=>{generation++;abort?.abort();abort=new AbortController();return {generation,signal:abort.signal};};
  const current=operation=>operation.generation===generation&&!operation.signal.aborted;
  const request=async(path,operation,identity,action)=>readReply(await fetcher(path,{method:action?'POST':'GET',credentials:'same-origin',cache:'no-store',redirect:'manual',signal:operation.signal,
    headers:action?{'Content-Type':'application/json','Idempotency-Key':keys[action]??=(nonce()),'X-Trial-Identity':identity.identityKey}:{},body:action?'{}':undefined}));
  const failed=(error,operation)=>{
    if(!current(operation))return;
    const code=error instanceof TrialClientError?error.code:'NETWORK_UNCERTAIN';
    if(['SESSION_REQUIRED','UNAUTHORIZED','TRIAL_IDENTITY_CHANGED','TRIAL_IDENTITY_FORBIDDEN','WORKSPACE_FORBIDDEN'].includes(code)) {
      publish({phase:'signedOut',identity:null,trial:null,error:code});return;
    }
    if(code==='HUMAN_IDENTITY_REQUIRED'){publish({phase:'blocked',identity:null,trial:null,error:code});return;}
    publish({phase:code==='TRIAL_CAPACITY_FULL'?'capacity':'failed',identity:null,trial:null,error:code});
  };
  async function refresh() {
    const operation=begin();publish({phase:'checking',identity:null,trial:null,error:null});
    let identity;
    try {
      identity=sessionValue(await request('/api/trial/session',operation));if(!current(operation))return;
      if(lastIdentity!==identity.identityKey){keys={};lastIdentity=identity.identityKey;}
      let trial;
      try {trial=statusValue(await request('/api/trial',operation),identity);}
      catch(error){if(error instanceof TrialClientError&&error.code==='TRIAL_NOT_ADMITTED'){if(current(operation))publish({phase:'eligible',identity,trial:null,error:null});return;}throw error;}
      if(current(operation)){expiryDeadline=now()+trial.remainingMs;publish({phase:trial.status,identity,trial,error:null});}
    }catch(error){failed(error,operation);}
  }
  async function mutate(action) {
    if(action==='reserve'&&state.phase!=='eligible'||action==='close'&&state.phase!=='confirm-close')return;
    const {identity,trial}=state;if(!identity)return;
    const operation=begin();publish({phase:action==='reserve'?'reserving':'closing',identity,trial,error:null});
    try {
      const result=statusValue(await request(action==='reserve'?'/api/trial':'/api/trial/close',operation,identity,action),identity);
      if(current(operation)){expiryDeadline=now()+result.remainingMs;publish({phase:result.status,identity,trial:result,error:null});}
    }catch(error){failed(error,operation);}
  }
  return {refresh,reserve:()=>mutate('reserve'),close:()=>mutate('close'),
    confirmClose(){if(state.phase==='admitted')publish({...state,phase:'confirm-close'});},
    cancelClose(){if(state.phase==='confirm-close')publish({...state,phase:'admitted'});},
    suspend(){generation++;abort?.abort();publish({phase:'checking',identity:null,trial:null,error:null});},
    getState:()=>structuredClone(state)};
}
