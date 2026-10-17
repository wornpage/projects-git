import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash, randomUUID} from 'node:crypto';
import {mkdir, open, readFile, readdir, realpath, lstat, unlink, rmdir, rename} from 'node:fs/promises';
import path from 'node:path';

const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const commands = ['claim', 'checkout', 'push', 'start', 'submit', 'fail'];
const resourceName = value => value === 'claim' || /^(request|run)-/.test(value) && uuid(value.slice(value.indexOf('-') + 1));
const canonical = value => process.platform === 'win32' ? value.toLowerCase() : value;
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;
const fail = message => { throw new Error(message); };

export function localProcessState(pid) {
  try { process.kill(pid, 0); return 'running'; }
  catch (error) { return error.code === 'ESRCH' ? 'stopped' : 'unknown'; }
}

async function directoryIdentity(directory) {
  const info = await lstat(directory, {bigint: true});
  if (!info.isDirectory() || info.isSymbolicLink() || canonical(await realpath(directory)) !== canonical(directory))
    fail('Local operation lock path is not an ordinary directory. Inspect it without changing its contents.');
  return info;
}

async function writeExclusive(file, value) {
  const handle = await open(file, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
}

async function readRecord(file) {
  const info = await lstat(file, {bigint: true});
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.size > 16384n
    || process.platform !== 'win32' && (info.mode & 0o077n)) fail('Local operation lock metadata is unsafe. Preserve it for inspection.');
  try { return {value: JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(await readFile(file))), info}; }
  catch { fail('Local operation lock metadata is unreadable. Preserve it for inspection.'); }
}

/** Locks protect local effects; neither ownership nor release proves a remote outcome. */
export class HostedClientLocks {
  constructor(directory, scope, {now = () => Date.now()} = {}) {
    this.directory = path.resolve(directory, 'locks');
    this.scopeSha256 = createHash('sha256').update(JSON.stringify(scope)).digest('hex');
    this.now = now;
    this.context = new AsyncLocalStorage();
  }

  async root(create = false) {
    if (create) await mkdir(this.directory, {recursive: true, mode: 0o700});
    try { await directoryIdentity(this.directory); return true; }
    catch (error) { if (!create && error.code === 'ENOENT') return false; throw error; }
  }

  async owner(directory, resource) {
    const identity = await directoryIdentity(directory);
    const {value, info} = await readRecord(path.join(directory, 'owner.json'));
    if (!value || Object.keys(value).sort().join(',') !== 'command,format,lockId,pid,requestId,resource,scopeSha256,startedAt'
      || value.format !== 'projects-git-client-lock/v1' || value.scopeSha256 !== this.scopeSha256
      || value.resource !== resource || !uuid(value.lockId) || !uuid(value.requestId)
      || !commands.includes(value.command) || !Number.isSafeInteger(value.pid) || value.pid <= 0
      || typeof value.startedAt !== 'string' || !Number.isFinite(Date.parse(value.startedAt)))
      fail('Local operation lock does not match this connection or resource. Preserve it for inspection.');
    return {value, identity, fileIdentity: info};
  }

  async acquire(directory, resource, context) {
    if (context.held.has(canonical(directory))) return;
    try { await mkdir(directory, {mode: 0o700}); }
    catch (error) {
      if (error.code === 'EEXIST') fail('Another local operation holds this request, run or checkout. Use locks and receipt to inspect it; no work was started for this call.');
      throw error;
    }
    const value = {...context.owner, resource};
    // An interrupted initialization is retained. A missing owner is not an empty lock.
    await writeExclusive(path.join(directory, 'owner.json'), value);
    const observed = await this.owner(directory, resource);
    context.held.set(canonical(directory), {directory, resource, ...observed});
  }

  async removeOwned(lock) {
    const observed = await this.owner(lock.directory, lock.resource);
    if (!sameFile(observed.identity, lock.identity) || !sameFile(observed.fileIdentity, lock.fileIdentity)
      || JSON.stringify(observed.value) !== JSON.stringify(lock.value)
      || (await readdir(lock.directory)).sort().join(',') !== 'owner.json')
      fail('Local lock ownership or contents changed. The operation result is retained; inspect locks and receipt before continuing.');
    await unlink(path.join(lock.directory, 'owner.json'));
    await rmdir(lock.directory);
  }

