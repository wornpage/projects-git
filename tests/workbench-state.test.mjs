import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspace, createTask, assignRun, startRun, completeRun, failRun, verifyRun, reviewRun, mergeRun, reviseTask, coordination } from '../src/core/workflow.mjs';
import { setProjectPolicy } from '../src/core/project-work.mjs';
import { candidateOutcome, taskOutcome, taskBriefing, reviewTaskCount, projectContext, reviewContext, readLocation, locationSearch } from '../public/workbench-state.js';

function fixture() {
  const state = createWorkspace();
  const task = createTask(state, { title: 'Checkout', purpose: 'Safe totals', criteria: ['Reject invalid quantities'], baseCommit: 'a'.repeat(40), owner: 'QA' });
  const runs = ['Delta', 'Echo'].map(label => assignRun(state, task.id, { agent: label, label, branch: `agent/${label}` }));
  for (const [index, run] of runs.entries()) {
    startRun(state, run.id);
    completeRun(state, run.id, { headCommit: (index ? 'c' : 'b').repeat(40), changedFiles: ['checkout.mjs'], diff: '+checked change', summary: 'Candidate' });
    verifyRun(state, run.id, { source: 'independent-local-checks', verified: true, commit: run.headCommit, taskRevision: 1,
      passed: index ? 0 : 1, total: 1, checks: [{ name: 'Quantities', passed: !index, detail: 'Checked' }], exitCode: index ? 1 : 0, command: 'test', output: 'Recorded', verifiedAt: new Date().toISOString() });
  }
  state.coordination = Object.fromEntries(runs.map(run => [run.id, coordination(state, run.id)]));
  return { state, task, runs };
}
const review = (state, run, task) => ({ decision: 'accept', reviewer: 'QA', note: 'Inspected the changes', headCommit: run.headCommit,
  taskRevision: task.revision, ownerVersion: task.ownerVersion, comparisons: coordination(state, run.id).overlaps.map(({ runId, headCommit }) => ({ runId, headCommit })) });

for (const status of ['assigned', 'running', 'failed']) test(`one committed result does not request comparison with an uncommitted ${status} attempt`, () => {
  const {state, task, runs: [delta]} = fixture();
  state.runs = [delta];
  const pending = assignRun(state, task.id, {agent:'external', label:'Uncommitted attempt', branch:'agent/pending'});
  if (status === 'running') startRun(state, pending.id);
  if (status === 'failed') failRun(state, pending.id, 'Checkout preparation failed');
  const retained = structuredClone(state);
  assert.equal(candidateOutcome(state, delta).next, 'Inspect the changes and record your decision.');
  assert.deepEqual(state, retained, 'Guidance preserves attempts, errors and reports');
  assert.equal(state.runs.length, 2);
  assert.equal(coordination(state, delta.id).acceptance.find(rule => rule.code === 'work_in_progress').met, status === 'failed', 'Uncommitted active work still blocks acceptance');
});

test('committed alternatives still request comparison, including a failing check report', () => {
  const {state, runs: [delta, echo]} = fixture();
  const retained = structuredClone(state);
  assert.equal(candidateOutcome(state, delta).next, 'Compare the candidates and record your decision.');
  assert.equal(echo.evidence.passed, 0);
  assert.deepEqual(state, retained);
  echo.status = 'superseded';
  assert.equal(candidateOutcome(state, delta).next, 'Inspect the changes and record your decision.');
  echo.status = 'awaiting_review'; echo.taskId = 'different-task';
  assert.equal(candidateOutcome(state, delta).next, 'Inspect the changes and record your decision.');
});

