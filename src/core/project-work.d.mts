import type { Workspace, Project, Task } from './workflow.mjs';
export interface TaskBrief { title: string; purpose: string; criteria: string[]; owner: string; dependsOn?: string[] }
export const MAX_QUEUED_BATCH: number;
export function taskBriefs(input: { tasks?: unknown }): TaskBrief[];
export function projectName(value: unknown): string;
export function queueProjectTasks(state: Workspace, project: Project, briefs: TaskBrief[], firstId?: string): Task[];
export function queuedTasks(state: Workspace, projectId: string): Task[];
export function eligibleQueuedTasks(state: Workspace, projectId: string): Task[];
export function queueIdle(state: Workspace, projectId: string): { idle: boolean; reason: string; waitingTaskIds: string[] };
export function bindQueuedBase(state: Workspace, task: Task, reservedRunId?: string): void;
export function requireProjectAdmission(state: Workspace, projectId: string): Project;
export function setProjectPolicy(state: Workspace, projectId: string, input: { acceptingWork?: unknown; expectedVersion?: unknown }): Project;
export function setAutomaticMergePolicy(state: Workspace, projectId: string, input: Record<string, unknown>, identity: import('./workflow.mjs').AuthenticatedIdentity): Project;
