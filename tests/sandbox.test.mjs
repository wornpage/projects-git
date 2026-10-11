import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { DockerChecks } from '../src/local/sandbox-checks.mjs';
import { scoreCheckout } from '../fixtures/checkout-cases.mjs';
import { GitRunner } from '../src/local/git-runner.mjs';
import { runEditingAgent } from '../src/core/agent.mjs';
const exec = promisify(execFile);
const image = process.env.PROJECTS_SANDBOX_TEST_IMAGE;
const options = { skip: !image, timeout: 120000 };

test('independent scoring rejects a forged all-pass report', () => {
  const forged = JSON.stringify({ passed: 16, total: 16, checks: Array.from({ length: 16 }, () => ({ passed: true })) });
  assert.equal(scoreCheckout(forged).passed, 0);
  assert.throws(() => new DockerChecks({ image: 'node:latest' }), /immutable/);
});

test('cancelling an observed running busy container joins its removal', { skip: !image, timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'projects-cancel-'));
  const source = path.join(root,'candidate');await mkdir(source);
  const controller = new AbortController(), marker = crypto.randomUUID();
  const code = `const marker=${JSON.stringify(marker)};process.on('SIGTERM',()=>{});while(true){}`;
  const sandbox = new DockerChecks({ image, timeoutMs: 15000 });
  let containerId;
  const operation = sandbox.observe(source, { argv: ['node', '-e', code], signal: controller.signal });
  operation.catch(() => {});
  t.after(async () => {
    controller.abort();
    if(containerId)await exec('docker',['rm','--force',containerId],{timeout:10000}).catch(()=>{});
    await operation.catch(()=>{});
    assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep));
    await rm(root,{recursive:true,force:true});
  });
  const deadline = Date.now() + 10000;
  while(!containerId && Date.now()<deadline){
    const ids=(await exec('docker',['ps','-q','--filter','name=projects-check-'],{timeout:10000})).stdout.trim().split(/\s+/).filter(Boolean);
    if(ids.length){
      const running=JSON.parse((await exec('docker',['inspect',...ids],{timeout:10000})).stdout);
      containerId=running.find(container=>container.State.Running&&container.Config.Cmd.includes(code))?.Id;
    }
  }
  assert.ok(containerId,'Observe actual execution before requesting cancellation.');
  controller.abort();
  let timer;
  try{
    await assert.rejects(Promise.race([operation,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Cancellation did not join container removal.')),5000);})]),/Sandbox stopped/);
  }finally{clearTimeout(timer);}
  const remaining=(await exec('docker',['ps','-aq','--filter','id='+containerId],{timeout:10000})).stdout.trim();
  assert.equal(remaining,'','The interrupted executor must be removed before the caller settles.');
});

test('real container checks genuine behavior and refuses forged evidence or host access', options, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'projects-sandbox-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sandbox = new DockerChecks({ image });
  await sandbox.ready();
  await exec(process.execPath, ['src/local/scripted-agent.mjs', 'careful', root]);
  const source = path.join(root, 'checkout.mjs');
  const good = await sandbox.verify(source);
  assert.equal(good.passed, 16);
  assert.equal(good.total, 16);
  const validSource = await readFile(source, 'utf8');
  await writeFile(source, validSource.replace('let total = 0;', 'items.push({ unitCents: 0, quantity: 1 }); let total = 0;'));
  assert.ok((await sandbox.verify(source)).passed < 16, 'A correct total cannot conceal input mutation.');
  await writeFile(source, 'process.stdout.write(JSON.stringify({passed:16,total:16})); process.exit(0);');
  assert.equal((await sandbox.verify(source)).passed, 0);
  await writeFile(source, 'import {readFileSync} from "node:fs"; readFileSync("/var/run/docker.sock"); export const checkoutTotal = () => 0;');
  assert.equal((await sandbox.verify(source)).passed, 0);
});

test('model edits become exact Git evidence and still require sandbox reverification after restart', options, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'projects-model-git-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sandbox = new DockerChecks({ image });
  const runner = new GitRunner({ rootDir: path.join(root, 'repos'), sandbox });
  const task = await runner.createDemoRepository('model-task');
  await exec(process.execPath, ['src/local/scripted-agent.mjs', 'careful', root]);
  const content = await readFile(path.join(root, 'checkout.mjs'), 'utf8');
  const receipts = [];
  const result = await runner.runCandidate({ ...task, runId: 'model-run', agent: 'model', modelWork: context => runEditingAgent({ ...context,
    instructions: 'Implement valid checkout totals.', limits: { maxRequests: 1, maxInputBytes: 4096, maxOutputTokens: 2048, timeoutMs: 60000 },
    provider: async () => ({ content: JSON.stringify({ files: [{ path: 'checkout.mjs', content }], summary: 'Transport fixture supplied real executable code.' }), finishReason: 'stop', usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } }),
    save: async receipt => receipts.push(receipt),
  }) });
  assert.equal(result.evidence.source, 'independent-sandbox-checks');
  assert.equal(result.evidence.commit, result.headCommit);
  assert.equal(result.evidence.passed, 16);
  const withoutSandbox = new GitRunner({ rootDir: path.join(root, 'repos') });
  await assert.rejects(withoutSandbox.mergeCandidate({ ...task, runId: 'model-run', headCommit: result.headCommit }), /require the configured sandbox/);
  const restarted = new GitRunner({ rootDir: path.join(root, 'repos'), sandbox });
  const merged = await restarted.mergeCandidate({ ...task, runId: 'model-run', headCommit: result.headCommit });
  assert.equal(merged.mergedCommit, result.headCommit);
  assert.equal(receipts.at(-1).requests.length, 1);
});
