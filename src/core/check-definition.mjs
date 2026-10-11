import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { validateCommit } from './workflow.mjs';

export const CHECK_FORMAT = 'repository-command-checks/v1';
export const digest = value => createHash('sha256').update(value).digest('hex');
export const requirementsDigest = task => digest(JSON.stringify({ title: task.title, purpose: task.purpose, criteria: task.criteria, revision: task.revision }));
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === keys.sort().join(',');

export function readCheckDefinition(bytes, expectedDigest, task, run) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 65536 || !/^[a-f0-9]{64}$/.test(expectedDigest) || digest(bytes) !== expectedDigest) throw new Error('Check definition does not match the explicitly trusted SHA-256 digest or exceeds 64 KiB.');
  let plan;
  try { plan = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('Check definition must be valid UTF-8 JSON.'); }
  if (!exactKeys(plan, ['format', 'commit', 'taskRevision', 'requirementsSha256', 'timeoutMs', 'checks']) || plan.format !== CHECK_FORMAT) throw new Error('Unsupported check definition.');
  if (validateCommit(plan.commit) !== run.headCommit || plan.taskRevision !== task.revision || plan.requirementsSha256 !== requirementsDigest(task)) throw new Error('Check definition targets a different commit or requirements revision.');
  if (!Number.isInteger(plan.timeoutMs) || plan.timeoutMs < 1000 || plan.timeoutMs > 60000 || !Array.isArray(plan.checks) || plan.checks.length < 1 || plan.checks.length > 12) throw new Error('Use 1 to 12 checks with a total execution allowance of 1000 to 60000 ms.');
  const names = new Set();
  for (const check of plan.checks) {
    if (!exactKeys(check, ['name', 'argv', 'stdin', 'expected']) || typeof check.name !== 'string' || !check.name.trim() || check.name.length > 200 || names.has(check.name)
      || !Array.isArray(check.argv) || check.argv.length < 1 || check.argv.length > 32 || check.argv.some(value => typeof value !== 'string' || value.length > 8192 || value.includes('\0'))
      || !check.argv[0] || check.argv[0].startsWith('-') || typeof check.stdin !== 'string' || check.stdin.length > 16384
      || !exactKeys(check.expected, ['exitCode', 'stdout']) || !Number.isInteger(check.expected.exitCode) || check.expected.exitCode < 0 || check.expected.exitCode > 124
      || typeof check.expected.stdout !== 'string' || check.expected.stdout.length > 16384) throw new Error('Invalid or duplicate command check. Expected exit codes must be 0 to 124.');
    names.add(check.name);
  }
  return plan;
}
