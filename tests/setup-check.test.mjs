import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {inspectSetup, setupArguments} from '../scripts/setup-check.mjs';

const source = fileURLToPath(new URL('../', import.meta.url));
const template = JSON.parse(await readFile(join(source, 'wrangler.jsonc'), 'utf8'));
const builder = '1'.repeat(32) + '.access', reviewer = '2'.repeat(32) + '.access';
const byId = (report, id) => report.checks.find(check => check.id === id);

async function fixture(t) {
  const parent = await realpath(tmpdir()), prefix = 'projects-git-offline-setup-';
  const base = await mkdtemp(join(parent, prefix)), root = join(base, 'source');
  t.after(async () => {
    const actual = await realpath(base);
    assert.equal(dirname(actual), parent);
    assert.ok(relative(parent, actual).startsWith(prefix));
    await rm(actual, {recursive: true, force: true});
  });
  const put = async (name, content) => {
    const file = resolve(root, name); await mkdir(dirname(file), {recursive: true});
    await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content)); return file;
  };
  const manifest = {name: 'offline-fixture', engines: {node: '>=24.19.0'}, dependencies: {'fixture-package': '1.0.0'}};
  const lock = {packages: {'': {name: manifest.name}, 'node_modules/fixture-package': {version: '1.0.0'}}};
  await put('package.json', manifest); await put('package-lock.json', lock);
  await put('node_modules/fixture-package/package.json', {name: 'fixture-package', version: '1.0.0'});
  for (const name of ['src/cloudflare/index.ts', 'containers/verification/Dockerfile']) await put(name, 'fixture path, never executed');
  for (const name of ['public', 'migrations/search']) await mkdir(join(root, name), {recursive: true});
  const config = structuredClone(template);
  config.account_id = 'a'.repeat(32); config.name = 'operator-workspace';
  Object.assign(config.vars, {WORKSPACE_ID: 'operator-space', ACCESS_TEAM_DOMAIN: 'https://operator.cloudflareaccess.com',
    ACCESS_AUD: 'b'.repeat(64), ACCESS_OWNER_SUB: 'verified-owner',
    ACCESS_AGENT_CLIENT_IDS: JSON.stringify([builder]), ACCESS_REVIEWER_CLIENT_IDS: JSON.stringify([reviewer])});
  config.services.find(item => item.binding === 'CURRENT_POLICY').service = config.name;
  config.d1_databases[0].database_id = '11111111-2222-3333-4444-555555555555';
  const calls = [], responses = {tracked: 1, ignored: 0, docker: 'linux'};
  const run = async (command, args) => {
    calls.push([command, ...args]);
    if (command === 'git' && args[0] === '--version') return {code: 0, stdout: 'git version 2.50.0'};
    if (command === 'git' && args[0] === 'ls-files') return {code: responses.tracked, stdout: ''};
    if (command === 'git' && args[0] === 'check-ignore') return {code: responses.ignored, stdout: ''};
    if (command === 'docker' && args.join(' ') === 'info --format {{.OSType}}') return {code: 0, stdout: responses.docker};
    assert.fail('An unexpected subprocess was requested.');
  };
  const inspect = options => inspectSetup({root, run, nodeVersion: '24.19.0', ...options});
  const hosted = async (value = config) => {await put('wrangler.operator.jsonc', value); return inspect({configPath: 'wrangler.operator.jsonc'});};
  return {root, base, put, manifest, lock, config, calls, responses, run, inspect, hosted};
}

test('local prerequisites are read-only metadata checks, with no Docker or provider requests', async t => {
  const f = await fixture(t), before = await readFile(join(f.root, 'package-lock.json'));
  const report = await f.inspect();
  assert.equal(report.status, 'passed'); assert.equal(report.profile, 'local');
  assert.deepEqual(report.summary, {passed: 4, blocked: 0, notChecked: 0, total: 4});
  assert.deepEqual(report.requested, {docker: false, hostedConfig: false});
  assert.equal(report.providerRequests, 0); assert.equal(report.hostedAcceptance, false); assert.equal(report.applicationStarted, false);
  assert.match(byId(report, 'dependencies').detail, /transitive files and executable behavior are not checked/);
  assert.deepEqual(f.calls, [['git', '--version']]);
  assert.deepEqual(await readFile(join(f.root, 'package-lock.json')), before);
});

