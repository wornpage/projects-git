import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { observeContainer } from '../src/cloudflare/container-observer.ts';
import { readArtifactSnapshot } from '../src/cloudflare/artifacts.ts';
import { verifyArtifactCandidate } from '../src/cloudflare/repository-checks.ts';
import { digest, requirementsDigest } from '../src/core/check-definition.mjs';
import { verifierFingerprint } from '../scripts/verifier-fingerprint.mjs';
import { VERIFIER_SHA256 } from '../src/cloudflare/verifier-identity.ts';

const head = 'a'.repeat(40), tree = 'b'.repeat(40), image = 'sha256:' + 'c'.repeat(64);
const file = (name, content, mode = '100644') => ({ name, base64: Buffer.from(content).toString('base64'), mode,
  oid: createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest('hex') });
const files = [file('sum.py', 'import sys\nprint(sum(map(int, sys.stdin.read().split())))\n')];
const task = { title: 'Sum integers', purpose: 'Correct integer sums', criteria: ['Observe the sum'], revision: 1 };
const run = { headCommit: head };
const policy = checks => {
  const definition = JSON.stringify({ format: 'repository-command-checks/v1', commit: head, taskRevision: 1, requirementsSha256: requirementsDigest(task), timeoutMs: 10000, checks });
  return { definition, definitionSha256: digest(definition) };
};
const check = { name: 'Sum', argv: ['python3', 'sum.py'], stdin: '20 22', expected: { exitCode: 0, stdout: '42\n' } };

test('hosted command scorer keeps expectations outside candidate execution and binds all proof', async () => {
  let calls = 0;
  const result = await verifyArtifactCandidate({ observe: async (...args) => {
    calls++; assert.equal(args.length, 6); assert.equal(JSON.stringify(args).includes('expected'), false);
    assert.deepEqual(args[2], files); assert.deepEqual(args[3], check.argv);
    return { stdout: '42\n', exitCode: 0, image: 'registry.example/verifier@' + image };
  } }, { commit: head, tree, files }, task, run, policy([check]), 'd'.repeat(64), 'attempt');
  assert.equal(calls, 1); assert.equal(result.verified, true); assert.equal(result.passed, 1); assert.equal(result.total, 1);
  assert.equal(result.verification.image, image); assert.equal(result.verification.verifierSha256, VERIFIER_SHA256);
  assert.equal(result.verification.requirementsSha256, requirementsDigest(task));
  assert.equal(result.verification.tree, tree); assert.equal(result.verification.inputHandoffSha256, 'd'.repeat(64));
});

test('forged pass text cannot authorize acceptance; interrupted attempts retain the denominator', async () => {
  const forged = await verifyArtifactCandidate({ observe: async () => ({ stdout: '{"verified":true,"passed":1}', exitCode: 0, image }) }, { commit: head, tree, files }, task, run, policy([check]), 'd'.repeat(64), 'forged');
  assert.equal(forged.verified, true); assert.equal(forged.passed, 0); assert.equal(forged.total, 1);
  assert.ok(!forged.output.includes('{"verified"'));
  let calls = 0;
  const interrupted = await verifyArtifactCandidate({ observe: async () => { calls++; throw new Error('sensitive provider error'); } }, { commit: head, tree, files }, task, run, policy([check, { ...check, name: 'Second check' }]), 'd'.repeat(64), 'interrupted');
  assert.equal(calls, 1); assert.equal(interrupted.verified, false); assert.equal(interrupted.total, 2); assert.equal(interrupted.passed, 0);
  assert.match(interrupted.checks[1].detail, /Not run/); assert.ok(!JSON.stringify(interrupted).includes('sensitive'));
});

