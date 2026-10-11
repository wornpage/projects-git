import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { captureGitTask } from '../src/local/git-capture.mjs';
import { snapshotCommit } from '../src/local/git-snapshot.mjs';
import { verifyRepositoryHandoff } from '../src/local/repository-checks.mjs';
import { readCheckDefinition, digest, requirementsDigest, CHECK_FORMAT } from '../src/core/check-definition.mjs';
import { buildTaskHandoff } from '../src/core/handoff.mjs';
import { createTask, createWorkspace, recordGitCandidate, reviseTask } from '../src/core/workflow.mjs';

const nodeImage = process.env.PROJECTS_SANDBOX_TEST_IMAGE;
const pythonImage = process.env.PROJECTS_PYTHON_TEST_IMAGE;
const git = (repo, ...args) => {
  const result = spawnSync('git', ['-c', 'user.name=Verification test', '-c', 'user.email=checks@example.invalid', '-c', 'core.autocrlf=false', ...args], { cwd: repo, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
};
async function temporary(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'projects-command-tests-'));
  t.after(async () => { assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep)); await rm(directory, { recursive: true, force: true }); });
  return directory;
}
async function fixture(t) {
  const repo = await temporary(t);
  git(repo, 'init', '-b', 'newwork/checks');
  await writeFile(path.join(repo, 'main.mjs'), 'console.log(1);\n');
  await writeFile(path.join(repo, 'main.py'), 'print(1)\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'Base');
  const base = git(repo, 'rev-parse', 'HEAD');
  await writeFile(path.join(repo, 'main.mjs'), 'import {readFileSync} from "node:fs"; console.log(JSON.parse(readFileSync(0,"utf8")) + 2);\n');
  await writeFile(path.join(repo, 'main.py'), 'import sys, json\nprint(json.load(sys.stdin) + 2)\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'Add two in both languages');
  const record = await captureGitTask({ repo, base, branch: 'newwork/checks', brief: { title: 'Add two', purpose: 'Return the sum for supplied integer input.', criteria: ['3 becomes 5', '-2 becomes 0'] } });
  return { repo, record };
}
function definition(record, argv = ['node', 'main.mjs'], timeoutMs = 30000) {
  return { format: CHECK_FORMAT, commit: record.payload.runs[0].headCommit, taskRevision: record.payload.task.revision,
    requirementsSha256: requirementsDigest(record.payload.task), timeoutMs,
    checks: [{ name: 'Positive input', argv, stdin: '3', expected: { exitCode: 0, stdout: '5\n' } },
      { name: 'Negative input', argv, stdin: '-2', expected: { exitCode: 0, stdout: '0\n' } }] };
}
function verify(repo, record, plan, image = nodeImage) {
  const definitionBytes = Buffer.from(JSON.stringify(plan));
  return verifyRepositoryHandoff({ repo, handoffText: JSON.stringify(record), definitionBytes, definitionSha256: digest(definitionBytes), image });
}

test('only an explicitly pinned check definition for this commit and requirements is admitted', async () => {
  const state = createWorkspace();
  const task = createTask(state, { title: 'Review', purpose: 'Check behavior', criteria: ['Criterion'], baseCommit: 'a'.repeat(40) });
  const run = recordGitCandidate(state, task.id, { branch: 'newwork/checks', headCommit: 'b'.repeat(40), changedFiles: ['file'], diff: '+file', summary: 'Existing change' });
  const record = await buildTaskHandoff(state, task.id);
  const plan = definition(record), bytes = Buffer.from(JSON.stringify(plan));
  assert.deepEqual(readCheckDefinition(bytes, digest(bytes), task, run), plan);
  assert.throws(() => readCheckDefinition(bytes, '0'.repeat(64), task, run), /explicitly trusted/);
  assert.throws(() => readCheckDefinition(bytes, digest(bytes), { ...task, revision: 2 }, run), /different commit or requirements/);
  assert.throws(() => readCheckDefinition(bytes, digest(bytes), { ...task, criteria: ['Changed without bump'] }, run), /different commit or requirements/);
  assert.throws(() => readCheckDefinition(bytes, digest(bytes), task, { ...run, headCommit: 'c'.repeat(40) }), /different commit or requirements/);
  plan.checks[0].command = 'ignored command must not be admitted';
  const extra = Buffer.from(JSON.stringify(plan));
  assert.throws(() => readCheckDefinition(extra, digest(extra), task, run), /Invalid or duplicate/);
});

test('snapshot reads committed blobs without dirty files, Git metadata or symlink extraction', async t => {
  const { repo, record } = await fixture(t);
  await writeFile(path.join(repo, 'main.mjs'), 'UNCOMMITTED');
  await writeFile(path.join(repo, 'secret.txt'), 'UNTRACKED');
  const target = path.join(await temporary(t), 'snapshot');
  const tree = await snapshotCommit(repo, record.payload.runs[0].headCommit, target);
  assert.equal(tree, git(repo, 'rev-parse', 'HEAD^{tree}'));
  assert.match(await readFile(path.join(target, 'main.mjs'), 'utf8'), /JSON.parse/);
  await assert.rejects(readFile(path.join(target, 'secret.txt')), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(target, '.git', 'config')), { code: 'ENOENT' });
  const blob = git(repo, 'hash-object', '-w', 'secret.txt');
  git(repo, 'update-index', '--add', '--cacheinfo', `120000,${blob},escape`);
  git(repo, 'commit', '-m', 'Symlink candidate');
  await assert.rejects(snapshotCommit(repo, git(repo, 'rev-parse', 'HEAD'), path.join(await temporary(t), 'snapshot')), /symlinks and submodules/);
});

test('real JavaScript and Python commands produce commit-bound evidence without granting acceptance', { skip: !nodeImage || !pythonImage, timeout: 120000 }, async t => {
  const { repo, record } = await fixture(t);
  const refs = git(repo, 'show-ref');
  await writeFile(path.join(repo, 'main.mjs'), 'DIRTY_MUST_NOT_EXECUTE');
  await writeFile(path.join(repo, 'main.py'), 'DIRTY_MUST_NOT_EXECUTE');
  let current = record;
  for (const [argv, image] of [[['node', 'main.mjs'], nodeImage], [['python', '-I', '-B', 'main.py'], pythonImage]]) {
    if (argv[0] === 'python') {
      const state = structuredClone({ ...current.payload.workspace, tasks: [current.payload.task], runs: current.payload.runs, events: current.payload.events });
      reviseTask(state, state.tasks[0].id, { expectedRevision: 1, purpose: 'Verify the same behavior in Python.', criteria: state.tasks[0].criteria, reason: 'Require Python verification' });
      current = await buildTaskHandoff(state, state.tasks[0].id);
      assert.equal(current.payload.recordedMetrics.checks.verifiedRuns, 0);
    }
    current = await verify(repo, current, definition(current, argv), image);
    const run = current.payload.runs[0];
    assert.equal(run.evidence.passed, 2); assert.equal(run.evidence.total, 2);
    assert.equal(run.evidence.verified, true);
    assert.equal(run.evidence.commit, record.payload.runs[0].headCommit);
    assert.equal(run.evidence.taskRevision, current.payload.task.revision);
    assert.match(run.evidence.verification.image, /^sha256:/);
    assert.equal(run.review, null); assert.equal(run.execution, null);
    assert.equal(current.payload.task.acceptedRunId, null);
    assert.equal(current.payload.nextAction.kind, 'human_review');
  }
  assert.equal(current.payload.runs[0].evidenceHistory.length, 1);
  assert.equal(current.payload.runs[0].evidenceHistory[0].taskRevision, 1);
  assert.equal(current.payload.runs[0].evidence.taskRevision, 2);
  assert.equal(git(repo, 'show-ref'), refs);
  assert.equal(await readFile(path.join(repo, 'main.mjs'), 'utf8'), 'DIRTY_MUST_NOT_EXECUTE');
  assert.equal(record.payload.runs[0].evidence, null);
});

test('host scoring ignores pass claims, preserves failures and marks interrupted checks unverified', { skip: !nodeImage, timeout: 120000 }, async t => {
  const { repo, record } = await fixture(t);
  const forged = definition(record, ['node', '-e', 'console.log(JSON.stringify({passed:999,total:999}));']);
  const failed = await verify(repo, record, forged);
  assert.equal(failed.payload.runs[0].evidence.passed, 0);
  assert.equal(failed.payload.runs[0].evidence.total, 2);
  const slow = definition(failed, ['node', '-e', 'while(true) {}'], 3000);
  const interrupted = await verify(repo, failed, slow);
  const run = interrupted.payload.runs[0];
  assert.equal(run.evidence.verified, false);
  assert.equal(run.evidence.passed, 0); assert.equal(run.evidence.total, 2);
  assert.match(run.evidence.checks[0].detail, /Sandbox stopped/, 'The first check must actually be admitted and stopped, rather than skipped before execution.');
  assert.equal(run.evidenceHistory[0].passed, 0);
  assert.equal(run.evidenceHistory[0].verification.inputHandoffSha256, record.sha256);
  assert.equal(run.evidence.verification.inputHandoffSha256, failed.sha256);
  assert.equal(interrupted.payload.recordedMetrics.checks.verifiedRuns, 0);
});

test('container observes read-only source and no host environment or Git metadata', { skip: !nodeImage, timeout: 60000 }, async t => {
  const { repo, record } = await fixture(t);
  const script = 'const fs=require("node:fs"); let denied=false;try{fs.writeFileSync("main.mjs","overwrite")}catch{denied=true}; fs.writeFileSync("/tmp/scratch","temporary"); console.log(JSON.stringify({readonly:denied,git:fs.existsSync(".git"),socket:fs.existsSync("/var/run/docker.sock"),secret:!!process.env.PROJECTS_TEST_HOST_SECRET,scratch:fs.readFileSync("/tmp/scratch","utf8")}));';
  const plan = definition(record);
  plan.checks = [{ name: 'Isolation', argv: ['node', '-e', script], stdin: '', expected: { exitCode: 0, stdout: '{"readonly":true,"git":false,"socket":false,"secret":false,"scratch":"temporary"}\n' } }];
  const old = process.env.PROJECTS_TEST_HOST_SECRET; process.env.PROJECTS_TEST_HOST_SECRET = 'HOST_ONLY_SENTINEL';
  try { assert.equal((await verify(repo, record, plan)).payload.runs[0].evidence.passed, 1); }
  finally { if (old === undefined) delete process.env.PROJECTS_TEST_HOST_SECRET; else process.env.PROJECTS_TEST_HOST_SECRET = old; }
});

test('verification CLI refuses replacing an existing receipt before any container work', async t => {
  const { repo, record } = await fixture(t);
  const handoff = path.join(repo, 'input.json'), checks = path.join(repo, 'checks.json'), out = path.join(repo, 'receipt.json');
  const bytes = Buffer.from(JSON.stringify(definition(record)));
  await writeFile(handoff, JSON.stringify(record)); await writeFile(checks, bytes); await writeFile(out, 'PRESERVE');
  const result = spawnSync(process.execPath, ['scripts/verify-git-task.mjs', '--repo', repo, '--handoff', handoff, '--checks', checks, '--checks-sha256', digest(bytes), '--image', 'sha256:' + '0'.repeat(64), '--out', out], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 1); assert.match(result.stderr, /EEXIST/);
  assert.equal(await readFile(out, 'utf8'), 'PRESERVE');
});
