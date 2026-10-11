const DAY_MS=24*60*60*1000;
const HOUR_MS=60*60*1000;

function requireThat(condition,message){if(!condition)throw new Error(message);}
function durationMs(value){
  if(typeof value!=='string'||!/^\d+(?:h|m|s)$/.test(value))return NaN;
  const number=Number(value.slice(0,-1));
  return number*({h:HOUR_MS,m:60*1000,s:1000}[value.at(-1)]);
}
function timestamp(value){return typeof value==='string'?Date.parse(value):NaN;}
function emptyRules(policy){return (!policy.require||policy.require.length===0)&&(!policy.exclude||policy.exclude.length===0);}

// Inspect provider-returned records. Local credential JSON cannot establish an
// Access policy's reach or the lifetime of an issued service credential.
export function verifyAccessBoundary({setup,agents,reviewers,application,policies,tokens,now=Date.now()}){
  requireThat(Number.isFinite(now),'Supply the observation time.');
  requireThat(typeof setup?.accessApplicationId==='string'&&setup.accessApplicationId.length>0,
    'Pin the qualification Access application ID.');
  requireThat(typeof setup.ownerSubject==='string'&&setup.ownerSubject.length>0
    &&Number.isFinite(timestamp(setup.ownerVerifiedAt))
    &&typeof setup.issuer==='string'&&setup.issuer.length>0,
  'Pin the verified owner and Access issuer before preflight.');
  requireThat(application?.id===setup.accessApplicationId&&application.type==='self_hosted'
    &&application.domain===setup.hostname&&application.aud===setup.audience,
  'The Access application does not match the pinned self-hosted hostname and audience.');
  if(application.destinations!==undefined){
    const destinations=application.destinations;
    requireThat(Array.isArray(destinations)&&destinations.length===1
      &&(destinations[0]?.type===undefined||destinations[0].type==='public')
      &&[setup.hostname,`https://${setup.hostname}`,`${setup.hostname}/*`,`https://${setup.hostname}/*`].includes(destinations[0].uri)
      &&(!destinations[0].overrides||destinations[0].overrides.length===0),
    'The Access application has another destination or a public path override.');
  }else if(application.self_hosted_domains!==undefined)
    requireThat(Array.isArray(application.self_hosted_domains)
      &&application.self_hosted_domains.length===1
      &&[application.self_hosted_domains[0],application.self_hosted_domains[0]?.domain].includes(setup.hostname),
    'The Access application protects a different or additional hostname.');
  requireThat(durationMs(application.session_duration)===8*HOUR_MS,
    'The Access application must retain the approved eight-hour session.');
  requireThat(application.enabled!==false,'The qualification Access application is disabled.');
  requireThat(Array.isArray(agents)&&agents.length===8&&Array.isArray(reviewers)&&reviewers.length===2,
    'The qualification needs eight builders and two reviewers.');
  const configured=[...agents,...reviewers];
  requireThat(configured.every(item=>typeof item?.id==='string'&&item.id.length>0
    &&typeof item.client_id==='string'&&item.client_id.length>0),
  'Every service credential needs its provider ID and client ID.');
  const ids=new Set(configured.map(item=>item.id)),clientIds=new Set(configured.map(item=>item.client_id));
  requireThat(ids.size===10&&clientIds.size===10,'Qualification service credentials overlap.');
  requireThat(Array.isArray(tokens)&&new Set(tokens.map(item=>item.id)).size===tokens.length,
    'Cloudflare returned duplicate service token IDs.');
  const byId=new Map(tokens.map(item=>[item.id,item]));
  const observed=configured.map(item=>{
    const remote=byId.get(item.id);
    requireThat(remote?.client_id===item.client_id&&remote.enabled===true&&remote.duration==='24h',
      'A configured service credential is absent, disabled, mismatched, or longer-lived.');
    const expires=timestamp(remote.expires_at);
    requireThat(Number.isFinite(expires)&&expires>now&&expires-now<=DAY_MS,
      'A configured service credential is expired or exceeds the 24-hour remaining limit.');
    return {id:remote.id,clientId:remote.client_id,duration:remote.duration,expiresAt:remote.expires_at};
  });
  requireThat(Array.isArray(policies)&&policies.length===2,
    'The qualification application must have exactly the owner and service policies.');
  const owner=policies.find(policy=>policy.decision==='allow');
  const service=policies.find(policy=>policy.decision==='non_identity');
  requireThat(owner&&service&&emptyRules(owner)&&emptyRules(service),
    'Access policies must use only the approved owner and service selectors.');
  requireThat(Array.isArray(owner.include)&&owner.include.length===1
    &&Object.keys(owner.include[0]??{}).length===1
    &&owner.include[0]?.email?.email?.toLowerCase()===setup.ownerEmail.toLowerCase(),
  'The owner policy must name only the approved email.');
  requireThat(!owner.session_duration||durationMs(owner.session_duration)<=8*HOUR_MS,
    'The owner policy cannot extend the eight-hour session.');
  requireThat(Array.isArray(service.include)&&service.include.length===10
    &&service.include.every(rule=>Object.keys(rule??{}).length===1&&ids.has(rule.service_token?.token_id))
    &&new Set(service.include.map(rule=>rule.service_token.token_id)).size===10,
  'The Service Auth policy must name exactly the ten qualification service tokens.');
  return {ownerSubject:setup.ownerSubject,ownerEmail:setup.ownerEmail.toLowerCase(),issuer:setup.issuer,
    application:{id:application.id,domain:application.domain,audience:application.aud,
    sessionDuration:application.session_duration},
    policies:{ownerId:owner.id??null,serviceId:service.id??null,serviceTokenCount:10},
    serviceTokens:observed,checkedAt:new Date(now).toISOString()};
}

