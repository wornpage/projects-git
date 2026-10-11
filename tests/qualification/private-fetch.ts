// Public requests never reach the app in this qualification Worker. Cloudflare
// Access may handle its own login endpoints before this handler, while tests use
// the account's private service binding and a fixed internal request origin.
export function privateQualificationFetch<T extends {ACCESS_AUD?: string}>(handler: (request: Request, env: T) => Promise<Response>) {
  return (request: Request, env: T): Promise<Response> => {
    const url=new URL(request.url);
    if(url.origin==='https://qualification.invalid')return handler(request,env);
    // Cloudflared's browser token-transfer callback needs an HTML landing
    // response. It contains no app assets, API results or reflected query data.
    if(env.ACCESS_AUD&&url.searchParams.get('aud')===env.ACCESS_AUD&&url.searchParams.has('token')
      &&['/','/cdn-cgi/access/cli'].includes(url.pathname))return Promise.resolve(new Response('<!doctype html><html><head><meta charset="utf-8"><title>Cloudflare Access sign-in</title></head><body><p>Cloudflare Access sign-in only. The application is private.</p></body></html>',{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}}));
    return Promise.resolve(new Response('Not found',{status:404,headers:{'Cache-Control':'no-store'}}));
  };
}
