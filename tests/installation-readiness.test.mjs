import test from 'node:test';
import assert from 'node:assert/strict';
import {SETUP_CHECKS, installationReadiness, readSetupReport} from '../public/installation-readiness.js';
import {canInspectInstallation, createInstallationPanel} from '../public/ui/installation.js';
import {installFakeDOM} from './helpers/fake-dom.mjs';

function report({hosted = true, docker = false, blocked = []} = {}) {
  const checks = Object.entries(SETUP_CHECKS).filter(([id, check]) =>
    (id !== 'docker' || docker) && (hosted || check.stage === 'prerequisites')).map(([id]) => ({id, status: blocked.includes(id) ? 'blocked' : 'passed'}));
  return {schemaVersion: 2, generatedAt: '2026-10-16T23:00:00.000Z', scope: 'offline-setup-prerequisites',
    profile: hosted ? 'hosted-config' : 'local', requested: {docker, hostedConfig: hosted},
    status: blocked.length ? 'blocked' : 'passed',
    summary: {passed: checks.length - blocked.length, blocked: blocked.length, notChecked: 0, total: checks.length},
    providerRequests: 0, hostedAcceptance: false, applicationStarted: false, checks};
}
const file = value => new File([typeof value === 'string' ? value : JSON.stringify(value)], 'setup-report.json', {type: 'application/json'});
function panel() {
  installFakeDOM();
  const context = {workspace: {id: 'workspace-one', authentication: {principal: 'owner-one', permissions: {manage: true}}}, demo: false};
  const getContext = () => context;
  const captureSession = () => { const key = JSON.stringify(context); return () => JSON.stringify(context) === key; };
  const root = createInstallationPanel({getContext, captureSession});
  const choose = async supplied => { const input = root.querySelector('#installation-report'); input.files = [supplied]; await input.dispatch('change'); };
  const button = (node = root) => node.tagName === 'BUTTON' ? node : node.children?.map(child => button(child)).find(Boolean);
  return {root, context, choose, clear: () => button().dispatch('click')};
}

test('readiness starts without local passes or hosted verification', () => {
  const result = installationReadiness();
  assert.equal(result.report, null); assert.equal(result.hostedInstallationVerified, false);
  assert.equal(result.stages.length, 5);
  assert.deepEqual(result.stages.map(s => s.status), ['not_checked', 'not_checked', 'not_verified', 'not_verified', 'not_verified']);
  assert.deepEqual(result.stages[1].summary, {passed: 0, blocked: 0, notChecked: 12, total: 12});
});

test('16 passing offline checks never establish resources, deployment or private verification', () => {
  const result = installationReadiness(report());
  assert.equal(result.report.summary.total, 16);
  assert.deepEqual(result.stages.slice(0, 2).map(s => s.status), ['checked_locally', 'checked_locally']);
  assert.ok(result.stages.slice(2).every(s => s.status === 'not_verified'));
  assert.equal(result.hostedInstallationVerified, false);
});

test('local-only and opt-in Docker reports retain their distinct denominators', () => {
  const local = installationReadiness(report({hosted: false}));
  assert.equal(local.report.summary.total, 4); assert.equal(local.stages[1].requested, false);
  assert.equal(local.stages[1].summary.total, 12); assert.equal(local.stages[1].status, 'not_checked');
  const docker = installationReadiness(report({docker: true}));
  assert.equal(docker.report.summary.total, 17); assert.equal(docker.stages[0].summary.total, 5);
  assert.equal(docker.stages[1].summary.total, 12);
});

test('blocked event configuration remains a blocker with the complete count', () => {
  const result = installationReadiness(report({blocked: ['event-policy']}));
  assert.equal(result.stages[1].status, 'blocked');
  assert.deepEqual(result.stages[1].summary, {passed: 11, blocked: 1, notChecked: 0, total: 12});
});

test('malformed, partial, duplicate, contradictory and provider-bearing reports are refused', () => {
  const changes = [r => {r.summary.passed++;}, r => {r.checks.pop();}, r => {r.checks[1].id = r.checks[0].id;},
    r => {r.checks[0].status = 'verified';}, r => {r.profile = 'local';}, r => {r.requested.docker = true;},
    r => {r.requested.hostedConfig = false;}, r => {r.providerRequests = 1;}, r => {r.hostedAcceptance = true;},
    r => {r.applicationStarted = true;}, r => {r.status = 'blocked';}, r => {r.checks[0].id = 'unknown';},
    r => {r.schemaVersion = 1;}, r => {r.generatedAt = 'private-value';}, r => {r.generatedAt = '2026-02-31T23:00:00.000Z';}];
  for (const change of changes) { const supplied = report(); change(supplied); assert.throws(() => readSetupReport(supplied), /complete JSON report/); }
  for (const supplied of [null, [], {}, 'report', {...report(), checks: [null]}]) assert.throws(() => readSetupReport(supplied));
});

