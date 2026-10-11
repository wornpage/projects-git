import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readTaskHandoff, buildTaskHandoff, MAX_HANDOFF_BYTES } from '../core/handoff.mjs';
import { createWorkspace, createTask, verifyRun } from '../core/workflow.mjs';
import { readOnlyGit, committedChange } from './git-reader.mjs';
import { snapshotCommit } from './git-snapshot.mjs';
import { DockerChecks } from './sandbox-checks.mjs';
import { readCheckDefinition, digest, CHECK_FORMAT } from '../core/check-definition.mjs';

/** Verify one captured candidate; produces a new unsigned record, never imports or accepts live state. */
export async function verifyRepositoryHandoff({ repo, handoffText, definitionBytes, definitionSha256, image }) {
  const input = await readTaskHandoff(handoffText);
  const { task, runs } = input.payload;
  const run = runs[0];
  if (runs.length !== 1 || run?.origin !== 'existing-git' || run.status !== 'awaiting_review' || task.status !== 'review'
    || task.acceptedRunId !== null || task.mergedCommit !== null || run.review !== null || run.execution !== null || run.baseCommit !== task.baseCommit
    || !Number.isInteger(task.revision) || task.revision < 1 || !Array.isArray(input.payload.events) || !Number.isSafeInteger(input.payload.workspace.version)
    || input.payload.workspace.version < 0 || input.payload.workspace.version === Number.MAX_SAFE_INTEGER) throw new Error('Verify an unaccepted single-candidate Git capture with an explicit revision.');
  // Validate task inputs through the same rules, without promoting any supplied history to authority.
  createTask(createWorkspace(), task);
  const state = structuredClone({ ...input.payload.workspace, schemaVersion: 1, tasks: [task], runs, events: input.payload.events });
  const projected = await buildTaskHandoff(state, task.id);
  if (Buffer.byteLength(JSON.stringify(projected, null, 2)) + Buffer.byteLength(JSON.stringify(run.evidence, null, 2)) * 2 + 65536 > MAX_HANDOFF_BYTES) throw new Error('Handoff needs room for retained evidence and a new verification receipt.');
  const evidence = await verifyRepositoryCandidate({ repo, task, run, definitionBytes, definitionSha256, image, inputHandoffSha256: input.sha256 });
  verifyRun(state, run.id, evidence);
  return buildTaskHandoff(state, task.id);
}

/** One execution path for offline captures and live repository candidates. */
export async function verifyRepositoryCandidate({ repo, task, run, definitionBytes, definitionSha256, image, inputHandoffSha256 }) {
  const plan = readCheckDefinition(definitionBytes, definitionSha256, task, run);
  const sandbox = new DockerChecks({ image, timeoutMs: plan.timeoutMs });
  const resolvedImage = await sandbox.ready();
  const actual = await committedChange(readOnlyGit(repo), task.baseCommit, run.headCommit);
  if (actual.diff !== run.diff || !isDeepStrictEqual(actual.changedFiles, run.changedFiles)) throw new Error('Captured diff or paths do not match the committed Git objects.');
  const root = await mkdtemp(path.join(tmpdir(), 'projects-repository-checks-'));
  let tree, checks = [], interrupted = false;
  const verifierFiles = ['../core/check-definition.mjs', '../core/snapshot-path.mjs', './repository-checks.mjs', './git-snapshot.mjs', './git-reader.mjs', './sandbox-checks.mjs'];
  const verifierSha256 = digest(Buffer.concat(await Promise.all(verifierFiles.map(file => readFile(new URL(file, import.meta.url))))));
  try {
    tree = await snapshotCommit(repo, run.headCommit, path.join(root, 'candidate'));
    const deadline = Date.now() + plan.timeoutMs;
    for (const check of plan.checks) {
      let passed = false, detail;
      if (interrupted) detail = 'Not run: the verification attempt was interrupted.';
      else if (deadline - Date.now() < 1000) { interrupted = true; detail = 'Not run: total execution time allowance exhausted.'; }
      else {
        sandbox.timeoutMs = deadline - Date.now();
        try {
          const observed = await sandbox.observe(path.join(root, 'candidate'), { argv: check.argv, input: check.stdin, scratch: true });
          if (observed.exitCode === null || observed.exitCode >= 125) { interrupted = true; detail = 'Runtime could not complete the declared command (infrastructure failure or termination).'; }
          else {
            passed = observed.exitCode === check.expected.exitCode && observed.stdout === check.expected.stdout;
            detail = `Observed exit ${observed.exitCode}; stdout SHA-256 ${digest(observed.stdout)}; ${passed ? 'matched' : 'did not match'} the trusted expectation.`;
          }
        } catch (error) {
          interrupted = true;
          detail = error?.message?.startsWith('Sandbox ') ? error.message : 'Sandbox invocation failed; remaining checks were not run.';
        }
      }
      checks.push({ name: check.name, passed, detail });
    }
  } finally {
    if (!path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep)) throw new Error('Temporary directory escaped cleanup boundary.');
    await rm(root, { recursive: true, force: true });
  }
  const passed = checks.filter(check => check.passed).length;
  return { commit: run.headCommit, taskRevision: task.revision, verified: !interrupted,
    source: 'independent-sandbox-checks', checks, passed, total: checks.length, exitCode: !interrupted && passed === checks.length ? 0 : 1,
    command: `Declared repository command checks (${definitionSha256})`, output: checks.map(check => `${check.passed ? 'PASS' : 'FAIL'} ${check.name}: ${check.detail}`).join('\n'),
    verifiedAt: new Date().toISOString(), verification: { kind: CHECK_FORMAT, definitionSha256, verifierSha256, inputHandoffSha256,
      requirementsSha256: plan.requirementsSha256, image: resolvedImage, tree } };
}
