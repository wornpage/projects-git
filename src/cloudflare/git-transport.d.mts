export interface GitCredential { remote: string; token: string }
export interface ArtifactContext { taskId: string; runId: string; revision: number; purpose: string; criteria: string[]; baseCommit: string }
export class ArtifactGit {
  constructor(options?: { fetchImpl?: typeof fetch });
  reapply(input: GitCredential & { defaultBranch: string; branch: string; candidateRemote: string; candidateToken: string; candidateBranch: string; baseCommit: string; headCommit: string; currentBase: string; timestamp?: number; beforePush: (head: string) => Promise<void> }): Promise<string>;
  commitCandidate(input: GitCredential & { defaultBranch: string; branch: string; baseCommit: string; files: { path: string; content: string }[]; context: ArtifactContext; beforePush: (head: string) => Promise<void> }): Promise<string>;
  merge(input: GitCredential & { defaultBranch: string; candidateRemote: string; candidateToken: string; candidateBranch: string; baseCommit: string; headCommit: string; beforePush: () => Promise<void> }): Promise<string>;
}
export function gitHttp(credentials: GitCredential[], options?: { fetchImpl?: typeof fetch; timeoutMs?: number; maxBytes?: number }): import('isomorphic-git').HttpClient;
