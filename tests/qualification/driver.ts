import {requireSameOrigin} from '../../src/cloudflare/security.ts';
import type {QualificationControl} from './worker.ts';
interface DriverEnv {TARGET:Fetcher;CONTROL:Service<QualificationControl>;SECOND?:Fetcher;SECOND_CONTROL?:Service<QualificationControl>;HARNESS_KEY:string}
// Run locally with remote service bindings. Never deploy this loopback driver.
export default {async fetch(request:Request,env:DriverEnv){
  const url=new URL(request.url);
  if(!['127.0.0.1','localhost'].includes(url.hostname)||!env.HARNESS_KEY||request.headers.get('X-Qualification-Key')!==env.HARNESS_KEY)return new Response('Private local qualification driver',{status:403});
  try{
    requireSameOrigin(request);
    if(request.method!=='POST'||request.headers.get('Content-Type')!=='application/json')return new Response('JSON POST required',{status:405});
    const body=await request.json() as Record<string,any>;
    const target=body.workspace==='second'?env.SECOND:env.TARGET;
    const control=body.workspace==='second'?env.SECOND_CONTROL:env.CONTROL;
    if(!target||!control)throw Error('Workspace binding unavailable');
    if(url.pathname==='/direct'){
      if(typeof body.path!=='string'||!body.path.startsWith('/api/')||body.path.includes('://'))throw Error('Invalid API path');
      return target.fetch(new Request('https://qualification.invalid'+body.path,{method:body.method??'GET',headers:body.headers??{},body:body.body===undefined?undefined:JSON.stringify(body.body)}));
    }
    let result;
    switch(url.pathname){
      case '/snapshot':result=await control.snapshot();break;
      case '/lifecycle-create-seed':result=await control.lifecycleCreateSeed();break;
      case '/lifecycle-repository':result=await control.lifecycleRepository(body.runId,body.scope);break;
      case '/lifecycle-retire':result=await control.lifecycleRetire();break;
      case '/gates':result=await control.gates();break;
      case '/configure':result=await control.configure(body.phase,body.held);break;
      case '/arm-token-list':result=await control.armTokenList();break;
      case '/tokens':result=await control.tokens(body.runId);break;
      case '/seed-credential':result=await control.seedCredential();break;
      case '/expire':result=await control.expire(body.runId,body.attemptId);break;
      case '/restart':result=await control.restart();break;
      case '/wake':result=await control.wake();break;
      case '/repositories':result=await control.repositories();break;
      case '/seed':result=await control.seedState(body.retireTokens===true);break;
      case '/activity':result=await control.activity(body.attemptId,body.index??0);break;
      case '/release':result=await control.release(body.attemptId,body.index??0);break;
      default:return new Response('Not found',{status:404});
    }
    return Response.json(result??null,{headers:{'Cache-Control':'no-store'}});
  }catch{return Response.json({error:'Qualification control operation failed; inspect retained state.'},{status:409});}
}};
