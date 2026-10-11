import type { Task, Run } from './workflow.mjs';
export const CHECK_FORMAT: 'repository-command-checks/v1';
export interface CommandCheck { name: string; argv: string[]; stdin: string; expected: { exitCode: number; stdout: string } }
export interface CheckDefinition { format: typeof CHECK_FORMAT; commit: string; taskRevision: number; requirementsSha256: string; timeoutMs: number; checks: CommandCheck[] }
export function digest(value: string | Uint8Array): string;
export function requirementsDigest(task: Task): string;
export function readCheckDefinition(bytes: Buffer, expectedDigest: string, task: Task, run: Run): CheckDefinition;
