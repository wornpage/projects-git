// Trial admission, sample state and HTTP. The view never reads credentials or selects a
// workspace. Identity preconditions prevent mutations from a stale signed-in tab.
export class TrialClientError extends Error {constructor(code){super(code);this.code=code;}}
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
function sessionValue(value) {
  if(!exact(value,['identityKey','email','policy','turnstile'])||!hash(value.identityKey)||typeof value.email!=='string'||value.email.length>320||!/^\S+@\S+$/.test(value.email)
    ||!exact(value.turnstile,['siteKey','action'])||!/^[-A-Za-z0-9_]{1,100}$/.test(value.turnstile.siteKey)||value.turnstile.action!=='turnstile-spin-v2'
    ||!exact(value.policy,['revision','durationMs'])||typeof value.policy.revision!=='string'||!/^[a-z0-9-]{1,64}$/.test(value.policy.revision)
    ||!Number.isSafeInteger(value.policy.durationMs)||value.policy.durationMs<60000||value.policy.durationMs>604800000)throw new TrialClientError('INVALID_RESPONSE');
  return value;
}
function statusValue(value,identity) {
  const keys=['workspaceId','status','createdAt','expiresAt','remainingMs','policyRevision','workflowReady','capabilities','cleanup','identityKey',...(value?.workflowReady===true?['exportUntil']:[])];
  const caps=['workspaceReads','repositoryCreation','agents','checks','modelCredits'];
  if(!exact(value,keys))throw new TrialClientError('INVALID_RESPONSE');
  if(value.identityKey!==identity.identityKey)throw new TrialClientError('TRIAL_IDENTITY_CHANGED');
  if(typeof value.workspaceId!=='string'||!/^trial-[a-f0-9]{64}$/.test(value.workspaceId)||!['admitted','expired','closed'].includes(value.status)
    ||!Number.isFinite(Date.parse(value.createdAt))||!Number.isFinite(Date.parse(value.expiresAt))||Date.parse(value.expiresAt)<=Date.parse(value.createdAt)
    ||!Number.isSafeInteger(value.remainingMs)||value.remainingMs<0||value.remainingMs>identity.policy.durationMs
    ||value.policyRevision!==identity.policy.revision||typeof value.workflowReady!=='boolean'||!['pending','blocked','complete','not-due'].includes(value.cleanup)
    ||!exact(value.capabilities,caps)||caps.some(key=>typeof value.capabilities[key]!=='boolean')
    ||value.capabilities.repositoryCreation!==false||value.capabilities.modelCredits!==false
    ||['agents','checks'].some(key=>value.capabilities[key]!==Boolean(value.workflowReady&&value.status==='admitted'))
    ||value.capabilities.workspaceReads!==(value.status==='admitted')
    ||value.workflowReady&&(!Number.isFinite(Date.parse(value.exportUntil))||Date.parse(value.exportUntil)<=Date.parse(value.createdAt)
      ||Date.parse(value.exportUntil)>Date.parse(value.expiresAt)+7*86400000))throw new TrialClientError('INVALID_RESPONSE');
  return value;
}
function sampleValue(value,trial,mutation=false) {
  const keys=['workspaceId','template','phase','retryable','repository','errorCode','workflowReady','allowance',...(mutation?['replayed']:[])];
  if(!exact(value,keys))throw new TrialClientError('INVALID_RESPONSE');
  if(value.workspaceId!==trial.workspaceId)throw new TrialClientError('TRIAL_IDENTITY_CHANGED');
  const allowance=value.allowance,reasons=['TRIAL_SPENDING_UNAPPROVED','TRIAL_APPROVAL_EXPIRED','TRIAL_SPENDING_PAUSED','TRIAL_RESOURCE_LIMIT'];
  if(!exact(allowance,['spending','setupAvailable','reason','setupAttempts','providerCalls','billingCapGuaranteed'])
    ||!['approved',...reasons.slice(0,3)].includes(allowance.spending)||typeof allowance.setupAvailable!=='boolean'
    ||allowance.reason!==null&&!reasons.includes(allowance.reason)||allowance.setupAvailable!==(allowance.reason===null)
    ||allowance.spending!=='approved'&&allowance.reason!==allowance.spending||allowance.billingCapGuaranteed!==false)
    throw new TrialClientError('INVALID_RESPONSE');
  for(const [pair,max] of [[allowance.setupAttempts,10],[allowance.providerCalls,600]])if(!exact(pair,['used','limit'])
    ||!Number.isSafeInteger(pair.used)||pair.used<0||!Number.isSafeInteger(pair.limit)||pair.limit<0||pair.limit>max||pair.used>pair.limit
    ||allowance.setupAvailable&&pair.used>=pair.limit)throw new TrialClientError('INVALID_RESPONSE');
  const repo=value.repository,uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
  if(value.template!=='checkout-v1'||!['not-started','preparing','failed','ready'].includes(value.phase)||typeof value.retryable!=='boolean'
    ||typeof value.workflowReady!=='boolean'||value.workflowReady&&value.phase!=='ready'||value.phase==='ready'&&value.workflowReady!==trial.workflowReady||mutation&&(typeof value.replayed!=='boolean'||value.phase!=='ready')
    ||value.errorCode!==null&&(typeof value.errorCode!=='string'||!/^[A-Z_]{1,64}$/.test(value.errorCode)))throw new TrialClientError('INVALID_RESPONSE');
  if(value.phase==='not-started') {
    if(repo!==null||value.errorCode!==null||value.retryable!==true)throw new TrialClientError('INVALID_RESPONSE');
  }else{
    if(!exact(repo,['name','repositoryId','projectId','baseCommit'])||repo.name!=='sample-'+trial.workspaceId.slice(6)||!uuid(repo.projectId)
      ||repo.repositoryId!==null&&(typeof repo.repositoryId!=='string'||!repo.repositoryId||repo.repositoryId.length>200)
      ||repo.baseCommit!==null&&(typeof repo.baseCommit!=='string'||!/^[a-f0-9]{40}$/.test(repo.baseCommit)))throw new TrialClientError('INVALID_RESPONSE');
    if(value.phase==='ready'&&(!repo.repositoryId||!repo.baseCommit||value.retryable||value.errorCode!==null)
      ||value.phase==='preparing'&&(value.errorCode!==null||!value.retryable)
      ||value.phase==='failed'&&value.errorCode===null)throw new TrialClientError('INVALID_RESPONSE');
  }
  return value;
}
async function readReply(response) {
  if(response.status===401||response.type==='opaqueredirect'||response.status>=300&&response.status<400
    ||response.status===403&&!response.headers.get('Content-Type')?.toLowerCase().startsWith('application/json'))throw new TrialClientError('SESSION_REQUIRED');
  if(!response.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')||!response.body)throw new TrialClientError('INVALID_RESPONSE');
  const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let length=0,text='';
  try {for(;;){const part=await reader.read();if(part.done)break;length+=part.value.byteLength;if(length>32768){await reader.cancel();throw new TrialClientError('INVALID_RESPONSE');}text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();}
  finally {reader.releaseLock();}
  let value;try{value=JSON.parse(text);}catch{throw new TrialClientError('INVALID_RESPONSE');}
  if(!response.ok){
    const code=typeof value.code==='string'&&/^[A-Z_]{1,64}$/.test(value.code)?value.code:'UNAVAILABLE';
    const expected={TRIAL_NOT_ADMITTED:404,TRIAL_CAPACITY_FULL:429,TRIAL_IDENTITY_CHANGED:409,HUMAN_IDENTITY_REQUIRED:403,
      TRIAL_SAMPLE_UNAVAILABLE:503,TRIAL_SAMPLE_FORBIDDEN:403,TRIAL_CLOSED:403,TRIAL_EXPIRED:403};
    if(expected[code]&&response.status!==expected[code])throw new TrialClientError('INVALID_RESPONSE');
    throw new TrialClientError(code);
  }
  return value;
}

export function createTrialClient({fetcher=fetch,notify=()=>{},nonce=()=>crypto.randomUUID(),setTimer=setTimeout,clearTimer=clearTimeout,now=()=>performance.now()}={}) {
  let state={phase:'checking',identity:null,trial:null,error:null,sample:null},generation=0,abort=null,lastIdentity=null;
  let keys={},expiryTimer=null,expiryDeadline=0;
  const cancelExpiry=()=>{if(expiryTimer!==null){clearTimer(expiryTimer);expiryTimer=null;}};
  const publish=value=>{
    cancelExpiry();state={sample:null,...value};
    // One server read at the observed expiry, not a polling loop or a local
    // assumption that the trial has expired. It never repeats a mutation.
    if(['admitted','confirm-close'].includes(value.phase))expiryTimer=setTimer(()=>{void refresh();},Math.max(0,expiryDeadline-now())+100);
    notify(structuredClone(state));
  };
  const begin=()=>{generation++;abort?.abort();abort=new AbortController();return {generation,signal:abort.signal};};
  const current=operation=>operation.generation===generation&&!operation.signal.aborted;
  const request=async(path,operation,identity,action,body={})=>readReply(await fetcher(path,{method:action?'POST':'GET',credentials:'same-origin',cache:'no-store',redirect:'manual',signal:operation.signal,
    headers:action?{'Content-Type':'application/json','Idempotency-Key':keys[action]??=(nonce()),'X-Trial-Identity':identity.identityKey}:{},body:action?JSON.stringify(body):undefined}));
  const failed=(error,operation)=>{
    if(!current(operation))return;
    const code=error instanceof TrialClientError?error.code:'NETWORK_UNCERTAIN';
    if(['SESSION_REQUIRED','UNAUTHORIZED','FORBIDDEN','TRIAL_IDENTITY_CHANGED','TRIAL_IDENTITY_FORBIDDEN','TRIAL_SAMPLE_FORBIDDEN','WORKSPACE_FORBIDDEN'].includes(code)) {
      publish({phase:'signedOut',identity:null,trial:null,error:code});return;
    }
    if(code==='HUMAN_IDENTITY_REQUIRED'){publish({phase:'blocked',identity:null,trial:null,error:code});return;}
    if(['TRIAL_CLOSED','TRIAL_EXPIRED'].includes(code)){publish({phase:code==='TRIAL_CLOSED'?'closed':'expired',identity:null,trial:null,error:null});return;}
    publish({phase:code==='TRIAL_CAPACITY_FULL'?'capacity':'failed',identity:null,trial:null,error:code});
  };
  const sampleFailed=(error,operation,identity,trial)=>{
    if(!current(operation))return;
    const code=error instanceof TrialClientError?error.code:'NETWORK_UNCERTAIN';
    if(['SESSION_REQUIRED','UNAUTHORIZED','FORBIDDEN','HUMAN_IDENTITY_REQUIRED','TRIAL_IDENTITY_CHANGED','TRIAL_IDENTITY_FORBIDDEN','TRIAL_SAMPLE_FORBIDDEN',
      'WORKSPACE_FORBIDDEN','TRIAL_NOT_ADMITTED','TRIAL_CLOSED','TRIAL_EXPIRED','TRIAL_POLICY_CHANGED','INVALID_RESPONSE'].includes(code)){
      failed(error,operation);return;
    }
    publish({phase:'admitted',identity,trial,error:null,sample:{phase:code==='TRIAL_SAMPLE_UNAVAILABLE'?'unavailable':code==='TRIAL_SAMPLE_STATE_CHANGED'?'blocked':
      ['TRIAL_SPENDING_UNAPPROVED','TRIAL_SPENDING_PAUSED','TRIAL_APPROVAL_EXPIRED','TRIAL_RESOURCE_LIMIT'].includes(code)?'limited':'unknown',result:null,error:code}});
  };
  async function readSample(operation,identity,trial) {
    publish({phase:'admitted',identity,trial,error:null,sample:{phase:'checking',result:null,error:null}});
    try {
      const result=sampleValue(await request('/api/trial/sample',operation),trial);
      if(current(operation))publish({phase:'admitted',identity,trial,error:null,sample:{phase:result.phase,result,error:null}});
    }catch(error){sampleFailed(error,operation,identity,trial);}
  }
  async function refresh() {
    const operation=begin();publish({phase:'checking',identity:null,trial:null,error:null});
    let identity;
    try {
      identity=sessionValue(await request('/api/trial/session',operation));if(!current(operation))return;
      if(lastIdentity!==identity.identityKey){keys={};lastIdentity=identity.identityKey;}
      let trial;
      try {trial=statusValue(await request('/api/trial',operation),identity);}
      catch(error){if(error instanceof TrialClientError&&error.code==='TRIAL_NOT_ADMITTED'){if(current(operation))publish({phase:'eligible',identity,trial:null,error:null});return;}throw error;}
      if(current(operation)){
        expiryDeadline=now()+trial.remainingMs;
        if(trial.status==='admitted')await readSample(operation,identity,trial);
        else publish({phase:trial.status,identity,trial,error:null});
      }
    }catch(error){failed(error,operation);}
  }
  async function mutate(action,turnstileToken) {
    if(action==='reserve'&&state.phase!=='eligible'||action==='close'&&state.phase!=='confirm-close')return;
    if(action==='reserve'&&(typeof turnstileToken!=='string'||!turnstileToken||turnstileToken.length>2048))return;
    const {identity,trial}=state;if(!identity)return;
    const operation=begin();publish({phase:action==='reserve'?'reserving':'closing',identity,trial,error:null});
    try {
      const result=statusValue(await request(action==='reserve'?'/api/trial':'/api/trial/close',operation,identity,action,action==='reserve'?{turnstileToken}:{}),identity);
      if(current(operation)){
        expiryDeadline=now()+result.remainingMs;
        if(result.status==='admitted')await readSample(operation,identity,result);
        else publish({phase:result.status,identity,trial:result,error:null});
      }
    }catch(error){failed(error,operation);}
  }
  async function prepareSample() {
    if(state.phase!=='admitted'||!['not-started','preparing','failed'].includes(state.sample?.phase)||!state.sample.result?.retryable||!state.sample.result.allowance.setupAvailable)return;
    if(now()>=expiryDeadline)return refresh();
    const {identity,trial}=state;if(!identity||!trial)return;
    const operation=begin();publish({phase:'admitted',identity,trial,error:null,sample:{phase:'saving',result:null,error:null}});
    try {
      const result=sampleValue(await request('/api/trial/sample',operation,identity,'sample'),trial,true);
      if(current(operation))publish({phase:'admitted',identity,trial,error:null,sample:{phase:result.phase,result,error:null}});
    }catch(error){sampleFailed(error,operation,identity,trial);}
  }
  return {refresh,prepareSample,reserve:token=>mutate('reserve',token),close:()=>mutate('close'),
    confirmClose(){if(state.phase==='admitted'&&!['checking','saving'].includes(state.sample?.phase))publish({...state,phase:'confirm-close'});},
    cancelClose(){if(state.phase==='confirm-close')publish({...state,phase:'admitted'});},
    suspend(){generation++;abort?.abort();publish({phase:'checking',identity:null,trial:null,error:null});},
    getState:()=>structuredClone(state)};
}