// This is an operator QA guard, not a substitute for live edge and Worker
// denial tests. It prevents a hosted scenario from silently using an older
// inventory or a different source/credential cohort.
export function verifyAccessReceipt({receipt,setup,agents,reviewers,source,now=Date.now()}){
  const checked=timestamp(receipt?.observation?.checkedAt);
  requireThat(source?.clean===true&&receipt?.format==='projects-review-access-preflight/v1'&&receipt.status==='passed'
    &&receipt.account===setup.account&&receipt.workspace===setup.workspace
    &&receipt.source?.commit===source.commit&&receipt.source?.tree===source.tree
    &&receipt.observation.ownerSubject===setup.ownerSubject
    &&receipt.observation.ownerEmail===setup.ownerEmail.toLowerCase()
    &&receipt.observation.issuer===setup.issuer
    &&receipt.observation.application?.id===setup.accessApplicationId
    &&receipt.observation.application?.audience===setup.audience
    &&receipt.observation.application?.domain===setup.hostname
    &&Number.isFinite(checked)&&checked<=now&&now-checked<=30*60*1000,
  'Refresh the live Access preflight on this exact source before hosted qualification.');
  const expected=[...agents,...reviewers];
  const observed=receipt.observation.serviceTokens;
  const expectedIds=new Set(expected.map(item=>item.id));
  const expectedClientIds=new Set(expected.map(item=>item.client_id));
  requireThat(agents.length===8&&reviewers.length===2&&expectedIds.size===10&&expectedClientIds.size===10
    &&Array.isArray(observed)&&observed.length===10
    &&new Set(observed.map(item=>item.id)).size===10
    &&expected.every(item=>observed.some(token=>token.id===item.id&&token.clientId===item.client_id
      &&token.duration==='24h'&&timestamp(token.expiresAt)>now)),
  'The Access preflight does not cover the current unexpired service credential cohort.');
}

export async function fetchAccessInventory({account,applicationId,apiToken,fetchImpl=fetch}){
  requireThat(/^[a-f0-9]{32}$/.test(account)&&/^[a-f0-9-]{36}$/.test(applicationId)
    &&typeof apiToken==='string'&&apiToken.length>0,'Pin an account, application and private API token.');
  const base=`https://api.cloudflare.com/client/v4/accounts/${account}/access`;
  async function get(path){
    const response=await fetchImpl(base+path,{headers:{Authorization:'Bearer '+apiToken},signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error(`Cloudflare Access read failed with HTTP ${response.status}.`);
    const body=await response.json();
    if(body?.success!==true)throw new Error('Cloudflare Access did not confirm the inventory read.');
    return body;
  }
  async function list(path,perPage){
    const items=[];
    for(let page=1;page<=20;page++){
      const query=new URLSearchParams({page:String(page),per_page:String(perPage)});
      const body=await get(path+'?'+query);
      if(!Array.isArray(body.result)||!Number.isInteger(body.result_info?.total_pages)
        ||body.result_info.total_pages<1||body.result_info.total_pages>20)
        throw new Error('Cloudflare Access inventory pagination was not bounded.');
      items.push(...body.result);
      if(page===body.result_info.total_pages)return items;
    }
    throw new Error('Cloudflare Access inventory exceeded the bounded page count.');
  }
  const [app,policies,tokens]=await Promise.all([
    get(`/apps/${applicationId}`),list(`/apps/${applicationId}/policies`,100),list('/service_tokens',1000)]);
  return {application:app.result,policies,tokens};
}
