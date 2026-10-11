import type {SubscriptionQualificationControl} from './subscription-fixture.ts';
interface DriverEnv {CONTROL:Service<SubscriptionQualificationControl>}
export default {async fetch(request:Request,env:DriverEnv){
  const url=new URL(request.url);
  if(!['127.0.0.1','localhost','::1'].includes(url.hostname)||request.method!=='POST')return new Response('Loopback only',{status:403});
  try{
    const input=await request.json();let result;
    switch(url.pathname){
      case '/api':result=await env.CONTROL.api(input);break;
      case '/fault':result=await env.CONTROL.fault();break;
      case '/retire':result=await env.CONTROL.retire();break;
      case '/read':result=await env.CONTROL.read();break;
      case '/direct':result=await env.CONTROL.direct(input);break;
      case '/emit':result=await env.CONTROL.emit(input);break;
      case '/wait':result=await env.CONTROL.wait(input);break;
      default:return new Response('Not found',{status:404});
    }
    return Response.json(result??{ok:true});
  }catch{return Response.json({code:'QUALIFICATION_REFUSED_OR_INTERRUPTED'},{status:409});}
}};
