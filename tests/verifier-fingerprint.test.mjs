import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { verifierFingerprint, verifierInputs } from '../scripts/verifier-fingerprint.mjs';

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'projects-verifier-boundary-'));
  const put = async (name, value) => { const file = join(base, name); await mkdir(dirname(file), { recursive: true }); await writeFile(file, value); };
  await put('package.json', '{"type":"module"}');
  await put('package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/example': { version: '1.0.0', integrity: 'sha512-pinned-fixture' } } }));
  await put('scripts/verifier-fingerprint.mjs', 'export const format = 1;');
  await put('src/cloudflare/index.ts', 'import "./security.ts"; export { check } from "./check-container.ts"; import "./verifier-identity.ts";');
  await put('src/cloudflare/security.ts', 'import "../core/policy.mjs"; import type { T } from "./types-only.ts"; const guest = "import \'./guest.mjs\'";');
  await put('src/core/policy.mjs', 'export const allowed = false;');
  await put('src/cloudflare/check-container.ts', 'export const check = 1;');
  await put('src/cloudflare/subscription-service.ts', 'export const registration = 1;');
  const identity = (await readFile(new URL('../src/cloudflare/verifier-identity.ts', import.meta.url), 'utf8')).replace(/[a-f0-9]{64}/, '0'.repeat(64));
  await put('src/cloudflare/verifier-identity.ts', identity);
  return { base, put, identity };
}

test('actual verifier boundary includes imported authorization, Git, sandbox and authoritative cases', async () => {
  const inputs = await verifierInputs();
  for (const name of ['src/cloudflare/security.ts', 'src/cloudflare/git-transport.mjs', 'src/cloudflare/sandbox.ts', 'src/cloudflare/subscription-service.ts', 'src/cloudflare/subscription-provider.ts', 'fixtures/checkout-cases.mjs', 'src/core/project-work.mjs', 'src/core/agent.mjs', 'package-lock.json', 'scripts/verifier-fingerprint.mjs']) assert.ok(inputs.includes(name), name);
  assert.ok(!inputs.includes('src/cloudflare/verifier-identity.ts'));
  assert.deepEqual(inputs, [...new Set(inputs)].sort());
});

test('transitive policy and fixture edits change the digest; unrelated, guest and generated text do not', async () => {
  const f = await fixture(), initial = await verifierFingerprint(f.base);
  await f.put('src/core/policy.mjs', 'export const allowed = true;');
  const changed = await verifierFingerprint(f.base); assert.notEqual(changed, initial);
  await f.put('unrelated.mjs', 'export const changed = true;');
  await f.put('src/cloudflare/guest.mjs', 'export const guest = true;');
  await f.put('src/cloudflare/verifier-identity.ts', f.identity.replace('0'.repeat(64), '1'.repeat(64)));
  assert.equal(await verifierFingerprint(f.base), changed);
  await f.put('src/cloudflare/index.ts', 'export { value } from "../../fixtures/cases.mjs";');
  await f.put('fixtures/cases.mjs', 'export const value = 1;');
  const beforeCaseChange = await verifierFingerprint(f.base);
  await f.put('fixtures/cases.mjs', 'export const value = 2;');
  assert.notEqual(await verifierFingerprint(f.base), beforeCaseChange);
});

test('static dynamic imports and require are covered; unbounded and missing imports refuse', async () => {
  const f = await fixture();
  await f.put('src/cloudflare/index.ts', 'await import("../core/policy.mjs"); require("./security.ts");');
  assert.ok((await verifierInputs(f.base)).includes('src/core/policy.mjs'));
  await f.put('src/cloudflare/index.ts', 'const target = "./security.ts"; await import(target);');
  await assert.rejects(verifierFingerprint(f.base), /argument is not a string literal/);
  await f.put('src/cloudflare/index.ts', 'import "./missing.ts";');
  await assert.rejects(verifierFingerprint(f.base), /ENOENT/);
});

test('external dependencies require pins and lockfile changes alter provenance', async () => {
  const f = await fixture(); await f.put('src/cloudflare/index.ts', 'import "example";');
  const first = await verifierFingerprint(f.base);
  await f.put('package-lock.json', JSON.stringify({ packages: { 'node_modules/example': { version: '2.0.0', integrity: 'sha512-next-fixture' } } }));
  assert.notEqual(await verifierFingerprint(f.base), first);
  await f.put('src/cloudflare/index.ts', 'import "unlocked-package";');
  await assert.rejects(verifierFingerprint(f.base), /lacks a locked version and integrity/);
});

test('outside imports, source redirection, unsupported URLs and malformed source refuse', async () => {
  const f = await fixture();
  await f.put('src/cloudflare/index.ts', 'import "../../../outside.mjs";');
  await assert.rejects(verifierFingerprint(f.base), /escapes the source root/);
  await f.put('src/cloudflare/index.ts', 'import "https://example.invalid/module.mjs";');
  await assert.rejects(verifierFingerprint(f.base), /unsupported source location/);
  await f.put('src/cloudflare/index.ts', 'const = broken;');
  await assert.rejects(verifierFingerprint(f.base), /dependency discovery failed/);
  await f.put('src/cloudflare/index.ts', Buffer.from([0xff]));
  await assert.rejects(verifierFingerprint(f.base), /encoded data/);
  const outside = await mkdtemp(join(tmpdir(), 'projects-verifier-outside-'));
  await writeFile(join(outside, 'other.mjs'), 'export const outside = true;');
  await symlink(outside, join(f.base, 'src/cloudflare/redirect'), process.platform === 'win32' ? 'junction' : 'dir');
  await f.put('src/cloudflare/index.ts', 'import "./redirect/other.mjs";');
  await assert.rejects(verifierFingerprint(f.base), /source is redirected/);
});

test('generated identity exclusion rejects added executable code', async () => {
  const f = await fixture();
  await f.put('src/cloudflare/verifier-identity.ts', f.identity + 'import "./security.ts";\n');
  await assert.rejects(verifierFingerprint(f.base), /identity contains unexpected source/);
});
