import {demoDocument} from '../demo/document.mjs';
import {workbenchDocument} from './document.mjs';
import {DEMO_ASSETS} from './assets.mjs';

const assets = new Set(DEMO_ASSETS);
const publicHeaders = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
};
export function publicResponse(body, status = 200, headers = {}) {
  return new Response(body, {status, headers: {...publicHeaders, ...headers}});
}
async function documentText(response) {
  if (!response.ok || !response.body) throw Error('Entrance document is unavailable.');
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    for (;;) {
      const {value, done} = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 65536) { await reader.cancel(); throw Error('Entrance document exceeds its bound.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
}
export async function assetDocument(assetBinding, origin, path) {
  return documentText(await assetBinding.fetch(new Request(origin + path)));
}
function publicAssetResponse(response, head) {
  const headers = new Headers(response.headers);
  headers.delete('Set-Cookie'); headers.delete('WWW-Authenticate');
  for (const [key, value] of Object.entries(publicHeaders)) headers.set(key, value);
  return new Response(head ? null : response.body, {status: response.status, headers});
}
// Only an asset binding enters this module. It has no workspace/provider authority.
export async function publicEntrance(request, assetBinding) {
  const url = new URL(request.url), path = url.pathname;
  const owns = path === '/' || path === '/index.html' || path === '/reviewer.html'
    || path === '/entrance/styles.css' || path === '/demo' || path.startsWith('/demo/');
  if (!owns) return null;
  if (!['GET', 'HEAD'].includes(request.method)) return publicResponse(null, 405, {Allow:'GET, HEAD'});
  const head = request.method === 'HEAD';
  if (path === '/reviewer.html') return publicResponse(null, 307, {Location:'/workspace/reviewer' + url.search});
  if (path === '/index.html' || (path === '/' && url.searchParams.has('view')))
    return publicResponse(null, 307, {Location:(url.searchParams.has('view') ? '/workspace/' : '/') + url.search});
  if (path === '/demo') return publicResponse(null, 308, {Location:'/demo/' + url.search});
  if (path === '/') {
    const html = await assetDocument(assetBinding, url.origin, '/entrance/index.html');
    return publicResponse(head ? null : html, 200, {'Content-Type':'text/html;charset=utf-8'});
  }
  if (path === '/demo/') {
    const view = url.searchParams.get('view');
    if (view && !['projects','overview','work','review','evidence'].includes(view)) return publicResponse('Unknown example view.',404);
    const html = demoDocument(await assetDocument(assetBinding, url.origin, '/index.html'),{entrance:true});
    return publicResponse(head ? null : workbenchDocument(html, '/demo/assets/', {demo:true}), 200, {'Content-Type':'text/html;charset=utf-8'});
  }
  const source = path === '/entrance/styles.css' ? 'entrance/styles.css' : path.slice('/demo/assets/'.length);
  if (path !== '/entrance/styles.css' && (!path.startsWith('/demo/assets/') || !assets.has(source)))
    return publicResponse('Example file not found.',404);
  return publicAssetResponse(await assetBinding.fetch(new Request(url.origin + '/' + source)), head);
}