test('missing or mismatched direct dependencies and an incomplete source tree block setup', async t => {
  const f = await fixture(t);
  await f.put('node_modules/fixture-package/package.json', {name: 'fixture-package', version: '2.0.0'});
  assert.equal(byId(await f.inspect(), 'dependencies').status, 'blocked');
  await rm(join(f.root, 'node_modules/fixture-package/package.json'));
  assert.equal(byId(await f.inspect(), 'dependencies').status, 'blocked');
  await f.put('package-lock.json', '{}');
  const report = await f.inspect();
  assert.equal(report.summary.total, 4); assert.equal(byId(report, 'source').status, 'blocked');
});

test('the declared stable Node minimum accepts newer majors and rejects old or prerelease versions', async t => {
  const f = await fixture(t);
  for (const nodeVersion of ['24.19.0', '24.20.0', '25.0.0']) assert.equal(byId(await f.inspect({nodeVersion}), 'node').status, 'passed');
  for (const nodeVersion of ['24.18.9', '23.99.99', '24.19.0-rc.1']) assert.equal(byId(await f.inspect({nodeVersion}), 'node').status, 'blocked');
});

test('unavailable Git and subprocess diagnostics cannot leak credentials in the report', async t => {
  const f = await fixture(t), secret = 'private-subprocess-credential';
  const report = await f.inspect({run: async () => {throw Error(secret);}});
  assert.equal(byId(report, 'git').status, 'blocked');
  assert.ok(!JSON.stringify(report).includes(secret));
});

test('Docker is opt-in and a responding Linux engine is not a verification result', async t => {
  const f = await fixture(t), report = await f.inspect({docker: true});
  assert.equal(report.summary.total, 5); assert.equal(byId(report, 'docker').status, 'passed');
  assert.equal(f.calls.filter(call => call[0] === 'docker').length, 1);
  assert.equal(report.hostedAcceptance, false);
  f.responses.docker = 'windows';
  assert.equal(byId(await f.inspect({docker: true}), 'docker').status, 'blocked');
});

test('an independent literal config passes offline checks without fetching or printing its values', async t => {
  const f = await fixture(t), fetchBefore = globalThis.fetch;
  globalThis.fetch = () => {assert.fail('Offline setup attempted a network request.');};
  t.after(() => {globalThis.fetch = fetchBefore;});
  const contents = '// Operator-owned JSONC\n' + JSON.stringify(f.config, null, 2);
  const file = await f.put('wrangler.operator.jsonc', contents);
  const report = await f.inspect({configPath: file});
  assert.equal(report.status, 'passed'); assert.equal(report.profile, 'hosted-config');
  assert.deepEqual(report.summary, {passed: 15, blocked: 0, notChecked: 0, total: 15});
  assert.equal(report.providerRequests, 0); assert.equal(report.hostedAcceptance, false);
  assert.equal(await readFile(file, 'utf8'), contents);
  for (const value of [f.config.account_id, f.config.vars.ACCESS_OWNER_SUB, builder, reviewer]) assert.ok(!JSON.stringify(report).includes(value));
});

test('the safe source template is incomplete, rather than claiming an independent hosted install', async t => {
  const f = await fixture(t), report = await f.hosted(template);
  assert.equal(report.status, 'blocked'); assert.equal(report.summary.total, 15);
  for (const id of ['target', 'access-policy', 'resources']) assert.equal(byId(report, id).status, 'blocked');
  assert.equal(byId(report, 'agent-identities').status, 'not_checked');
});

test('unparseable and unsupported configs retain every requested check in the denominator', async t => {
  const f = await fixture(t);
  for (const contents of ['{invalid json', JSON.stringify({...f.config, env: {production: {}}}), '[]']) {
    const report = await f.hosted(contents);
    assert.equal(byId(report, 'config').status, 'blocked');
    assert.deepEqual(report.summary, {passed: 5, blocked: 1, notChecked: 9, total: 15});
  }
});

test('tracked, unignored and indeterminate in-checkout configs fail the privacy check', async t => {
  const f = await fixture(t);
  for (const response of [{tracked: 0, ignored: 0}, {tracked: 1, ignored: 1}, {tracked: 128, ignored: 0}]) {
    Object.assign(f.responses, response);
    assert.equal(byId(await f.hosted(), 'private-config').status, 'blocked');
  }
});

