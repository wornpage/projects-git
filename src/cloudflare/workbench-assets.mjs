import {assetDocument} from '../entrance/handler.mjs';
import {workbenchDocument} from '../entrance/document.mjs';

const WORKBENCH_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

// The caller authenticates before this function can access any asset.
export async function privateWorkbench(request, assetBinding) {
  const url = new URL(request.url), path = url.pathname;
  if (!['GET','HEAD'].includes(request.method)) return new Response(null,{status:405,headers:{Allow:'GET, HEAD','Cache-Control':'no-store'}});
  if (path === '/workspace') return new Response(null,{status:308,headers:{Location:'/workspace/' + url.search,'Cache-Control':'no-store'}});
  if (path === '/workspace/' || path === '/workspace/reviewer') {
    const html = await assetDocument(assetBinding, url.origin, path.endsWith('/reviewer') ? '/reviewer.html' : '/index.html');
    return new Response(request.method === 'HEAD' ? null : workbenchDocument(html,'/workspace/assets/'),
      {headers:{'Content-Type':'text/html;charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':WORKBENCH_CSP}});
  }
  if (!path.startsWith('/workspace/assets/')) return new Response('Workspace page not found.',{status:404,headers:{'Cache-Control':'no-store'}});
  const source = path.slice('/workspace/assets/'.length);
  if (!/^[A-Za-z0-9_./-]+\.(?:js|css|svg)$/.test(source) || source.split('/').some(part=>!part || part === '.' || part === '..'))
    return new Response('Workspace asset not found.',{status:404,headers:{'Cache-Control':'no-store'}});
  const response = await assetBinding.fetch(new Request(url.origin + '/' + source));
  const headers = new Headers(response.headers); headers.set('Cache-Control','no-store');
  return new Response(request.method === 'HEAD' ? null : response.body,{status:response.status,headers});
}
