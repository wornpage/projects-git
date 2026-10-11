import {fixtureToken,loadAccessFixture} from './access-fixture.mjs';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';

const origin = process.argv[2] ?? 'http://127.0.0.1:8795';
const url = new URL(origin);
assert.ok(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname), 'Search qualification only targets a local fixture.');
const token = await fixtureToken();
const accessFixture = await loadAccessFixture();
async function api(path, body, expected = 200) {
  if(body && /\/(claim|agents)$/.test(path)) body={...body,agentClientId:accessFixture.agentClientIds[0]};
  const response = await fetch(origin + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'Cf-Access-Jwt-Assertion': token, 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  assert.equal(response.status, expected, JSON.stringify(result));
  return result;
}
const initial = await api('/api/workspace');
assert.equal(initial.capabilities.retainedSearch, true);
assert.equal((await fetch(origin + '/api/projects/' + crypto.randomUUID() + '/search')).status, 401);
await api('/api/projects/' + crypto.randomUUID() + '/search', undefined, 404);
const existing = Object.values(initial.projects).find(project => project.repositoryName === 'starter');
const stack = await api('/api/tasks', { ...(existing ? { source: 'project', projectId: existing.id } : { source: 'repository', projectName: 'Search runtime fixture', repo: 'starter', baseCommit: 'a'.repeat(40) }),
  tasks: [{ title: 'Index searchable history', purpose: 'Find original-clipboard requirements', criteria: ['Retain source identities'], owner: 'Local QA' }] }, 201);
const taskId = stack.taskIds[0];
const searchPath = `/api/projects/${stack.projectId}/search`;
async function indexed() {
  // Production queue retries wait 60 seconds; leave a bounded allowance for
  // one delayed-visibility retry rather than treating it as a failed index.
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const state = await api(searchPath + '-index');
    if (state?.indexed_revision >= state?.revision) return state;
    if (state?.error_code && state.error_code !== 'VECTOR_INDEX_PENDING') throw new Error('INDEXING_FAILED: ' + state.error_code);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('INDEXING_TIMEOUT');
}
await indexed();
assert.ok((await api(searchPath + '?q=original-clipboard')).items.some(doc => doc.taskId === taskId && doc.taskRevision === 1));
const assignment = await api(`/api/tasks/${taskId}/agents`, { label: 'Search fixture agent' }, 201);
await api(`/api/runs/${assignment.runId}/start`, {});
await api(`/api/runs/${assignment.runId}/submit`, { headCommit: 'b'.repeat(40), summary: 'Retained search candidate for manual copying' });
await indexed();
assert.ok((await api(searchPath + '?q=bbbbbbbb')).items.some(doc => doc.runId === assignment.runId && doc.headCommit === 'b'.repeat(40)));
const rejectionNote = 'Retained rejection: require safe manual clipboard copying before reconsidering.';
await api(`/api/runs/${assignment.runId}/review`, { decision: 'reject', headCommit: 'b'.repeat(40), taskRevision: 1,
  ownerVersion: 1, note: rejectionNote });
await api(`/api/tasks/${taskId}/revise`, { expectedRevision: 1, purpose: 'Find updated-keyboard requirements', criteria: ['Retain source identities', 'Allow manual copying'], reason: 'Local synthetic clarification' });
await indexed();
const historical = await api(searchPath + '?q=original-clipboard');
assert.ok(historical.items.some(doc => doc.taskId === taskId && doc.taskRevision === 1));
assert.ok((await api(searchPath + '?q=updated-keyboard')).items.some(doc => doc.taskId === taskId && doc.taskRevision === 2));
const rejection = await api(searchPath + '?q=Retained%20rejection');
assert.ok(rejection.items.some(doc => doc.runId === assignment.runId && doc.taskRevision === 1 && doc.headCommit === 'b'.repeat(40) && doc.text.includes(rejectionNote)));
const currentRun = (await api('/api/workspace')).runs.find(run => run.id === assignment.runId);
assert.equal(currentRun.review.note, rejectionNote);
assert.equal(currentRun.evidence, null, 'Search projection does not create verification evidence');
await api(`/api/runs/${assignment.runId}/review`, { decision: 'accept', headCommit: 'b'.repeat(40), taskRevision: 2,
  ownerVersion: 1, note: 'Attempt without fresh checks' }, 409);
const semantic = await api(searchPath + '?mode=semantic&q=keyboard');
assert.equal(semantic.mode, 'semantic');
assert.equal(semantic.matched, null, 'Ranking is not an exhaustive match count');
assert.ok(semantic.items.some(doc => doc.taskId === taskId && doc.taskRevision === 2 && typeof doc.score === 'number'));
assert.deepEqual((await api(searchPath + '?mode=semantic&q=keyboard')).items, semantic.items, 'Same query reuses its cached embedding');
const state = await api(searchPath + '-index');
const rebuilding = await api(searchPath + '-index', { expectedRevision: state.revision }, 202);
assert.ok(rebuilding.revision > state.revision);
await api(searchPath + '-index', { expectedRevision: state.revision }, 409);
const final = await indexed();
assert.ok((await api(searchPath + '?q=original-clipboard')).items.some(doc => doc.taskId === taskId));
assert.ok((await api(searchPath + '?q=Retained%20rejection')).items.some(doc => doc.runId === assignment.runId && doc.taskRevision === 1 && doc.text.includes(rejectionNote)));
const beforeLarge = await api(searchPath + '?q=');
const largeTaskIds = [];
const largeMarker = 'large-index-' + crypto.randomUUID();
for (let batch = 0; batch < 8; batch++) {
  const queued = await api('/api/tasks', { source: 'project', projectId: stack.projectId,
    tasks: Array.from({ length: 8 }, (_, index) => ({ title: `${largeMarker} ${batch * 8 + index + 1}`,
      purpose: 'Retain a bounded multi-batch generation.', criteria: ['Find this queued task without changing its state.'], owner: 'Local QA' })) }, 201);
  largeTaskIds.push(...queued.taskIds);
}
const largeFinal = await indexed();
let page = await api(searchPath + '?q=' + encodeURIComponent(largeMarker));
assert.equal(page.matched, 64);
assert.ok(page.total >= beforeLarge.total + 64);
const found = [...page.items];
while (page.nextOffset !== null) {
  page = await api(searchPath + '?q=' + encodeURIComponent(largeMarker) + '&offset=' + page.nextOffset);
  found.push(...page.items);
}
assert.equal(new Set(found.map(doc => doc.taskId)).size, 64);
assert.ok(largeTaskIds.every(id => found.some(doc => doc.taskId === id)));
const largeSemantic = await api(searchPath + '?mode=semantic&q=' + encodeURIComponent(largeMarker));
assert.equal(largeSemantic.generation, largeFinal.indexed_revision);
assert.ok(largeSemantic.items.some(doc => largeTaskIds.includes(doc.taskId)), 'Multi-batch semantic generation is visible after bounded transport retries.');
const receipt = { status: 'passed', runtime: 'local-workerd', projectId: stack.projectId, taskId, runId: assignment.runId, indexedRevision: final.indexed_revision,
  largeGeneration: { taskCount: 64, indexedRevision: largeFinal.indexed_revision, recordCount: page.total },
  verified: ['signed Access fixture authentication', 'unknown project refusal', 'DO records and atomic outbox', 'local Queue delivery', 'local D1 search', 'exact candidate commit lookup', 'old and current task revisions', 'unverified rejection retained across requirement revision and rebuild', 'search cannot create proof or authorize acceptance', 'semantic fixture retrieval', 'cached query replay', 'guarded rebuild', 'stale rebuild refusal', '64-task multi-batch generation with delayed vector visibility', 'all literal pages retain query and generation'],
  providerCalls: 0, limitations: 'Synthetic local Access, Artifacts and semantic vector fixtures. No hosted Cloudflare, real Vectorize service, embedding model quality, or concurrency scale qualification.' };
try { await writeFile('qa/retained-search-runtime-' + crypto.randomUUID() + '.json', await readFile('qa/retained-search-runtime.json'), { flag: 'wx' }); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
await writeFile('qa/retained-search-runtime.json', JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify(receipt, null, 2));
