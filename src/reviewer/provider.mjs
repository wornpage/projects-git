const WORKERS_AI=/^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/([a-f0-9]{32})\/ai\/v1\/chat\/completions$/;
const OPENAI='https://api.openai.com/v1/chat/completions';

export function reviewerProviderOptions({kind,endpoint,account}){
  if(kind==='workers-ai'){
    const match=typeof endpoint==='string'?WORKERS_AI.exec(endpoint):null;
    if(!match||(account&&match[1]!==account))
      throw new Error('Workers AI requires the pinned Cloudflare account Chat Completions endpoint.');
    return {tokenLimitField:'max_tokens',rejectIfBusy:true};
  }
  if(kind==='openai'){
    if(endpoint!==OPENAI)throw new Error('OpenAI review requires the official Chat Completions endpoint.');
    return {tokenLimitField:'max_completion_tokens',rejectIfBusy:false};
  }
  throw new Error('Select an explicit Workers AI or OpenAI reviewer provider.');
}
