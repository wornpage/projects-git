import {ApiError,bodyJson} from './security.ts';

export const trialTurnstileAction='turnstile-spin-v2';
export function trialTurnstilePublic(env:Env) {
  const siteKey=env.TRIAL_TURNSTILE_SITE_KEY;
  if(typeof siteKey!=='string'||!siteKey||!/^[A-Za-z0-9_-]{1,100}$/.test(siteKey))
    throw new ApiError(503,'TRIAL_VERIFICATION_UNAVAILABLE','Trial verification is unavailable. Check again later.');
  return {siteKey,action:trialTurnstileAction};
}

export async function verifyTrialTurnstile(request:Request,env:Env,token:unknown,fetcher:typeof fetch=fetch) {
  trialTurnstilePublic(env);
  const secret=env.TRIAL_TURNSTILE_SECRET,hostname=env.TRIAL_TURNSTILE_HOSTNAME;
  if(!secret||!hostname||hostname!==new URL(request.url).hostname)
    throw new ApiError(503,'TRIAL_VERIFICATION_UNAVAILABLE','Trial verification is unavailable. Check again later.');
  if(typeof token!=='string'||!token.trim()||token.length>2048)
    throw new ApiError(403,'TRIAL_VERIFICATION_REQUIRED','Complete the security check before reserving.');
  const form=new URLSearchParams({secret,response:token});
  const ip=request.headers.get('CF-Connecting-IP');if(ip)form.set('remoteip',ip);
  let result:Record<string,unknown>;
  try {
    const response=await fetcher('https://challenges.cloudflare.com/turnstile/v0/siteverify',{
      method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:form,
      redirect:'manual',signal:AbortSignal.timeout(10000),
    });
    if(!response.ok||!response.body)throw Error('Verification unavailable');
    // Reuse the bounded JSON reader; provider output must never enter a receipt
    // or expose its secret/token in an error response.
    result=await bodyJson(new Request('https://siteverify.invalid/',{method:'POST',headers:response.headers,body:response.body,duplex:'half'} as RequestInit),[],8192);
  }catch{throw new ApiError(503,'TRIAL_VERIFICATION_UNAVAILABLE','Trial verification is unavailable. Check your reservation status before trying again.');}
  if(result.success!==true||result.hostname!==hostname||result.action!==trialTurnstileAction)
    throw new ApiError(403,'TRIAL_VERIFICATION_FAILED','The security check expired or failed. Complete a new check before reserving.');
}
