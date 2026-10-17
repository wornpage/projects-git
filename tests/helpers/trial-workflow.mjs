import assert from 'node:assert/strict';
import {Miniflare} from 'miniflare';
import {trialSampleFixture} from './trial-sample.mjs';
import {approvedTrialResources} from './trial-policy.mjs';
import {handler} from './trial-http.mjs';

// Real local workerd executes the production check bridge. Artifacts management
// remains simulated, while its repository objects and Git transport are real.
export async function trialWorkflowFixture(t){
  const f=await trialSampleFixture(t,{policyOverrides:{durationMs:3600000,resources:{...approvedTrialResources,providerCalls:600}}});
  f.env.TRIAL_LOADER={load(options){
    assert.deepEqual(options.env,{});assert.equal(options.globalOutbound,null);assert.deepEqual(options.limits,{cpuMs:1000,subRequests:0});
    return {getEntrypoint(){return {async fetch(url,init){
      const mf=new Miniflare({host:'127.0.0.1',port:0,inspectorPort:0,telemetry:{enabled:false},logRequests:false,workers:[{
        config:{name:'trial-check-fixture',compatibilityDate:'2026-10-08',manifest:{mainModule:options.mainModule,
          modules:Object.fromEntries(Object.entries(options.modules).map(([name,body])=>[name,{type:'esm',contents:body.js}]))},env:{}},
        dev:{unsafeRegisterWorker:false,outboundService:{type:'fetcher',handler:()=>new Response('Network disabled',{status:403})}}
      }]});
      try{const response=await mf.dispatchFetch(url,init);return new Response(await response.arrayBuffer(),{status:response.status,headers:response.headers});}
      finally{await mf.dispose();}
    }}}};
  }};
  const agent=(credential,path,body,headers={})=>handler(new Request('https://trial.example.test/agent'+path,{method:body===undefined?'GET':'POST',
    headers:{Authorization:'Bearer '+credential.token,'X-Workspace-Id':credential.principal.workspaceId,'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID(),...headers},
    body:body===undefined?undefined:JSON.stringify(body)}),f.env);
  return {...f,agent};
}
export const correctCheckout=`export function checkoutTotal(items) {
  if(!Array.isArray(items))throw new TypeError('Cart');let total=0;
  for(const item of items){if(!item||typeof item!=='object'||Array.isArray(item))throw new TypeError('Item');
    if(!Number.isSafeInteger(item.unitCents)||item.unitCents<0||!Number.isSafeInteger(item.quantity)||item.quantity<=0)throw new RangeError('Input');
    const line=item.unitCents*item.quantity;if(!Number.isSafeInteger(line)||!Number.isSafeInteger(total+line))throw new RangeError('Total');total+=line;}
  return total;
}`;