test('chosen and merged tasks retain alternatives without leaving a pending review badge', () => {
  const { state, task, runs: [delta, echo] } = fixture();
  assert.equal(reviewTaskCount(state), 1, 'The badge counts tasks, not candidates');
  assert.equal(candidateOutcome(state, echo).label, 'Checks failed');
  assert.equal(taskOutcome(state, task).runId, delta.id);
  reviewRun(state, delta.id, review(state, delta, task));
  assert.equal(candidateOutcome(state, echo).label, 'Retained alternative');
  assert.equal(taskOutcome(state, task).action, 'Continue to merge');
  assert.equal(reviewTaskCount(state), 1);
  mergeRun(state, delta.id, { headCommit: delta.headCommit, baseCommit: task.baseCommit, mergedCommit: delta.headCommit });
  assert.equal(reviewTaskCount(state), 0);
  assert.equal(taskOutcome(state, task).view, 'evidence');
  assert.equal(state.runs.length, 2);
  assert.equal(echo.evidence.passed, 0, 'The failed report remains in the record');
});

test('snapshot prerequisites match enforced acceptance rules and report simultaneous blockers', () => {
  const { state, task, runs: [delta, echo] } = fixture();
  assert.ok(coordination(state, delta.id).acceptance.every(rule => rule.met));
  assert.equal(coordination(state, echo.id).acceptance.find(rule => rule.code === 'checks_failed').met, false);
  assert.throws(() => reviewRun(state, echo.id, review(state, echo, task)), { code: 'checks_failed' });
  reviseTask(state, task.id, { expectedRevision: 1, purpose: task.purpose, criteria: ['Reject invalid quantities', 'Preserve API'], reason: 'Updated requirements' });
  assert.equal(candidateOutcome(state, echo).label, 'Recheck needed');
  const missing = coordination(state, echo.id).acceptance.filter(rule => !rule.met).map(rule => rule.code);
  assert.deepEqual(missing, ['stale_evidence', 'checks_failed']);
  assert.throws(() => reviewRun(state, echo.id, review(state, echo, task)), { code: 'stale_evidence' });
});

test('review draft context changes with requirements, owner, evidence, and compared heads', () => {
  const { state, task, runs: [delta, echo] } = fixture();
  const original = reviewContext(state, delta);
  state.version += 1;
  assert.equal(reviewContext(state, delta), original, 'Unrelated updates preserve the draft');
  for (const [object, field, value] of [[task, 'revision', 2], [task, 'ownerVersion', 2], [delta.evidence, 'verifiedAt', '2026-10-04T12:00:00Z'], [state.coordination[delta.id].overlaps[0], 'headCommit', 'd'.repeat(40)]]) {
    const old = object[field]; object[field] = value;
    assert.notEqual(reviewContext(state, delta), original, `${field} invalidates the draft context`);
    object[field] = old;
  }
  assert.notEqual(reviewContext(state, echo), original);
});

test('navigation URLs round trip task and candidate and refuse unknown views', () => {
  const search = locationSearch('review', 'task-a', 'candidate-b');
  assert.deepEqual(readLocation(search), { view: 'review', projectId:null, taskId: 'task-a', runId: 'candidate-b' });
  assert.equal(readLocation('?view=unknown').view, 'projects');
  assert.deepEqual(readLocation(''),{view:'projects',projectId:null,taskId:null,runId:null});
  assert.equal(locationSearch('projects','task-a','candidate-b'),'?view=projects');
});

test('task actions distinguish missing, failed, running, stale and current checks', () => {
  const { state, task, runs: [delta, echo] } = fixture();
  task.origin = 'connected-git';
  assert.equal(taskOutcome(state, task).action, 'Review changes', 'A current passing candidate is selected ahead of a failed alternative');
  state.runs = [echo];
  assert.equal(taskOutcome(state, task).action, 'Inspect failures');
  assert.equal(taskOutcome(state, task).label, 'Checks failed');
  echo.verificationPending = true;
  assert.equal(taskOutcome(state, task).action, 'Follow checks');
  echo.verificationPending = false;
  reviseTask(state, task.id, { expectedRevision: 1, purpose: task.purpose, criteria: [...task.criteria, 'Preserve API'], reason: 'Clarified scope' });
  assert.equal(taskOutcome(state, task).action, 'Update checks');
  assert.equal(taskOutcome(state, task).label, 'Recheck needed');
  echo.evidence = null;
  assert.equal(taskOutcome(state, task).action, 'Configure checks');
  echo.checksConfigured = true;
  assert.equal(taskOutcome(state, task).action, 'Run checks');
  assert.equal(delta.evidence.passed, 1, 'Presentation changes do not mutate retained proof');
});