  async run(command, requestId, runId, action) {
    if (!commands.includes(command) || !uuid(requestId) || runId !== null && !uuid(runId)) fail('Invalid local operation identity.');
    let context = this.context.getStore();
    if (context) {
      if (!context.active || context.runId !== runId
        || !({checkout: ['start'], submit: ['push']}[context.owner.command] ?? []).includes(command))
        fail('A local operation cannot start an unrelated nested command.');
      await this.acquire(path.join(this.directory, 'request-' + requestId), 'request-' + requestId, context);
      return action();
    }
    await this.root(true);
    context = {active: true, runId, held: new Map(), owner: {format: 'projects-git-client-lock/v1',
      scopeSha256: this.scopeSha256, lockId: randomUUID(), requestId, command, pid: process.pid, startedAt: new Date(this.now()).toISOString()}};
    return this.context.run(context, async () => {
      try {
        await this.acquire(path.join(this.directory, 'request-' + requestId), 'request-' + requestId, context);
        if (command === 'claim') {
          await this.acquire(path.join(this.directory, 'claim'), 'claim', context);
          // A request directory is the admission marker, even before its owner
          // metadata or run lock is ready. Reject before issuing a credential.
          if ((await readdir(this.directory)).some(name => resourceName(name)
            && (name.startsWith('run-') || name.startsWith('request-') && name !== 'request-' + requestId)))
            fail('An assignment operation is active in this connection. Finish or inspect it before an explicit claim.');
        } else {
          // Register the request first, then check the barrier BEFORE taking a
          // run lock. A claim either sees our marker or we see its barrier.
          try { await lstat(path.join(this.directory, 'claim')); fail('A claim is still retaining its issued-once credential. Inspect local locks before continuing.'); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
          if (runId) await this.acquire(path.join(this.directory, 'run-' + runId), 'run-' + runId, context);
        }
        return await action();
      } finally {
        context.active = false;
        // All local work was awaited. Earlier uncertain provider receipts remain unchanged.
        // Preserve the root request as an inspectable anchor if another lock needs
        // attention, while still releasing independently owned resources.
        const held = [...context.held.values()], anchor = held.shift(), failures = [];
        for (const lock of held.reverse()) {
          try { await this.removeOwned(lock); } catch { failures.push(lock.resource); }
        }
        if (!failures.length && anchor) {
          try { await this.removeOwned(anchor); } catch { failures.push(anchor.resource); }
        }
        if (failures.length) fail('Local lock cleanup is incomplete for request ' + requestId
          + '. The operation may already have completed. Inspect locks and its retained receipt before continuing.');
      }
    });
  }

  async retainClaim(runId, action) {
    const context = this.context.getStore();
    if (!context?.active || context.owner.command !== 'claim' || !uuid(runId)) fail('Claim retention needs its active local operation.');
    await this.acquire(path.join(this.directory, 'run-' + runId), 'run-' + runId, context);
    return action();
  }

  async checkout(directory, action) {
    const context = this.context.getStore();
    if (!context?.active || !context.runId) fail('Checkout effects need an active local run operation.');
    const gitDirectory = path.join(await realpath(directory), '.git');
    await directoryIdentity(gitDirectory);
    await this.acquire(path.join(gitDirectory, 'projects-git-client.lock'), 'checkout', context);
    return action();
  }

  async inspect() {
    if (!await this.root()) return {locks: [], total: 0, complete: true, unreadable: 0};
    const names = await readdir(this.directory);
    if (names.length > 256) fail('More than 256 local lock entries need inspection; no partial lock inventory is reported.');
    const locks = [];
    for (const name of names.sort()) {
      const match = /^((?:request|run)-[a-f0-9-]{36}|claim)(?:\.released-([a-f0-9-]{36}))?$/.exec(name);
      if (!match || !resourceName(match[1]) || match[2] && !uuid(match[2])) fail('Unexpected local lock entry. Preserve the lock directory for inspection.');
      try {
        const {value} = await this.owner(path.join(this.directory, name), match[1]);
        if (match[2] && match[2] !== value.lockId) fail('Retired local lock identity changed.');
        locks.push({...value, state: match[2] ? 'release-incomplete' : 'held', processState: localProcessState(value.pid)});
      } catch { locks.push({resource: match[1], state: 'unreadable', processState: 'unknown'}); }
    }
    return {locks, total: names.length, complete: true, unreadable: locks.filter(lock => lock.state === 'unreadable').length};
  }

  async releaseDirectory(directory, resource, expected) {
    const retired = directory + '.released-' + expected.lockId;
    const presentOwner = async location => {
      try { return await this.owner(location, resource); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        try { await lstat(location); }
        catch (missing) { if (missing.code === 'ENOENT') return null; throw missing; }
        fail('An existing local lock has incomplete ownership metadata. Preserve its request anchor and inspect it manually.');
      }
    };
    let location = directory, observed = await presentOwner(directory);
    if (!observed) { location = retired; observed = await presentOwner(retired); }
    if (!observed) return false;
    const matches = () => observed.value.lockId === expected.lockId && observed.value.requestId === expected.requestId;
    if (!matches()) return false; // A later operation owns the canonical path; do not touch it.
    if (localProcessState(observed.value.pid) !== 'stopped') fail('The lock owner is running or cannot be confirmed stopped. No local lock was released.');
    const claim = path.join(location, 'release');
    if (location === directory) {
      // Serialize explicit releases before rereading ownership. A crash here stays visible.
      await mkdir(claim, {mode: 0o700});
      await writeExclusive(path.join(claim, 'owner.json'), {pid: process.pid, lockId: expected.lockId});
      observed = await this.owner(directory, resource);
      if (!matches() || localProcessState(observed.value.pid) !== 'stopped') fail('Local lock ownership changed during release. Preserve it for inspection.');
      if ((await readdir(directory)).sort().join(',') !== 'owner.json,release') fail('Local lock has unexpected contents. Preserve it for inspection.');
      try { await lstat(retired); fail('A retired lock already exists. Preserve both for inspection.'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      // Both checked paths are siblings within the exact lock parent. No recursive move/delete.
      const parent = await realpath(path.dirname(directory));
      if (canonical(path.dirname(retired)) !== canonical(parent)) fail('Local release target escaped its lock directory.');
      await rename(directory, retired); location = retired;
    } else {
      await directoryIdentity(claim);
      const {value: guard} = await readRecord(path.join(claim, 'owner.json'));
      if (!guard || Object.keys(guard).sort().join(',') !== 'lockId,pid'
        || guard.lockId !== expected.lockId || !Number.isSafeInteger(guard.pid) || guard.pid <= 0
        || localProcessState(guard.pid) !== 'stopped') fail('An earlier lock release is still running or needs manual inspection.');
    }
    const retiredOwner = await this.owner(location, resource);
    if (!sameFile(observed.identity, retiredOwner.identity) || !sameFile(observed.fileIdentity, retiredOwner.fileIdentity)
      || JSON.stringify(retiredOwner.value) !== JSON.stringify(observed.value)) fail('Retired lock ownership changed. Preserve it for inspection.');
    await directoryIdentity(path.join(location, 'release'));
    const {value: releaseOwner} = await readRecord(path.join(location, 'release', 'owner.json'));
    if (releaseOwner?.lockId !== expected.lockId) fail('Release ownership changed. Preserve it for inspection.');
    if ((await readdir(location)).sort().join(',') !== 'owner.json,release'
      || (await readdir(path.join(location, 'release'))).join(',') !== 'owner.json') fail('Retired lock contents changed. Preserve it for inspection.');
    await unlink(path.join(location, 'release', 'owner.json')); await rmdir(path.join(location, 'release'));
    await unlink(path.join(location, 'owner.json')); await rmdir(location);
    return true;
  }

  async release(requestId, lockId, checkoutDirectory = null) {
    if (!uuid(requestId) || !uuid(lockId)) fail('Release requires the original request ID and exact local lock ID.');
    const inventory = await this.inspect();
    const matching = inventory.locks.filter(lock => lock.requestId === requestId && lock.lockId === lockId);
    if (matching.some(lock => lock.processState !== 'stopped')) fail('The lock owner is running or cannot be confirmed stopped. No local lock was released.');
    let released = 0;
    if (checkoutDirectory) {
      const gitDirectory = path.join(await realpath(checkoutDirectory), '.git');
      await directoryIdentity(gitDirectory);
      if (await this.releaseDirectory(path.join(gitDirectory, 'projects-git-client.lock'), 'checkout', {requestId, lockId})) released++;
    }
    for (const resource of new Set(matching.map(lock => lock.resource)))
      if (await this.releaseDirectory(path.join(this.directory, resource), resource, {requestId, lockId})) released++;
    return {requestId, lockId, releasedLocalLocks: released, remoteOutcome: 'not-established',
      next: 'Local lock release does not settle any provider effect. Inspect current status and the original receipt before an explicit guarded retry. Earlier uncertain attempts remain retained.'};
  }
}
