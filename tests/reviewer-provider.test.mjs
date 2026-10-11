import test from 'node:test';
import assert from 'node:assert/strict';
import {chatProvider} from '../src/core/agent.mjs';
import {reviewerProviderOptions} from '../src/reviewer/provider.mjs';

const account='a'.repeat(32);
const workersEndpoint=`https://api.cloudflare.com/client/v4/accounts/${account}/ai/v1/chat/completions`;
const openaiEndpoint='https://api.openai.com/v1/chat/completions';

async function sentBody(kind,endpoint){
  let sent;
  const provider=chatProvider({endpoint,apiKey:'private-test-key',model:'fixture-reviewer',
    ...reviewerProviderOptions({kind,endpoint,account}),
    fetchImpl:async(_url,options)=>{sent=JSON.parse(options.body);
      return Response.json({choices:[{message:{content:'{}'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1}});}});
  await provider({messages:[{role:'user',content:'fixture'}],maxOutputTokens:1024,signal:new AbortController().signal});
  return sent;
}

test('Workers AI reviewer request uses its capped token field and rejects busy capacity',async()=>{
  const body=await sentBody('workers-ai',workersEndpoint);
  assert.equal(body.max_tokens,1024);
  assert.equal(body.max_completion_tokens,undefined);
  assert.deepEqual(body.options,{rejectIfBusy:true});
});

test('OpenAI reviewer request uses its capped token field at the official endpoint',async()=>{
  const body=await sentBody('openai',openaiEndpoint);
  assert.equal(body.max_completion_tokens,1024);
  assert.equal(body.max_tokens,undefined);
  assert.equal(body.options,undefined);
});

test('reviewer provider selection refuses foreign hosts and Cloudflare accounts before inference',()=>{
  for(const input of [
    {kind:'workers-ai',endpoint:workersEndpoint,account:'b'.repeat(32)},
    {kind:'workers-ai',endpoint:'https://foreign.example/chat/completions',account},
    {kind:'openai',endpoint:'https://foreign.example/chat/completions'},
    {kind:'unselected',endpoint:workersEndpoint},
  ])assert.throws(()=>reviewerProviderOptions(input));
});
