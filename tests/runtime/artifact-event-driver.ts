import type {EventQualificationControl} from './artifact-event-fixture.ts';
interface DriverEnv {CONTROL:Service<EventQualificationControl>}
export default {async fetch(request:Request,env:DriverEnv){
  const url=new URL(request.url);
  if(!['127.0.0.1','localhost','::1'].includes(url.hostname))return new Response('Loopback qualifier only',{status:403});
  if(request.method!=='POST')return new Response('Read-only unavailable',{status:404});
  const input=await request.json();
  try {
    switch(url.pathname){
      case '/seed':return Response.json(await env.CONTROL.seed(input));
      case '/head':await env.CONTROL.head(input);return Response.json({ok:true});
      case '/fault':await env.CONTROL.fault();return Response.json({ok:true});
      case '/read':return Response.json(await env.CONTROL.read());
      case '/wait':return Response.json(await env.CONTROL.wait(input));
      case '/emit':return Response.json(await env.CONTROL.emit(input));
      case '/direct':return Response.json(await env.CONTROL.direct(input));
      default:return new Response('Unavailable',{status:404});
    }
  }catch{return Response.json({code:'QUALIFICATION_CALL_REFUSED'},{status:409});}
}};