test('snapshot bytes must hash to the committed Git object and paths cannot alias', async () => {
  const repo = {
    readCommit: async () => ({ hash: head, treeHash: tree }),
    readTree: async () => files.map(f => ({ name: f.name, mode: f.mode, hash: f.oid, type: 'blob' })),
    readBlob: async () => new Blob([Buffer.from(files[0].base64, 'base64')]),
  };
  assert.deepEqual((await readArtifactSnapshot(repo, head)).files, files);
  repo.readBlob = async () => new Blob(['different source']);
  await assert.rejects(readArtifactSnapshot(repo, head), { code: 'BLOB_HASH_MISMATCH' });
  repo.readTree = async () => [{ name: '.git', mode: '100644', hash: files[0].oid, type: 'blob' }];
  await assert.rejects(readArtifactSnapshot(repo, head), { code: 'UNSUPPORTED_SNAPSHOT' });
  repo.readTree = async () => [{ name: 'link', mode: '120000', hash: files[0].oid, type: 'blob' }];
  await assert.rejects(readArtifactSnapshot(repo, head), { code: 'UNSUPPORTED_SNAPSHOT' });
});

test('hosted verifier identity matches all current trusted source files', async () => {
  assert.equal(await verifierFingerprint(), VERIFIER_SHA256);
});

// Exercise the exact production materializer, output reader, deadline and cleanup
// against real Linux commands. This adapter is NOT Workerd's Container API proof.
class DockerContainer {
  running = false;
  name = 'projects-command-qa-' + crypto.randomUUID();
  starts = [];
  start(options) {
    this.starts.push(options); assert.equal(options.enableInternet, false); assert.deepEqual(options.env, {});
    execFileSync('docker', ['run', '-d', '--name', this.name, '--network', 'none', '--memory', '256m', '--cpus', '1', '--pids-limit', '64', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--entrypoint', options.entrypoint[0], options.image, ...options.entrypoint.slice(1)], { stdio: 'pipe' });
    this.running = true;
  }
  async exec(argv, options) {
    const child = spawn('docker', ['exec', '-i', ...(options.cwd ? ['-w', options.cwd] : []), ...Object.entries(options.env ?? {}).flatMap(([k,v]) => ['-e', k + '=' + v]), this.name, ...argv], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => {});
    if (options.stdin) Readable.fromWeb(options.stdin).pipe(child.stdin); else child.stdin.end();
    return { stdout: Readable.toWeb(child.stdout), stderr: Readable.toWeb(child.stderr), exitCode: new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => resolve(code ?? 137)); }) };
  }
  async destroy() {
    if (!this.running) return;
    this.running = false;
    execFileSync('docker', ['rm', '-f', this.name], { stdio: 'pipe' });
  }
}
const dockerImage = process.env.PROJECTS_HOSTED_TEST_IMAGE;
test('real Node and Python commands are fresh, networkless, bounded and reaped', { skip: !dockerImage, timeout: 90000 }, async () => {
  const observe = async (argv, input = '', timeout = 12000) => {
    const container = new DockerContainer();
    try { return await observeContainer(container, dockerImage, files, argv, input, timeout); }
    finally { assert.equal(container.running, false); }
  };
  assert.equal((await observe(['python3', 'sum.py'], '20 22\n')).stdout, '42\n');
  assert.equal((await observe(['node', '-e', 'console.log(20+22)'])).stdout, '42\n');
  assert.equal((await observe(['node', '-e', 'require("fs").writeFileSync("/tmp/check-marker","changed");console.log("created")'])).stdout, 'created\n');
  assert.equal((await observe(['node', '-e', 'console.log(require("fs").existsSync("/tmp/check-marker"))'])).stdout, 'false\n');
  assert.equal((await observe(['node', '-e', 'fetch("https://example.com",{signal:AbortSignal.timeout(1500)}).then(()=>process.exit(1),()=>console.log("denied"))'])).stdout, 'denied\n');
  await assert.rejects(observe(['node', '-e', 'process.stdout.write("x".repeat(100000))']), /64 KiB/);
  await assert.rejects(observe(['node', '-e', 'require("child_process").spawn("sleep",["300"],{detached:true,stdio:"ignore"}).unref();setInterval(()=>{},1000)'], '', 1500), /time allowance/);
  const left = execFileSync('docker', ['ps', '-aq', '--filter', 'name=projects-command-qa-'], { encoding: 'utf8' }).trim();
  assert.equal(left, '');
});
