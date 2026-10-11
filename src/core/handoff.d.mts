import type { Workspace } from './workflow.mjs';
export const HANDOFF_FORMAT: string;
export const MAX_HANDOFF_BYTES: number;
export interface TaskHandoff { format: string; sha256: string; payload: Record<string, unknown> }
export function buildTaskHandoff(state: Workspace, taskId: string, exportedAt?: string): Promise<TaskHandoff>;
export function readTaskHandoff(text: string): Promise<TaskHandoff>;
