import test from 'node:test';
import assert from 'node:assert/strict';
import { chatProvider, executionLimits, runEditingAgent } from '../src/core/agent.mjs';

const limits = { maxRequests: 2, maxInputBytes: 4096, maxOutputTokens: 512, timeoutMs: 2000 };
const response = (source = 'export const answer = 42;') => ({
  content: JSON.stringify({ files: [{ path: 'answer.mjs', content: source }], summary: 'Implemented the answer.' }),
  finishReason: 'stop', usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 40 } },
});
function fixture(overrides = {}) {
  const receipts = [], calls = [], applied = [];
  const args = { instructions: 'Return the answer.', files: { 'answer.mjs': 'export const answer = 0;' }, limits,
    provider: async input => { calls.push(input); return response(); },
    apply: async edits => applied.push(edits), check: async () => ({ passed: 1, total: 1 }),
    save: async receipt => receipts.push(receipt), ...overrides };
  return { args, receipts, calls, applied };
}

test('bounded agent reserves before inference, retains full history and distinguishes cached usage', async () => {
  let checks = 0;
  const f = fixture({ check: async () => ({ passed: checks++ ? 1 : 0, total: 1 }) });
  f.args.provider = async input => {
    assert.equal(f.receipts.at(-1).usageComplete, false);
    assert.equal(f.receipts.at(-1).requests.at(-1).status, 'in_flight');
    f.calls.push(input);
    return response();
  };
  const result = await runEditingAgent(f.args);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[1].messages.slice(0, 2), f.calls[0].messages);
  assert.equal(f.calls[1].messages.length, 4);
  assert.equal(f.applied.length, 2);
  assert.equal(result.receipt.inputTokens, 200);
  assert.equal(result.receipt.cachedInputTokens, 80);
  assert.equal(result.receipt.outputTokens, 40);
  assert.equal(f.receipts.at(-1).status, 'finished');
  assert.ok(f.receipts.at(-1).finishedAt);
});

test('missing usage ends the attempt without edits or an automatic provider retry', async () => {
  let calls = 0;
  const f = fixture({ provider: async () => { calls++; return { ...response(), usage: null }; } });
  await assert.rejects(runEditingAgent(f.args), /usage is missing/);
  assert.equal(calls, 1);
  assert.equal(f.applied.length, 0);
  assert.equal(f.receipts.at(-1).usageComplete, false);
  assert.equal(f.receipts.at(-1).status, 'failed');
});

test('missing cached detail is unknown, not zero', async () => {
  const result = response();
  delete result.usage.prompt_tokens_details;
  const f = fixture({ provider: async () => result });
  await runEditingAgent(f.args);
  assert.equal(f.receipts.at(-1).cachedInputTokens, null);
});

test('request allowance stops repairs while retaining the last failing candidate', async () => {
  const f = fixture({ check: async () => ({ passed: 0, total: 1 }) });
  await runEditingAgent(f.args);
  assert.equal(f.calls.length, limits.maxRequests);
  assert.equal(f.receipts.at(-1).requests.at(-1).checks.passed, 0);
  assert.equal(f.receipts.at(-1).status, 'finished');
});

test('deadline stops an unresponsive provider and late replies never apply', async () => {
  let complete;
  const f = fixture({ limits: { ...limits, timeoutMs: 1000 }, provider: () => new Promise(resolve => { complete = resolve; }) });
  await assert.rejects(runEditingAgent(f.args), /time budget/);
  complete(response());
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.applied.length, 0);
  assert.equal(f.receipts.at(-1).status, 'stopped');
  assert.equal(f.receipts.at(-1).usageComplete, false);
});

test('oversized full history is refused before provider dispatch', async () => {
  const f = fixture({ instructions: 'x'.repeat(4096), limits });
  await assert.rejects(runEditingAgent(f.args), /history was not truncated/);
  assert.equal(f.calls.length, 0);
});

test('off-scope edits and incomplete output never alter assigned files', async () => {
  for (const result of [
    { ...response(), content: JSON.stringify({ files: [{ path: '../secret', content: 'x' }], summary: 'bad' }) },
    { ...response(), finishReason: 'length' },
    { ...response(), usage: { prompt_tokens: 100, completion_tokens: 513, total_tokens: 613 } },
  ]) {
    const f = fixture({ provider: async () => result });
    await assert.rejects(runEditingAgent(f.args));
    assert.equal(f.applied.length, 0);
    assert.equal(f.receipts.at(-1).requests.length, 1);
  }
  assert.throws(() => executionLimits({ ...limits, maxRequests: 0 }));
});

test('provider enforces one completion, output cap and safe error handling without retry', async () => {
  let seen, count = 0;
  const provider = chatProvider({ endpoint: 'https://example.test/v1/chat/completions', apiKey: 'private-test-key', model: 'test-model', fetchImpl: async (_, options) => {
    seen = options; count++;
    return new Response(JSON.stringify({ choices: [{ message: { content: response().content }, finish_reason: 'stop' }], usage: response().usage }));
  } });
  const result = await provider({ messages: [{ role: 'user', content: 'task' }], maxOutputTokens: 512, signal: new AbortController().signal });
  assert.equal(JSON.parse(seen.body).max_completion_tokens, 512);
  assert.equal(JSON.parse(seen.body).n, 1);
  assert.equal(seen.redirect, 'error');
  assert.equal(count, 1);
  assert.equal(result.usage.total_tokens, 120);
  const workersAI = chatProvider({endpoint:'https://api.cloudflare.com/client/v4/accounts/'+'a'.repeat(32)+'/ai/v1/chat/completions',
    apiKey:'private-test-key',model:'@cf/meta/llama-3.3-70b-instruct-fp8-fast',tokenLimitField:'max_tokens',rejectIfBusy:true,
    fetchImpl:async(_,options)=>{seen=options;return new Response(JSON.stringify({choices:[{message:{content:'{}'},finish_reason:'stop'}],usage:response().usage}));}});
  await workersAI({messages:[{role:'user',content:'task'}],maxOutputTokens:1024,signal:new AbortController().signal});
  assert.equal(JSON.parse(seen.body).max_tokens,1024);
  assert.equal(JSON.parse(seen.body).max_completion_tokens,undefined);
  assert.deepEqual(JSON.parse(seen.body).options,{rejectIfBusy:true});
  const failure = chatProvider({ endpoint: 'https://example.test/v1/chat/completions', apiKey: 'private-test-key', model: 'test-model', fetchImpl: async () => { throw new Error('private-test-key'); } });
  await assert.rejects(failure({ signal: new AbortController().signal }), error => !error.message.includes('private-test-key'));
  assert.throws(() => chatProvider({ endpoint: 'http://example.test/v1/chat/completions', apiKey: 'x', model: 'x' }));
  assert.throws(() => chatProvider({ endpoint: 'https://example.test/v1/chat/completions', apiKey: 'x', model: 'x', tokenLimitField:'unbounded' }));
});
