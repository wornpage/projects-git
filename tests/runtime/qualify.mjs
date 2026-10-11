import {fixtureToken,loadAccessFixture} from './access-fixture.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import { digest, requirementsDigest } from '../../src/core/check-definition.mjs';
import { VERIFIER_SHA256 } from '../../src/cloudflare/verifier-identity.ts';

const origin = process.argv[2] ?? 'http://127.0.0.1:8790';
const withoutContainers = process.argv.includes('--without-containers');
const url = new URL(origin);
assert.ok(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname), 'Runtime qualification only targets local fixtures.');
const token = await fixtureToken();
const accessFixture = await loadAccessFixture();
assert.equal((await fetch(origin + '/api/workspace')).status, 401);
const state = await (await fetch(origin + '/api/workspace', { headers: { 'Cf-Access-Jwt-Assertion': token } })).json();
assert.equal(state.provider, 'cloudflare-artifacts');
assert.equal(state.capabilities.model, false);
assert.equal(state.capabilities.providerVerified, false);
const api = async (path, body, key = crypto.randomUUID()) => {
  if(body && /\/(claim|agents)$/.test(path)) body={...body,agentClientId:accessFixture.agentClientIds[0]};
  const response = await fetch(origin + path, { method: body ? 'POST' : 'GET', headers: { 'Cf-Access-Jwt-Assertion': token, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: body ? JSON.stringify(body) : undefined });
  const result = await response.json();
  assert.ok(response.ok, JSON.stringify(result));
  return result;
};
const brief = { title: 'Validate checkout totals', purpose: 'Implement safe integer totals.', criteria: ['Pass the independent checkout contract.'], owner: 'Automated Worker QA' };
const project = Object.values(state.projects).find(item => item.repositoryName === 'starter');
const input = { ...(project ? { source: 'project', projectId: project.id } : { source: 'repository', projectName: 'Worker queue qualification', repo: 'starter', baseCommit: 'a'.repeat(40) }), tasks: [brief, { ...brief, title: 'Document the checkout contract' }] };
const key = crypto.randomUUID();
const stack = await api('/api/tasks', input, key);
assert.deepEqual((await api('/api/tasks', input, key)).taskIds, stack.taskIds);
const claims = await Promise.all(['A', 'B'].map(label => api(`/api/projects/${stack.projectId}/claim`, { label: 'Worker fixture ' + label })));
assert.equal(new Set(claims.map(item => item.taskId)).size, 2);
for (const item of claims) {
  assert.equal(item.credentialStatus, 'issued-once');
  const workspace = await api('/api/workspace');
  assert.ok(!JSON.stringify(workspace).includes(item.credentials.token));
  assert.equal(workspace.runs.find(run => run.id === item.runId).status, 'assigned');
  await api(`/api/runs/${item.runId}/start`, {});
}
const first = claims[0];
await api(`/api/runs/${first.runId}/submit`, { headCommit: 'b'.repeat(40), summary: 'Synthetic provider objects for runtime qualification' });
const task = (await api('/api/workspace')).tasks.find(task => task.id === first.taskId);
const definition = JSON.stringify({ format: 'repository-command-checks/v1', commit: 'b'.repeat(40), taskRevision: 1, requirementsSha256: requirementsDigest(task), timeoutMs: 60000,
  checks: [ { name: 'Node checkout result', argv: ['node', '--input-type=module', '-e', 'import {checkoutTotal} from "./checkout.mjs"; console.log(checkoutTotal([{unitCents:199,quantity:2}]))'], stdin: '', expected: { exitCode: 0, stdout: '398\n' } },
    { name: 'Python stdin result', argv: ['python3', 'sum.py'], stdin: '20 22\n', expected: { exitCode: 0, stdout: '42\n' } } ] });
const checkRequest = crypto.randomUUID();
const verified = await api(`/api/runs/${first.runId}/checks`, { definition, definitionSha256: digest(definition) }, checkRequest);
const report = verified.runs.find(run => run.id === first.runId).evidence;
assert.equal(report.passed, withoutContainers ? 0 : 2, JSON.stringify(report)); assert.equal(report.verified, !withoutContainers); assert.equal(report.total, 2);
if (!withoutContainers) { assert.match(report.verification.image, /^sha256:[a-f0-9]{64}$/); assert.equal(report.verification.verifierSha256, VERIFIER_SHA256); }
assert.deepEqual((await api(`/api/runs/${first.runId}/checks`, { definition, definitionSha256: digest(definition) }, checkRequest)).runs.find(run => run.id === first.runId).evidence, report);
await api(`/api/runs/${claims[1].runId}/fail`, { message: 'End the second fixture assignment before review' });
if (withoutContainers) {
  const refused = await fetch(origin + `/api/runs/${first.runId}/review`, { method: 'POST', headers: { 'Cf-Access-Jwt-Assertion': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'accept', headCommit: 'b'.repeat(40), taskRevision: 1, ownerVersion: 1, comparisons: [], note: 'Attempted review without a configured container' }) });
  assert.equal(refused.status, 409); assert.equal((await refused.json()).code, 'verification_required');
} else {
  const reviewerToken=await fixtureToken(accessFixture.reviewerClientIds[0]);
  const independent=async(path,body,key=crypto.randomUUID())=>{const response=await fetch(origin+path,{method:body?'POST':'GET',headers:{'Cf-Access-Jwt-Assertion':reviewerToken,'Content-Type':'application/json','Idempotency-Key':key},body:body?JSON.stringify(body):undefined});return {status:response.status,result:await response.json()};};
  const missing=await fetch(origin+`/api/runs/${first.runId}/review`,{method:'POST',headers:{'Cf-Access-Jwt-Assertion':token,'Content-Type':'application/json'},body:JSON.stringify({decision:'accept',headCommit:'b'.repeat(40),taskRevision:1,ownerVersion:1,comparisons:[],note:'Missing independent assessment'})});
  assert.equal(missing.status,409);assert.equal((await missing.json()).code,'independent_review_required');
  const ownerContext=await api(`/api/runs/${first.runId}/review-context`);
  const reviewVersion=(await api('/api/workspace')).version;
  await api(`/api/runs/${first.runId}/review-assignments`,{contextId:ownerContext.contextId,expectedVersion:reviewVersion,
    reviewerIds:[...accessFixture.reviewerClientIds,accessFixture.reviewerSubjects[0]]});
  const secondReviewer=await fixtureToken(accessFixture.reviewerClientIds[1]);
  const secondInbox=await fetch(origin+'/api/review-inbox',{headers:{'Cf-Access-Jwt-Assertion':secondReviewer}});
  assert.equal(secondInbox.status,200);assert.equal((await secondInbox.json()).items[0].assignmentScope,'team');
  const secondContext=await fetch(origin+`/api/runs/${first.runId}/review-context`,{headers:{'Cf-Access-Jwt-Assertion':secondReviewer}});
  assert.equal(secondContext.status,200);assert.equal((await secondContext.json()).context.runId,first.runId);
  const secondOwnerAction=await fetch(origin+`/api/runs/${first.runId}/review`,{method:'POST',
    headers:{'Cf-Access-Jwt-Assertion':secondReviewer,'Content-Type':'application/json'},body:'{}'});
  assert.equal(secondOwnerAction.status,403);
  const humanToken=await fixtureToken(undefined,{sub:accessFixture.reviewerSubjects[0],email:'reviewer@example.test'});
  const humanInbox=await fetch(origin+'/api/review-inbox',{headers:{'Cf-Access-Jwt-Assertion':humanToken}});
  assert.equal(humanInbox.status,200);const humanItems=(await humanInbox.json()).items;
  assert.equal(humanItems[0].runId,first.runId);assert.equal(humanItems[0].assignmentScope,'team');
  const context=await independent(`/api/runs/${first.runId}/review-context`);assert.equal(context.status,200);assert.equal(context.result.source.commit,'b'.repeat(40));
  for(const action of ['start','submit','checks','review','merge'])assert.equal((await independent(`/api/runs/${first.runId}/${action}`,{})).status,403);
  assert.equal((await independent(`/api/runs/${first.runId}/code-review`,{format:'projects-code-review-assessment/v2',contextId:context.result.contextId,verdict:'pass',summary:'Scripted reviewer fixture: inspected pinned fixture objects and two real container observations. This is permission-boundary proof, not model-quality proof.',findings:[],resolvedPriorFindingIds:[]})).status,200);
  const accepted = await api(`/api/runs/${first.runId}/review`, { decision: 'accept', headCommit: 'b'.repeat(40), taskRevision: 1, ownerVersion: 1, comparisons: [], note: 'Local runtime contract proof; synthetic Git objects. No live provider qualification.' });
  assert.equal(accepted.runs.find(run => run.id === first.runId).status, 'accepted');
}
const current = await api('/api/workspace');
const activeExport=await fetch(origin+`/api/projects/${stack.projectId}/export`,{headers:{'Cf-Access-Jwt-Assertion':token}});
assert.equal(activeExport.status,409);assert.equal((await activeExport.json()).code,'project_not_paused');
await api(`/api/projects/${stack.projectId}/policy`, {acceptingWork:false,expectedVersion:current.projects[stack.projectId].policyVersion});
const archive = await api(`/api/projects/${stack.projectId}/export`);
assert.equal(archive.payload.current.length,2);assert.equal(archive.payload.checkPolicies.length,1);
const restoreBody = {archive,expectedSha256:archive.sha256,projectName:'Restored project fixture',repo:'browser-starter'};
const beforeInvalid=(await api('/api/workspace')).version,damaged=structuredClone(archive);damaged.payload.project.name='Corrupt archive fixture';
const invalidRestore=await fetch(origin+'/api/projects/restore',{method:'POST',headers:{'Cf-Access-Jwt-Assertion':token,'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({...restoreBody,archive:damaged})});
assert.equal(invalidRestore.status,422);assert.equal((await invalidRestore.json()).code,'invalid_project_archive');
assert.equal((await api('/api/workspace')).version,beforeInvalid);
const restoreKey=crypto.randomUUID(),restored=await api('/api/projects/restore',restoreBody,restoreKey);
assert.equal((await api('/api/projects/restore',restoreBody,restoreKey)).projectId,restored.projectId);
const restoredProject=restored.workspace.projects[restored.projectId];assert.equal(restoredProject.acceptingWork,false);
assert.equal(restoredProject.restoredHistory.length,2);
assert.equal(restored.workspace.tasks.filter(task=>task.projectId===restored.projectId).length,0);
const history=await api(`/api/projects/${restored.projectId}/history`);assert.equal(history.historical,true);
assert.deepEqual(history.tasks,archive.payload.current);assert.deepEqual(history.checkPolicies,archive.payload.checkPolicies);
const reexport=await api(`/api/projects/${restored.projectId}/export`);
assert.deepEqual(reexport.payload.history,archive.payload.current);assert.equal(reexport.payload.current.length,0);
console.log('PASS project export, invalid archive HTTP errors, SQLite restore, historical attribution and idempotent replay (synthetic Artifacts)');
const directory = await mkdtemp(join(tmpdir(), 'projects-worker-checks-'));
try {
  execFileSync(process.execPath, ['src/local/scripted-agent.mjs', 'careful', directory]);
  const source = await readFile(join(directory, 'checkout.mjs'), 'utf8');
  const verify = async candidate => {
    const response = await fetch(origin + '/verify-fixture', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Cf-Access-Jwt-Assertion': token }, body: JSON.stringify({ source: candidate }) });
    assert.equal(response.status, 200);
    return response.json();
  };
  const valid = await verify(source);
  assert.equal(valid.passed, 16); assert.equal(valid.total, 16);
  const forged = await verify('export function checkoutTotal(){return {passed:16,total:16,verified:true};}');
  assert.equal(forged.passed, 0); assert.equal(forged.total, 16);
  const denied = await verify(`let denied=false;try{await fetch("https://example.com")}catch{denied=true}if(!denied)throw Error("Outbound network was allowed");\n${source}`);
  assert.equal(denied.passed, 16);
  console.log(JSON.stringify({ status: 'passed', runtime: 'local-workerd', containerIntegrationVerified: !withoutContainers, providerCalls: 0, projectId: stack.projectId, taskIds: stack.taskIds, runIds: claims.map(item => item.runId), checks: ['SQLite project and task stack', 'authentication', 'idempotent creation', 'concurrent claims', 'credential exclusion', 'reported start', 'submission', withoutContainers ? 'unavailable containers fail closed at 0/2; acceptance refused' : 'Node and Python command checks 2/2; separate review', 'verification replay without execution', 'assignment closure', 'checkout profile 16/16', 'forged report 0/16', 'outbound networking denied'], limitations: 'Synthetic Artifacts objects and inert Git credentials; no live Artifacts, hosted account, remote Git push, alarm execution or model provider qualification.' + (withoutContainers ? ' Workerd-to-container execution is unverified.' : '') }, null, 2));
} finally {
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
  await rm(directory, { recursive: true, force: true });
}