test('imported labels, secrets and claimed hosted passes cannot cross the projection', () => {
  const supplied = report(); supplied.checks[0].label = 'SECRET_FILE_CONTENT'; supplied.checks[0].action = 'SECRET_FILE_CONTENT';
  supplied.checks[0].detail = 'SECRET_FILE_CONTENT'; supplied.account = 'SECRET_FILE_CONTENT';
  supplied.installation = {hostedInstallationVerified: true, stages: [{status: 'verified'}]};
  assert.ok(!JSON.stringify(installationReadiness(supplied)).includes('SECRET_FILE_CONTENT'));
  assert.equal(installationReadiness(supplied).hostedInstallationVerified, false);
  delete supplied.generatedAt;
  assert.throws(() => readSetupReport(supplied), /complete JSON report/, 'Missing report time is never fabricated.');
});

test('installation controls are restricted to owner or trusted local mode and excluded from examples', () => {
  assert.equal(canInspectInstallation({workspace: {}}), true);
  assert.equal(canInspectInstallation({workspace: null}), false);
  assert.equal(canInspectInstallation({workspace: {}, demo: true}), false);
  assert.equal(canInspectInstallation({workspace: {personalWorkspace: {}}}), false);
  for (const permissions of [{manage: false}, {}, null]) assert.equal(canInspectInstallation({workspace: {authentication: {permissions}}}), false);
  installFakeDOM();
  const root = createInstallationPanel({getContext: () => ({workspace: {authentication: {permissions: {manage: false}}}}), captureSession() { assert.fail('No session access needed.'); }});
  assert.equal(root.querySelector('#installation-report'), null);
});

test('owner can inspect and clear a report without a network or storage call', async t => {
  const previous = globalThis.fetch;
  globalThis.fetch = () => assert.fail('The report viewer must not make a network request.');
  t.after(() => {globalThis.fetch = previous;});
  for (const key of ['localStorage', 'sessionStorage']) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, {configurable: true, get() {assert.fail('The report viewer must not access browser storage.');}});
    t.after(() => { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; });
  }
  const p = panel(), supplied = report(); supplied.checks[0].detail = 'SECRET_FILE_CONTENT';
  await p.choose(file(supplied));
  assert.match(p.root.textContent, /16\/16 checks passed/);
  assert.match(p.root.textContent, /Hosted installation is not verified/);
  assert.match(p.root.textContent, /not independently authenticated or matched to this workspace/);
  assert.doesNotMatch(p.root.textContent, /SECRET_FILE_CONTENT/);
  await p.clear(); assert.match(p.root.textContent, /No local report loaded/);
  assert.doesNotMatch(p.root.textContent, /16\/16 checks passed/);
});

test('invalid, oversized and invalid-UTF8 files clear earlier results without leaking their contents', async () => {
  const p = panel();
  for (const supplied of [file('SECRET_BAD_JSON'), file(' '.repeat(65537)), new File([new Uint8Array([0xff, 0xff])], 'bad.json')]) {
    await p.choose(file(report())); await p.choose(supplied);
    assert.match(p.root.textContent, /Could not read this report/);
    assert.doesNotMatch(p.root.textContent, /16\/16 checks passed|SECRET_BAD_JSON/);
  }
});

test('a newer file selection and Clear report win over an older pending read', async () => {
  const p = panel(); let finish;
  const slow = {size: 10, slice: () => ({arrayBuffer: () => new Promise(resolve => {finish = resolve;})})};
  const pending = p.choose(slow);
  await p.choose(file(report({blocked: ['resources']})));
  finish(new TextEncoder().encode(JSON.stringify(report())).buffer); await pending;
  assert.match(p.root.textContent, /15\/16 checks passed/);
  const cancelled = p.choose(slow); await p.clear();
  finish(new TextEncoder().encode(JSON.stringify(report())).buffer); await cancelled;
  assert.match(p.root.textContent, /No local report loaded/);
});

test('session changes, lost ownership and detached panels reject late file results', async () => {
  for (const change of [p => {p.context.workspace.authentication.principal = 'owner-two';},
    p => {p.context.workspace.authentication.permissions.manage = false;}, p => {p.root.isConnected = false;}]) {
    const p = panel(); let finish;
    const pending = p.choose({size: 10, slice: () => ({arrayBuffer: () => new Promise(resolve => {finish = resolve;})})});
    change(p); finish(new TextEncoder().encode(JSON.stringify(report())).buffer); await pending;
    assert.doesNotMatch(p.root.textContent, /16\/16 checks passed/);
  }
});
