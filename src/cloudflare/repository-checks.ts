import { Buffer } from 'node:buffer';
import { readCheckDefinition, digest, CHECK_FORMAT } from '../core/check-definition.mjs';
import type { Task, Run, Evidence } from '../core/workflow.mjs';
import type { ArtifactSnapshot, SnapshotFile } from './artifacts.ts';
import type { CommandObservation } from './container-observer.ts';
import { VERIFIER_SHA256 } from './verifier-identity.ts';

export interface CheckPolicy { definition: string; definitionSha256: string; image?: string }
export interface RepositoryCheckRuntime {
  observe(attemptId: string, index: number, files: SnapshotFile[], argv: string[], input: string, timeoutMs: number): Promise<CommandObservation>;
}

/** All expectations and scoring stay in the trusted Worker, outside candidate code. */
export async function verifyArtifactCandidate(runtime: RepositoryCheckRuntime, snapshot: ArtifactSnapshot, task: Task, run: Run, policy: CheckPolicy, inputHandoffSha256: string, attemptId: string): Promise<Evidence> {
  const plan = readCheckDefinition(Buffer.from(policy.definition), policy.definitionSha256, task, run);
  if (snapshot.commit !== run.headCommit) throw new Error('Verification snapshot is not the submitted commit.');
  const deadline = Date.now() + plan.timeoutMs;
  let interrupted = false, image: string | undefined;
  const checks: Evidence['checks'] = [];
  for (const [index, check] of plan.checks.entries()) {
    let passed = false, detail: string;
    if (interrupted) detail = 'Not run: the verification attempt was interrupted.';
    else if (deadline - Date.now() < 1000) { interrupted = true; detail = 'Not run: the total execution allowance was exhausted.'; }
    else {
      try {
        const observed = await runtime.observe(attemptId, index, snapshot.files, check.argv, check.stdin, deadline - Date.now());
        if (!/(?:@|^)sha256:[a-f0-9]{64}$/.test(observed.image) || image && image !== observed.image.slice(-71)) throw new Error('Verification runtime image changed.');
        image = observed.image.slice(-71);
        if (!Number.isInteger(observed.exitCode) || observed.exitCode < 0 || observed.exitCode >= 125) {
          interrupted = true; detail = 'Runtime could not complete the declared command.';
        } else {
          passed = observed.exitCode === check.expected.exitCode && observed.stdout === check.expected.stdout;
          detail = `Observed exit ${observed.exitCode}; stdout SHA-256 ${digest(observed.stdout)}; ${passed ? 'matched' : 'did not match'} the trusted expectation.`;
        }
      } catch { interrupted = true; detail = 'The isolated command could not finish within its runtime, output or time allowance.'; }
    }
    checks.push({ name: check.name, passed, detail });
  }
  const passed = checks.filter(check => check.passed).length;
  return { commit: snapshot.commit, taskRevision: task.revision, verified: !interrupted,
    source: 'independent-sandbox-checks', checks, passed, total: checks.length, exitCode: !interrupted && passed === checks.length ? 0 : 1,
    command: `Declared repository command checks (${policy.definitionSha256})`, output: checks.map(check => `${check.passed ? 'PASS' : 'FAIL'} ${check.name}: ${check.detail}`).join('\n'), verifiedAt: new Date().toISOString(),
    ...(image ? { verification: { kind: CHECK_FORMAT, definitionSha256: policy.definitionSha256, verifierSha256: VERIFIER_SHA256, inputHandoffSha256, requirementsSha256: plan.requirementsSha256, image, tree: snapshot.tree } } : {}) };
}