test('external config paths must still resolve into this checkout', async t => {
  const f = await fixture(t), config = structuredClone(f.config), file = join(f.base, 'external.jsonc');
  config.main = join(f.root, config.main); config.assets.directory = join(f.root, config.assets.directory);
  config.containers[0].images.verifier.dockerfile = join(f.root, config.containers[0].images.verifier.dockerfile);
  config.d1_databases[0].migrations_dir = join(f.root, config.d1_databases[0].migrations_dir);
  await writeFile(file, JSON.stringify(config));
  assert.equal((await f.inspect({configPath: file})).status, 'passed');
  assert.deepEqual(f.calls, [['git', '--version']]);
  config.main = file; await writeFile(file, JSON.stringify(config));
  assert.equal(byId(await f.inspect({configPath: file}), 'source-paths').status, 'blocked');
});

test('wrong policy target, open endpoints and missing bindings cannot pass the config profile', async t => {
  const f = await fixture(t);
  for (const [id, mutate] of [
    ['current-policy', c => {c.services.find(s => s.binding === 'CURRENT_POLICY').service = 'another-worker';}],
    ['private-ingress', c => {c.workers_dev = true;}],
    ['private-ingress', c => {c.preview_urls = true;}],
    ['private-ingress', c => {c.assets.run_worker_first = false;}],
    ['bindings', c => {c.worker_loaders = [];}],
    ['resources', c => {c.d1_databases[0].database_id = '';}]
  ]) {
    const config = structuredClone(f.config); mutate(config);
    assert.equal(byId(await f.hosted(config), id).status, 'blocked', id);
  }
});

test('the application validator rejects overlapping and owner-reviewer identities; builders and reviewers are required', async t => {
  const f = await fixture(t);
  for (const vars of [
    {ACCESS_REVIEWER_CLIENT_IDS: JSON.stringify([builder])},
    {ACCESS_REVIEWER_SUBJECTS: JSON.stringify([f.config.vars.ACCESS_OWNER_SUB])},
    {ACCESS_AGENT_CLIENT_IDS: '["malformed"]'}
  ]) {
    const config = structuredClone(f.config); Object.assign(config.vars, vars);
    const report = await f.hosted(config);
    assert.equal(byId(report, 'access-policy').status, 'blocked');
    assert.equal(byId(report, 'agent-identities').status, 'not_checked');
  }
  for (const vars of [{ACCESS_AGENT_CLIENT_IDS: '[]'}, {ACCESS_REVIEWER_CLIENT_IDS: '[]'}]) {
    const config = structuredClone(f.config); Object.assign(config.vars, vars);
    assert.equal(byId(await f.hosted(config), 'agent-identities').status, 'blocked');
  }
  f.config.vars.ACCESS_REVIEWER_CLIENT_IDS = '[]'; f.config.vars.ACCESS_REVIEWER_SUBJECTS = '["independent-human"]';
  assert.equal((await f.hosted()).status, 'passed');
});

test('known plaintext secrets and invalid config values are blocked without disclosure', async t => {
  const f = await fixture(t), secret = 'never-emit-private-config-value';
  f.config.vars.MODEL_API_KEY = secret; f.config.vars.ACCESS_AUD = secret;
  const report = await f.hosted();
  assert.equal(byId(report, 'secrets').status, 'blocked'); assert.equal(byId(report, 'access-policy').status, 'blocked');
  assert.ok(!JSON.stringify(report).includes(secret));
});

test('CLI options reject ambiguous flags and help remains read-only', () => {
  assert.deepEqual(setupArguments(['--config', 'operator.jsonc', '--json', '--docker']), {configPath: 'operator.jsonc', json: true, docker: true});
  for (const args of [['--config'], ['--config', '--json'], ['--json', '--json'], ['--config', 'a', '--config', 'b'], ['--unknown']]) assert.throws(() => setupArguments(args));
  const cli = resolve(source, 'scripts/setup-check.mjs');
  const help = spawnSync(process.execPath, [cli, '--help'], {cwd: tmpdir(), encoding: 'utf8', windowsHide: true});
  assert.equal(help.status, 0); assert.match(help.stdout, /A pass is not hosted acceptance/);
  const invalid = spawnSync(process.execPath, [cli, '--private-token=must-not-be-echoed'], {cwd: tmpdir(), encoding: 'utf8', windowsHide: true});
  assert.equal(invalid.status, 2); assert.ok(!(invalid.stdout + invalid.stderr).includes('must-not-be-echoed'));
  const tracked = spawnSync(process.execPath, [cli, '--config', 'wrangler.jsonc', '--json'], {cwd: tmpdir(), encoding: 'utf8', windowsHide: true});
  assert.equal(tracked.status, 1, tracked.stderr);
  const report = JSON.parse(tracked.stdout);
  assert.equal(byId(report, 'private-config').status, 'blocked'); assert.equal(report.summary.total, 15);
});
