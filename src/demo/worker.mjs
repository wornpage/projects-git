import {demoDocument} from './document.mjs';

const headers={'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cache-Control':'no-store'};
const views=new Set(['projects','overview','work','review','evidence']);
export default {async fetch(request,env){
  const url=new URL(request.url);
  if(!['GET','HEAD'].includes(request.method))return Response.json({error:{code:'DEMO_READ_ONLY',message:'Read-only example; no action was performed.'}},{status:405,headers:{...headers,Allow:'GET, HEAD'}});
  if(url.pathname.startsWith('/api/')||url.pathname.startsWith('/cdn-cgi/'))return new Response('The example has no workspace API.',{status:404,headers});
  let response;
  if(url.pathname==='/'||url.pathname==='/index.html'){
    const view=url.searchParams.get('view');if(view&&!views.has(view))return new Response('Unknown example view.',{status:404,headers});
    const target=new URL(view?'/index.html':'/demo/welcome.html',url.origin);
    response=await env.ASSETS.fetch(new Request(target));
    if(response.ok)response=new Response(view?demoDocument(await response.text()):await response.text(),{headers:{'Content-Type':'text/html;charset=utf-8'}});
  }else{
    let pathname;try{pathname=decodeURIComponent(url.pathname);}catch{return new Response('Invalid example path.',{status:400,headers});}
    if(!/\.(?:js|css|svg)$/.test(pathname)||/[\\\u0000]/.test(pathname)||pathname.split('/').includes('..'))return new Response('Example file not found.',{status:404,headers});
    response=await env.ASSETS.fetch(new Request(url.origin+url.pathname));
  }
  const resultHeaders=new Headers(response.headers);for(const [key,value] of Object.entries(headers))resultHeaders.set(key,value);
  return new Response(request.method==='HEAD'?null:response.body,{status:response.status,headers:resultHeaders});
}};
