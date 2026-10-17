const paths=new Set(['/trial/styles.css','/trial/app.js','/trial/client.js','/trial/view.js','/trial/turnstile.js','/ui/dom.js']);
const security={
  'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
};

// Only static assets enter this handler. It cannot read identities or workspace
// data. The signup document is served only after its caller verifies a login.
export async function trialUiAsset(request,assets,verified=false) {
  const url=new URL(request.url),path=url.pathname;
  if(path==='/trial/signup'&&!verified)return null;
  if(!['/','/trial','/trial/','/trial/signup'].includes(path)&&!paths.has(path))return null;
  if(!['GET','HEAD'].includes(request.method))return new Response(null,{status:405,headers:{...security,Allow:'GET, HEAD'}});
  if(path==='/'||path==='/trial')return new Response(null,{status:308,headers:{...security,Location:'/trial/'}});
  if(url.search)return new Response('Trial pages do not accept query parameters.',{status:400,headers:security});
  const source=path==='/trial/'||path==='/trial/signup'?'/trial/index.html':path;
  const response=await assets.fetch(new Request(url.origin+source));
  const headers=new Headers(response.headers);headers.delete('Set-Cookie');headers.delete('WWW-Authenticate');
  for(const [key,value] of Object.entries(security))headers.set(key,value);
  if(path==='/trial/signup')headers.set('Content-Security-Policy',"default-src 'none'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  return new Response(request.method==='HEAD'?null:response.body,{status:response.status,headers});
}
