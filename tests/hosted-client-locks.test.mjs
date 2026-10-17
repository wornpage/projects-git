import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, readdir, realpath, rm, rename, unlink, link} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {HostedClientLocks} from '../src/local/hosted-client-locks.mjs';

const moduleUrl = new URL('../src/local/hosted-client-locks.mjs', import.meta.url).href;
const scope = {origin: 'https://workspace.example.test', workspaceId: 'fixture', principal: 'fixture-agent'};
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'projects-client-locks-')));
  t.after(async () => {
    assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep));
    await rm(root, {recursive: true, force: true});
  });
  const directory = path.join(root, 'state'), checkout = path.join(root, 'checkout');
  await mkdir(path.join(checkout, '.git'), {recursive: true});
  return {root, directory, checkout, locks: new HostedClientLocks(directory, scope), requestId: randomUUID(), runId: randomUUID()};
}
async function childOwner(t, f, checkout = null) {
  const source = `import {HostedClientLocks} from ${JSON.stringify(moduleUrl)};
    const c = JSON.parse(process.argv[1]), locks = new HostedClientLocks(c.directory, c.scope);
    await locks.run('push', c.requestId, c.runId, async () => {
      const hold = async () => {process.send(await locks.inspect()); setInterval(() => {}, 1000); await new Promise(() => {});};
      if (c.checkout) await locks.checkout(c.checkout, hold); else await hold();
    });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source,
    JSON.stringify({...f, locks: undefined, scope, checkout})], {stdio: ['ignore', 'ignore', 'pipe', 'ipc']});
  let stderr = ''; child.stderr.on('data', chunk => {stderr += chunk;});
  const exited = once(child, 'exit');
  const ready = Promise.race([once(child, 'message').then(([value]) => value), exited.then(() => {throw Error('Lock child exited: ' + stderr);})]);
  const stop = async () => {if (child.exitCode === null && child.signalCode === null) child.kill(); await exited;};
  t.after(stop);
  return {child, inventory: await ready, stop};
}

test('same request or run refuses overlap across clients; independent runs remain concurrent', async t => {
  const f = await fixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers();
  t.after(() => release.resolve());
  const first = f.locks.run('start', f.requestId, f.runId, async () => {entered.resolve(); await release.promise; return 'first';});
  await entered.promise;
  const second = new HostedClientLocks(f.directory, scope);
  await assert.rejects(second.run('fail', randomUUID(), f.runId, () => assert.fail('conflicting effect')), /Another local operation/);
  await assert.rejects(second.run('start', f.requestId, randomUUID(), () => assert.fail('same request effect')), /Another local operation/);
  assert.equal(await second.run('start', randomUUID(), randomUUID(), () => 'independent'), 'independent');
  const inventory = await second.inspect();
  assert.equal(inventory.total, 2); assert.equal(inventory.unreadable, 0);
  assert.ok(inventory.locks.every(lock => lock.requestId === f.requestId && lock.processState === 'running'));
  release.resolve(); assert.equal(await first, 'first'); assert.equal((await second.inspect()).total, 0);
});

test('a live separate process owns request, run and physical checkout until explicitly stopped', {timeout: 15000}, async t => {
  const f = await fixture(t), child = await childOwner(t, f, f.checkout), lockId = child.inventory.locks[0].lockId;
  await assert.rejects(f.locks.run('start', randomUUID(), f.runId, () => assert.fail()), /Another local operation/);
  await assert.rejects(f.locks.release(f.requestId, lockId, f.checkout), /owner is running/);
  assert.equal((await f.locks.release(f.requestId, randomUUID())).releasedLocalLocks, 0);
  await child.stop();
  assert.ok((await f.locks.inspect()).locks.every(lock => lock.processState === 'stopped'));
  const result = await f.locks.release(f.requestId, lockId, f.checkout);
  assert.equal(result.releasedLocalLocks, 3); assert.equal(result.remoteOutcome, 'not-established');
  assert.equal((await f.locks.inspect()).total, 0);
  assert.deepEqual(await readdir(path.join(f.checkout, '.git')), []);
});

test('physical checkout lock coordinates different connection profiles', {timeout: 15000}, async t => {
  const f = await fixture(t), child = await childOwner(t, f, f.checkout);
  const other = new HostedClientLocks(path.join(f.root, 'other-state'), {...scope, principal: 'another-agent'});
  await assert.rejects(other.run('push', randomUUID(), randomUUID(), () => other.checkout(f.checkout, () => assert.fail('overlapping Git effect'))), /Another local operation/);
  assert.equal((await other.inspect()).total, 0);
  assert.equal((await f.locks.inspect()).total, 2);
  await child.stop();
});

test('claim blocks assignment operations until issued-once credential retention completes', async t => {
  const f = await fixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers(), retained = [];
  t.after(() => release.resolve());
  const claim = f.locks.run('claim', f.requestId, null, async () => {
    entered.resolve(); await release.promise;
    await f.locks.retainClaim(f.runId, () => retained.push(f.runId));
  });
  await entered.promise;
  const other = new HostedClientLocks(f.directory, scope);
  await assert.rejects(other.run('start', randomUUID(), f.runId, () => assert.fail()), /claim is still retaining/);
  await assert.rejects(other.run('claim', randomUUID(), null, () => assert.fail()), /Another local operation/);
  release.resolve(); await claim; assert.deepEqual(retained, [f.runId]);
  await other.run('start', randomUUID(), f.runId, async () => {
    await assert.rejects(f.locks.run('claim', randomUUID(), null, () => assert.fail()), /assignment operation is active/);
  });
  assert.equal((await other.inspect()).total, 0);
});

test('checkout/start and submit/push share a root owner; unrelated nesting and escaped callbacks refuse', async t => {
  const f = await fixture(t); let late;
  await f.locks.run('checkout', f.requestId, f.runId, async () => {
    await f.locks.run('start', randomUUID(), f.runId, async () => {
      const inventory = await f.locks.inspect();
      assert.equal(inventory.total, 3); assert.equal(new Set(inventory.locks.map(lock => lock.lockId)).size, 1);
      assert.ok(inventory.locks.every(lock => lock.requestId === f.requestId));
    });
    await assert.rejects(f.locks.run('fail', randomUUID(), f.runId, () => assert.fail()), /unrelated nested/);
  });
  // AsyncLocalStorage propagates into a delayed continuation, but the owner is closed.
  const resume = Promise.withResolvers();
  await f.locks.run('submit', randomUUID(), f.runId, async () => {
    await f.locks.run('push', randomUUID(), f.runId, () => f.locks.checkout(f.checkout, () => 'pushed'));
    late = resume.promise.then(() => f.locks.run('push', randomUUID(), f.runId, () => assert.fail()));
  });
  const refused = assert.rejects(late, /unrelated nested/); resume.resolve(); await refused;
  assert.equal((await f.locks.inspect()).total, 0);
});

test('cleanup preserves the request anchor when unexpected resource contents prevent removal', async t => {
  const f = await fixture(t), marker = path.join(f.directory, 'locks', 'run-' + f.runId, 'preserve.txt');
  await assert.rejects(f.locks.run('start', f.requestId, f.runId, async () => {
    await writeFile(marker, 'unrelated content'); return 'effect completed';
  }), /cleanup is incomplete/);
  assert.equal(await readFile(marker, 'utf8'), 'unrelated content');
  const inventory = await f.locks.inspect(); assert.equal(inventory.total, 2);
  assert.ok(inventory.locks.every(lock => lock.requestId === f.requestId));
});

test('old nonce release cannot remove a later operation on the same checkout', {timeout: 15000}, async t => {
  const f = await fixture(t), first = await childOwner(t, f, f.checkout), lockId = first.inventory.locks[0].lockId;
  await first.stop(); await f.locks.release(f.requestId, lockId, f.checkout);
  const second = await childOwner(t, {...f, requestId: randomUUID()}, f.checkout);
  assert.equal((await f.locks.release(f.requestId, lockId, f.checkout)).releasedLocalLocks, 0);
  assert.equal((await f.locks.inspect()).locks[0].lockId, second.inventory.locks[0].lockId);
  await second.stop();
});

test('simultaneous explicit release never doubles removal or touches unrelated files', {timeout: 15000}, async t => {
  const f = await fixture(t), child = await childOwner(t, f, f.checkout), lockId = child.inventory.locks[0].lockId;
  await child.stop(); await writeFile(path.join(f.checkout, 'keep.txt'), 'keep');
  const second = new HostedClientLocks(f.directory, scope);
  const results = await Promise.allSettled([f.locks.release(f.requestId, lockId, f.checkout), second.release(f.requestId, lockId, f.checkout)]);
  assert.ok(results.some(result => result.status === 'fulfilled'));
  assert.ok(results.reduce((sum, result) => sum + (result.status === 'fulfilled' ? result.value.releasedLocalLocks : 0), 0) <= 3);
  assert.equal(await readFile(path.join(f.checkout, 'keep.txt'), 'utf8'), 'keep');
  assert.equal((await f.locks.inspect()).total, 0);
});

test('interrupted release can finish from its exact retired directory after both processes stopped', {timeout: 15000}, async t => {
  const f = await fixture(t), child = await childOwner(t, f), owner = child.inventory.locks[0]; await child.stop();
  const resource = owner.resource, canonical = path.join(f.directory, 'locks', resource), retired = canonical + '.released-' + owner.lockId;
  await mkdir(path.join(canonical, 'release'));
  await writeFile(path.join(canonical, 'release', 'owner.json'), JSON.stringify({pid: child.child.pid, lockId: owner.lockId}), {mode: 0o600});
  assert.equal(path.dirname(canonical), path.dirname(retired)); await rename(canonical, retired);
  assert.ok((await f.locks.inspect()).locks.some(lock => lock.state === 'release-incomplete'));
  assert.equal((await f.locks.release(f.requestId, owner.lockId)).releasedLocalLocks, 2);
  assert.equal((await f.locks.inspect()).total, 0);
});

test('an interrupted pre-rename release guard and unknown contents require inspection', {timeout: 15000}, async t => {
  const f = await fixture(t), child = await childOwner(t, f), owner = child.inventory.locks[0]; await child.stop();
  const directory = path.join(f.directory, 'locks', owner.resource);
  await mkdir(path.join(directory, 'release'));
  await writeFile(path.join(directory, 'keep.txt'), 'preserve');
  await assert.rejects(f.locks.release(f.requestId, owner.lockId), /EEXIST|unexpected contents/);
  assert.equal(await readFile(path.join(directory, 'keep.txt'), 'utf8'), 'preserve');
  assert.ok(await readFile(path.join(directory, 'owner.json'), 'utf8'));
});

test('unreadable, foreign and hardlinked metadata are preserved rather than treated as stale', {timeout: 15000}, async t => {
  const f = await fixture(t), child = await childOwner(t, f), owner = child.inventory.locks[0]; await child.stop();
  const file = path.join(f.directory, 'locks', owner.resource, 'owner.json'), original = await readFile(file, 'utf8');
  for (const content of ['{broken', JSON.stringify({...owner, scopeSha256: 'foreign'})]) {
    await writeFile(file, content);
    assert.equal((await f.locks.inspect()).unreadable, 1);
    await assert.rejects(f.locks.run('start', f.requestId, f.runId, () => assert.fail()), /Another local operation/);
    assert.equal(await readFile(file, 'utf8'), content);
  }
  await writeFile(file, original);
  const extra = path.join(f.root, 'owner-copy.json'); await link(file, extra);
  assert.equal((await f.locks.inspect()).unreadable, 1);
  assert.equal(await readFile(extra, 'utf8'), original); await unlink(extra);
});

test('empty inspection creates no state and never reports a partial oversized inventory', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.locks.inspect(), {locks: [], total: 0, unreadable: 0, complete: true});
  await assert.rejects(readdir(f.directory), {code: 'ENOENT'});
  await mkdir(path.join(f.directory, 'locks'), {recursive: true});
  for (let i = 0; i < 257; i++) await mkdir(path.join(f.directory, 'locks', 'request-' + randomUUID()));
  await assert.rejects(f.locks.inspect(), /no partial lock inventory/);
});
