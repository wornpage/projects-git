import type {Workspace} from './workflow.mjs';
import type {TaskHandoff} from './handoff.mjs';
export const PROJECT_ARCHIVE_FORMAT: string;
export const MAX_PROJECT_ARCHIVE_BYTES: number;
export interface ArchivedCheckPolicy {workspaceId: string; runId: string; definition: string; definitionSha256: string; image?: string}
export interface ProjectArchive {
  format: string; sha256: string;
  payload: {exportedAt: string; workspace: {id: string; name: string; version: number};
    project: {id: string; name: string; defaultBranch: string; mainCommit: string};
    current: TaskHandoff[]; history: TaskHandoff[]; checkPolicies: ArchivedCheckPolicy[]; commits: string[]; boundary: string};
}
export function archiveCommits(handoffs: TaskHandoff[], mainCommit: string): string[];
export function buildProjectArchive(state: Workspace, projectId: string, exportedAt?: string, policies?: Record<string, {definition: string; definitionSha256: string; image?: string}>): Promise<ProjectArchive>;
export function readProjectArchive(text: string, expectedSha256: string): Promise<ProjectArchive>;
