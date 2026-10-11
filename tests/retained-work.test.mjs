import test from 'node:test';
import assert from 'node:assert/strict';
import { searchRetainedWork, indexedSearchResults, retainedWorkSnippet } from '../public/retained-work.js';
import { candidateOutcome, readLocation } from '../public/workbench-state.js';

test('literal search excerpts expose a matching review note beyond the document prefix', () => {
  const note = 'Retained rejection: require safe manual clipboard copying before reconsidering.';
  const source = 'Earlier requirements and candidate metadata. '.repeat(15) + note;
  const snippet = retainedWorkSnippet(source, 'retained rejection');
  assert.ok(snippet.startsWith('…'));
  assert.ok(snippet.includes(note));
  assert.ok(snippet.length <= 242);
  assert.equal(retainedWorkSnippet(source), source.slice(0, 240) + '…');
  assert.equal(retainedWorkSnippet('short note', 'absent'), 'short note');
  assert.ok(retainedWorkSnippet(source, 'clipboard safe').includes('clipboard'));
});

test('search excerpt clipping preserves Unicode pairs and does not change source text', () => {
  const source = 'a'.repeat(239) + '😀' + 'tail';
  assert.equal(retainedWorkSnippet(source), 'a'.repeat(239) + '…');
  const middle = 'a'.repeat(201) + '😀' + 'b'.repeat(59) + 'clipboard '.repeat(30);
  const snippet = retainedWorkSnippet(middle, 'clipboard');
  assert.equal(snippet.isWellFormed(), true);
  assert.ok(snippet.includes('clipboard'));
});

test('literal excerpt positions stay in the original text when Unicode case folding changes length', () => {
  const source = 'İ'.repeat(300) + ' Clipboard inspection confirmed.';
  assert.ok(retainedWorkSnippet(source, 'clipboard').includes('Clipboard inspection confirmed.'));
  const punctuation = 'a'.repeat(300) + ' Review [failed]+ needs attention.';
  assert.ok(retainedWorkSnippet(punctuation, '[failed]+').includes('Review [failed]+ needs attention.'));
});

function fixture() {
  const task = { id: 'task-a', projectId: 'alpha', title: 'Accessible agent handoff', purpose: 'Keep instructions available', criteria: ['Keyboard access'], revision: 2 };
  const run = { id: 'run-a', taskId: task.id, label: 'UI agent', summary: 'Keep text selectable', status: 'awaiting_review', headCommit: 'a'.repeat(40), changedFiles: ['public/connect-agent.js'], review: { note: 'Clipboard fallback inspected' },
    evidence: { verified: true, source: 'independent-local-checks', taskRevision: 2, commit: 'a'.repeat(40), passed: 1, total: 1, checks: [{ passed: true }], exitCode: 0 } };
  const workspace = { projects: { alpha: { id: 'alpha', name: 'Alpha' }, beta: { id: 'beta', name: 'Beta' } },
    tasks: [task, { ...task, id: 'task-b', projectId: 'beta', title: 'Private other project' }, { ...task, id: 'queued', title: 'Add search', criteria: ['Literal matching'], purpose: 'Discover retained work' }],
    runs: [run, { ...run, id: 'run-b', taskId: 'task-b', summary: 'Other project result' }, { ...run, id: 'orphan', taskId: 'missing' }] };
  return { workspace, task, run };
}

test('search is project scoped, counts records explicitly, and includes queued task briefs', () => {
  const { workspace } = fixture();
  const before = structuredClone(workspace);
  const result = searchRetainedWork(workspace, 'alpha');
  assert.equal(result.total, 2);
  assert.deepEqual(result.items.map(item => item.run?.id ?? item.task.id), ['queued', 'run-a']);
  assert.equal(searchRetainedWork(workspace, 'alpha', 'Private other').items.length, 0);
  assert.throws(() => searchRetainedWork(workspace, 'missing'), /Project is not in this workspace/);
  assert.deepEqual(workspace, before);
});

test('all query terms match across declared fields with literal case-insensitive matching', () => {
  const { workspace } = fixture();
  for (const query of ['KEYBOARD selectable', 'connect-agent.js', 'aaaaaaa', 'clipboard fallback', 'run-a']) {
    const result = searchRetainedWork(workspace, 'alpha', query);
    assert.equal(result.items.length, 1, query);
    assert.equal(result.items[0].run.id, 'run-a');
    assert.ok(result.items[0].matchedFields.length);
  }
  assert.equal(searchRetainedWork(workspace, 'alpha', 'keyboard missingword').items.length, 0);
  assert.equal(searchRetainedWork(workspace, 'alpha', '.*').items.length, 0);
  workspace.runs[0].diff = 'SECRET_UNINDEXED_DIFF';
  workspace.runs[0].evidence.output = 'SECRET_UNINDEXED_LOG';
  assert.equal(searchRetainedWork(workspace, 'alpha', 'SECRET_UNINDEXED').items.length, 0);
});

test('result links select the exact task and candidate, or the queued task', () => {
  const { workspace } = fixture();
  const [brief, candidate] = searchRetainedWork(workspace, 'alpha').items;
  assert.deepEqual(readLocation(brief.href), { view: 'work', projectId:null, taskId: 'queued', runId: null });
  assert.deepEqual(readLocation(candidate.href), { view: 'review', projectId:null, taskId: 'task-a', runId: 'run-a' });
});

test('search uses the canonical outcome and never promotes stale or failed checks', () => {
  const { workspace, run } = fixture();
  const result = () => searchRetainedWork(workspace, 'alpha', 'run-a').items[0];
  assert.match(result().outcome.label, /Checks pass/);
  run.evidence.taskRevision = 1;
  assert.deepEqual(result().outcome, candidateOutcome(workspace, run));
  assert.equal(result().outcome.label, 'Recheck needed');
  assert.match(result().proof, /not current/);
  run.evidence.taskRevision = 2;
  run.evidence.passed = 0; run.evidence.exitCode = 1; run.evidence.checks[0].passed = false;
  assert.equal(result().outcome.label, 'Checks failed');
  assert.match(result().proof, /0 \/ 1/);
  run.verificationPending = true;
  assert.equal(result().proof, 'Verification running');
  run.verificationPending = false;
  run.status = 'rejected';
  assert.equal(result().outcome.label, 'Rejected');
  run.status = 'superseded';
  assert.equal(result().outcome.label, 'Previous base · retained');
});

test('indexed history keeps its matched identity separate from current evidence and refuses foreign records', () => {
  const { workspace, task, run } = fixture(); workspace.id = 'workspace';
  const document = { workspaceId: workspace.id, projectId: 'alpha', taskId: task.id, runId: run.id, headCommit: run.headCommit, taskRevision: 1, text: 'Earlier requirements', score: 0.99 };
  const [match] = indexedSearchResults(workspace, 'alpha', [document]);
  assert.equal(match.historical, true);
  assert.match(match.proof, /Historical match/);
  assert.equal(match.matchedRevision, 1);
  assert.equal(match.task.revision, 2);
  run.evidence.passed = 0; run.evidence.exitCode = 1;
  assert.equal(indexedSearchResults(workspace, 'alpha', [{ ...document, taskRevision: 2 }])[0].outcome.label, 'Checks failed');
  assert.throws(() => indexedSearchResults(workspace, 'alpha', [{ ...document, projectId: 'beta' }]), /another workspace or project/);
  assert.throws(() => indexedSearchResults(workspace, 'alpha', [{ ...document, workspaceId: 'foreign' }]), /another workspace or project/);
  assert.deepEqual(indexedSearchResults(workspace, 'alpha', [{ ...document, taskId: 'missing' }]), []);
});
