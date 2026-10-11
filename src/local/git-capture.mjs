import { readOnlyGit, committedChange } from './git-reader.mjs';
import { createWorkspace, createTask, recordGitCandidate, validateCommit } from '../core/workflow.mjs';
import { buildTaskHandoff } from '../core/handoff.mjs';

/** Read committed objects only. Never run repository code, hooks, textconv or external diff. */
export async function captureGitTask({ repo, base, branch, brief }) {
  validateCommit(base);
  const git = readOnlyGit(repo);
  if (typeof branch !== 'string' || branch.length > 250 || branch.trim() !== branch || branch.startsWith('-')) throw new Error('Provide an explicit local branch name.');
  if (!brief || Array.isArray(brief) || Object.keys(brief).sort().join(',') !== 'criteria,purpose,title') throw new Error('Brief must contain exactly title, purpose and criteria.');
  const state = createWorkspace({ name: 'Captured Git change' });
  const task = createTask(state, { ...brief, baseCommit: base });
  if ((await git(['check-ref-format', '--branch', branch])).trim() !== branch) throw new Error('Branch shorthand is unsupported; use an explicit local branch name.');
  if ((await git(['rev-parse', '--verify', `${base}^{commit}`])).trim() !== base) throw new Error('Base must identify a commit object.');
  const ref = `refs/heads/${branch}`;
  const head = validateCommit((await git(['rev-parse', '--verify', ref])).trim());
  const { changedFiles, diff } = await committedChange(git, base, head);
  recordGitCandidate(state, task.id, { branch, headCommit: head, changedFiles, diff,
    summary: 'Captured committed Git change only. Working-tree changes, execution, checks and authorship were not recorded.' });
  if ((await git(['rev-parse', '--verify', ref])).trim() !== head) throw new Error('Branch moved during capture; retry against a stable branch.');
  return buildTaskHandoff(state, task.id);
}
