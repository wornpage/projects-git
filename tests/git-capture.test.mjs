import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { captureGitTask } from '../src/local/git-capture.mjs';
import { readTaskHandoff } from '../src/core/handoff.mjs';
import { createWorkspace, createTask, recordGitCandidate, reviewRun } from '../src/core/workflow.mjs';
import {reviewScaleFiles} from './helpers/review-scale.mjs';
import {recordedDiff} from '../public/review-diff.js';

const brief = { title: 'Retain real code changes', purpose: 'Move a committed change between sessions without inventing evidence.', criteria: ['Preserve the real source delta'] };
function git(repo, ...args) {
  const result = spawnSync('git', ['-c', 'user.name=Capture test', '-c', 'user.email=capture@example.invalid', '-c', 'core.autocrlf=false', ...args], { cwd: repo, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
async function fixture(t) {
  const repo = await mkdtemp(join(tmpdir(), 'projects-git-capture-'));
  t.after(async () => {
    assert.ok(resolve(repo).startsWith(resolve(tmpdir()) + sep));
    await rm(repo, { recursive: true, force: true });
  });
  git(repo, 'init', '-b', 'newwork/candidate');
  await writeFile(join(repo, 'feature.mjs'), 'export const value = 1;\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'Base');
  const base = git(repo, 'rev-parse', 'HEAD');
  await writeFile(join(repo, 'feature.mjs'), 'export const value = 2;\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'Real change');
  return { repo, base, branch: 'newwork/candidate', brief };
}

test('capture preserves real committed changes, dirty work and refs without fabricating execution', async t => {
  const options = await fixture(t);
  const { repo } = options;
  const head = git(repo, 'rev-parse', 'HEAD');
  await writeFile(join(repo, 'feature.mjs'), 'DIRTY_NOT_CAPTURED\n');
  await writeFile(join(repo, 'untracked.txt'), 'UNTRACKED_NOT_CAPTURED\n');
  const before = { refs: git(repo, 'show-ref'), status: git(repo, 'status', '--porcelain=v1'), index: await readFile(join(repo, '.git', 'index')) };
  const record = await captureGitTask(options);
  assert.deepEqual(await readTaskHandoff(JSON.stringify(record)), record);
  const { runs: [run], events, recordedMetrics, nextAction } = record.payload;
  assert.equal(run.headCommit, head);
  assert.equal(run.baseCommit, options.base);
  assert.equal(run.origin, 'existing-git');
  assert.deepEqual(run.changedFiles, ['feature.mjs']);
  assert.match(run.diff, /\+export const value = 2;/);
  assert.doesNotMatch(JSON.stringify(record), /DIRTY_NOT_CAPTURED|UNTRACKED_NOT_CAPTURED/);
  assert.equal(run.startedAt, null); assert.equal(run.finishedAt, null);
  assert.equal(run.execution, null); assert.equal(run.evidence, null); assert.equal(run.review, null);
  assert.deepEqual(events.map(event => event.type), ['task.created', 'run.imported']);
  assert.deepEqual(recordedMetrics.checks, { passed: 0, total: 0, verifiedRuns: 0, evidencedRuns: 0 });
  assert.deepEqual(recordedMetrics.acceptedCandidates, { numerator: 0, denominator: 1 });
  assert.equal(nextAction.kind, 'verify_repository');
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
  assert.equal(git(repo, 'show-ref'), before.refs);
  assert.equal(git(repo, 'status', '--porcelain=v1'), before.status);
  assert.deepEqual(await readFile(join(repo, '.git', 'index')), before.index);
  assert.equal(await readFile(join(repo, 'feature.mjs'), 'utf8'), 'DIRTY_NOT_CAPTURED\n');
  assert.equal(await readFile(join(repo, 'untracked.txt'), 'utf8'), 'UNTRACKED_NOT_CAPTURED\n');
});

test('existing Git candidate cannot be accepted without independent exact-commit evidence', () => {
  const state = createWorkspace();
  const task = createTask(state, { ...brief, baseCommit: 'a'.repeat(40) });
  const run = recordGitCandidate(state, task.id, { branch: 'newwork/real', headCommit: 'b'.repeat(40), changedFiles: ['file'], diff: '+change', summary: 'Imported committed work' });
  assert.throws(() => reviewRun(state, run.id, { decision: 'accept', note: 'Read diff', reviewer: 'Test', headCommit: run.headCommit, taskRevision: 1 }), { code: 'verification_required' });
  assert.equal(task.acceptedRunId, null);
});

test('native Git capture retains twenty files and two thousand representative added lines within the explicit character limit',async t=>{
  const options=await fixture(t);options.base=git(options.repo,'rev-parse','HEAD');
  const files=reviewScaleFiles();
  for(const [path,content] of Object.entries(files)){await mkdir(dirname(join(options.repo,path)),{recursive:true});await writeFile(join(options.repo,path),content);}
  git(options.repo,'add','.');git(options.repo,'commit','-m','Synthetic twenty-file review stress fixture');
  const handoff=await captureGitTask(options),run=handoff.payload.runs[0];
  assert.deepEqual(new Set(run.changedFiles),new Set(Object.keys(files)));
  assert.ok(run.diff.length>150000&&run.diff.length<=200000);
  const model=recordedDiff(run.diff,run.changedFiles);
  assert.equal(model.sections.length,20);assert.equal(model.unmapped,0);assert.equal(model.added,2000);assert.equal(model.removed,0);
  assert.equal(run.evidence,null);assert.equal(run.review,null);
  assert.deepEqual(await readTaskHandoff(JSON.stringify(handoff)),handoff);
  const state=createWorkspace(),task=createTask(state,{...brief,baseCommit:options.base});
  assert.throws(()=>recordGitCandidate(state,task.id,{branch:options.branch,headCommit:run.headCommit,changedFiles:run.changedFiles,diff:run.diff.repeat(10),summary:'Over-limit negative fixture'}),{code:'invalid_diff'});
  assert.equal(state.runs.length,0);
});

test('capture refuses ambiguous, missing, empty and unrelated revisions', async t => {
  const options = await fixture(t);
  await assert.rejects(captureGitTask({ ...options, base: options.base.slice(0, 12) }), /full lowercase/);
  await assert.rejects(captureGitTask({ ...options, branch: '--help' }), /explicit local branch/);
  await assert.rejects(captureGitTask({ ...options, branch: 'missing' }), /Git rev-parse failed/);
  await assert.rejects(captureGitTask({ ...options, base: git(options.repo, 'rev-parse', 'HEAD') }), /1 to 100/);
  git(options.repo, 'checkout', '--orphan', 'unrelated');
  git(options.repo, 'commit', '-m', 'Unrelated root');
  await assert.rejects(captureGitTask({ ...options, base: git(options.repo, 'rev-parse', 'HEAD') }), /Git merge-base failed/);
});

test('capture disables external diff and textconv and scrubs inherited Git redirection', async t => {
  const options = await fixture(t);
  git(options.repo, 'config', 'diff.external', 'MUST_NOT_EXECUTE');
  git(options.repo, 'config', 'diff.hostile.textconv', 'MUST_NOT_EXECUTE');
  await writeFile(join(options.repo, '.gitattributes'), '*.mjs diff=hostile\n');
  const old = process.env.GIT_DIR;
  process.env.GIT_DIR = join(options.repo, 'NONEXISTENT_GIT_DIRECTORY');
  try { assert.match((await captureGitTask(options)).payload.runs[0].diff, /\+export const value = 2;/); }
  finally { if (old === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = old; }
});

test('capture rejects binary, invalid UTF-8 and oversized source diffs', async t => {
  const options = await fixture(t);
  for (const [content, message] of [[Buffer.from([0, 1, 2]), /Binary changes/], [Buffer.from([0xff, 0xfe, 10]), /valid UTF-8/], ['x'.repeat(200001), /Diff exceeds/]]) {
    await writeFile(join(options.repo, 'feature.mjs'), content);
    git(options.repo, 'add', '.'); git(options.repo, 'commit', '-m', 'Unsupported capture');
    await assert.rejects(captureGitTask(options), message);
  }
});

test('CLI produces inspectable handoff, rejects invalid briefs and never overwrites output', async t => {
  const options = await fixture(t);
  const briefPath = join(options.repo, 'brief.json');
  const out = join(options.repo, 'handoff.json');
  await writeFile(briefPath, JSON.stringify(brief));
  const args = ['scripts/capture-git-task.mjs', '--repo', options.repo, '--base', options.base, '--branch', options.branch, '--brief', briefPath, '--out', out];
  const call = (extra = []) => spawnSync(process.execPath, [...args, ...extra], { encoding: 'utf8', windowsHide: true });
  const first = call();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).checks.total, 0);
  const bytes = await readFile(out);
  const inspect = spawnSync(process.execPath, ['scripts/inspect-handoff.mjs', out], { encoding: 'utf8', windowsHide: true });
  assert.equal(inspect.status, 0, inspect.stderr);
  assert.equal(JSON.parse(inspect.stdout).candidates[0].origin, 'existing-git');
  assert.equal(call().status, 1);
  assert.deepEqual(await readFile(out), bytes);
  assert.equal(call(['--repo', options.repo]).status, 1);
  for (const [content, message] of [[JSON.stringify({ ...brief, command: 'NEVER_RUN' }), /exactly title/], [Buffer.from([0xff]), /valid UTF-8 JSON/], ['x'.repeat(16385), /16 KiB/]]) {
    await writeFile(briefPath, content);
    const result = call();
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
    assert.equal(result.stdout, '');
  }
});