test('paused queues and active work identify the action that can actually be taken', () => {
  const { state, task, runs: [delta] } = fixture();
  task.origin = 'connected-git'; task.projectId = 'project';
  state.projects = { project: { mainCommit: 'd'.repeat(40), acceptingWork: false } };
  const retained = state.runs;
  state.runs = [];
  assert.equal(taskOutcome(state, task).label, 'Queued · admission paused');
  state.projects.project.acceptingWork = true;
  assert.equal(taskOutcome(state, task).label, 'Queued');
  state.runs = retained;
  state.runs.push({ id: 'running-agent', taskId: task.id, status: 'running', origin: 'external-agent', headCommit: null });
  assert.equal(taskOutcome(state, task).action, 'Follow agent work', 'Do not offer a base update while a related assignment is active');
  state.runs.pop();
  assert.equal(taskOutcome(state, task).action, 'Update candidate base');
  assert.equal(taskOutcome(state, task).runId, delta.id);
});

test('project navigation and evidence exclude unrelated tasks, candidates and activity', () => {
  const { state, task, runs } = fixture();
  task.projectId = 'first';
  state.projects = { first: { id: 'first', name: 'First project' }, second: { id: 'second', name: 'Second project' } };
  const other = createTask(state, { title: 'Other work', purpose: 'Independent scope', criteria: ['Keep data within its project'], baseCommit: 'd'.repeat(40), owner: 'QA' });
  other.projectId = 'second';
  const otherRun = assignRun(state, other.id, { agent: 'Other', label: 'Other', branch: 'agent/other' });
  startRun(state, otherRun.id);
  state.events.push({ type: 'project.policy', projectId: 'second', message: 'Only second project', at: new Date().toISOString() });
  const first = projectContext(state, 'first'), second = projectContext(state, 'second');
  assert.deepEqual(first.tasks.map(item => item.id), [task.id]);
  assert.deepEqual(first.runs.map(item => item.id), runs.map(item => item.id));
  assert.equal(first.activeCandidates.length, 0);
  assert.equal(first.reviewTasks.length, 1, 'Reviews count tasks rather than the two retained candidates');
  assert.equal(first.queuedTasks.length, 0);
  assert.ok(first.events.every(event => event.taskId === task.id));
  assert.deepEqual(second.activeCandidates.map(item => item.id), [otherRun.id]);
  assert.equal(second.reviewTasks.length, 0);
  assert.ok(second.events.some(event => event.message === 'Only second project'));
  assert.ok(second.events.every(event => event.taskId === other.id || event.projectId === 'second'));
  assert.equal(state.runs.length, 3, 'Scoping presentation does not delete retained candidates');
});

test('project scope refuses unknown and inherited IDs and allows an empty known project', () => {
  const { state } = fixture();
  state.projects = { empty: { id: 'empty', name: 'Empty project' } };
  for (const id of ['unknown', '__proto__', 'constructor']) assert.throws(() => projectContext(state, id), /not in this workspace/);
  const empty = projectContext(state, 'empty');
  assert.deepEqual(empty.tasks, []); assert.deepEqual(empty.runs, []);
  assert.deepEqual(empty.events, []); assert.equal(empty.reviewTasks.length, 0);
});

test('real admission events remain project-scoped and stale policy writes leave history unchanged', () => {
  const state = createWorkspace();
  state.projects = Object.fromEntries(['first', 'second'].map(id => [id, { id, name: 'Same display name', acceptingWork: true, policyVersion: 1 }]));
  const historical = { id: 'historical', at: new Date().toISOString(), type: 'project.policy_changed', taskId: null, runId: null, message: 'Same display name: new agent work paused.' };
  state.events.push(historical);
  setProjectPolicy(state, 'first', { acceptingWork: false, expectedVersion: 1 });
  setProjectPolicy(state, 'second', { acceptingWork: false, expectedVersion: 1 });
  setProjectPolicy(state, 'first', { acceptingWork: true, expectedVersion: 2 });
  assert.equal(projectContext(state, 'first').events.length, 2);
  assert.equal(projectContext(state, 'second').events.length, 1);
  assert.ok(projectContext(state, 'first').events.every(event => event.projectId === 'first'));
  assert.ok(state.events.includes(historical), 'Unattributed historical evidence is retained without guessing its project');
  assert.ok(!projectContext(state, 'first').events.includes(historical));
  const before = JSON.stringify(state);
  assert.throws(() => setProjectPolicy(state, 'first', { acceptingWork: false, expectedVersion: 1 }), /current project policy/);
  assert.equal(JSON.stringify(state), before);
});

test('steering a revised task preserves commits and exposes stale proof until a fresh check', () => {
  const { state, task, runs: [delta, echo] } = fixture();
  const heads = state.runs.map(run => run.headCommit);
  assert.equal(taskBriefing(state, task).passing, 1);
  reviseTask(state, task.id, { expectedRevision: 1, purpose: 'Reject fractional quantities too', criteria: ['Reject invalid quantities', 'Reject fractional quantities'], reason: 'Clarified checkout behavior' });
  let brief = taskBriefing(state, task);
  assert.equal(brief.passing, 0); assert.equal(brief.total, 2); assert.equal(brief.retained, 2);
  assert.deepEqual(brief.change.added, ['Reject fractional quantities']);
  assert.equal(brief.change.purposeChanged, true);
  assert.ok(brief.candidates.every(item => item.earlierReport));
  verifyRun(state, delta.id, { ...delta.evidence, taskRevision: 2, verifiedAt: new Date().toISOString() });
  brief = taskBriefing(state, task);
  assert.equal(brief.passing, 1);
  assert.equal(brief.candidates.find(item => item.run.id === echo.id).earlierReport, true);
  assert.equal(task.acceptedRunId, null, 'Fresh verification cannot imply acceptance');
  assert.equal(task.mergedCommit, null, 'Fresh verification cannot imply merge');
  assert.deepEqual(state.runs.map(run => run.headCommit), heads);
});

test('steering shows earlier assignments and shared files without treating retained alternatives as current choices', () => {
  const { state, task, runs: [delta, echo] } = fixture();
  const active = assignRun(state, task.id, { agent: 'Third', label: 'Third', branch: 'agent/third' });
  startRun(state, active.id);
  reviseTask(state, task.id, { expectedRevision: 1, purpose: task.purpose, criteria: ['Reject fractional quantities'], reason: 'Changed requirement' });
  state.coordination = Object.fromEntries(state.runs.map(run => [run.id, coordination(state, run.id)]));
  let brief = taskBriefing(state, task);
  assert.equal(brief.total, 3); assert.equal(brief.retained, 2);
  assert.equal(brief.candidates.find(item => item.run.id === active.id).earlierAssignment, true);
  assert.deepEqual(brief.change.removed, ['Reject invalid quantities']);
  assert.deepEqual(brief.candidates[0].overlaps[0].paths, ['checkout.mjs']);
  assert.ok(brief.candidates[0].blockers.some(message => message.includes('related assigned work')));
  echo.status = 'superseded'; delta.status = 'rejected';
  for (const run of [echo, delta]) run.evidence = { ...run.evidence, taskRevision: 2, passed: 1, exitCode: 0 };
  brief = taskBriefing(state, task);
  assert.equal(brief.passing, 0, 'Rejected and superseded reports do not become current options');
  assert.equal(brief.total, 3, 'Retained alternatives remain in the denominator');
});

test('collection URLs retain only project scope and never silently select an item',()=>{
 const list=locationSearch('queue','task-a','candidate-b','project-c');
 assert.equal(list,'?view=queue&project=project-c');
 assert.deepEqual(readLocation(list),{view:'queue',projectId:'project-c',taskId:null,runId:null});
 assert.equal(locationSearch('work','task-a','candidate-b'),'?view=work&task=task-a');
 assert.equal(readLocation('?view=queue&project=p&task=t&candidate=r').taskId,null);
 assert.equal(readLocation('?view=history&project=p&candidate=r').runId,null);
});
