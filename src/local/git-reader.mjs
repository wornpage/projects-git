import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validateCommit } from '../core/workflow.mjs';

const execute = promisify(execFile);
const decoder = new TextDecoder('utf-8', { fatal: true });

/** Object-only callers must disable diff helpers and never request checkout or remote operations. */
export function readOnlyGit(repo) {
  if (typeof repo !== 'string' || !repo.trim()) throw new Error('Provide a local repository path.');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' });
  return async (args, { binary = false, input, maxBuffer = 1024 * 1024 } = {}) => {
    if (!['check-ref-format', 'rev-parse', 'merge-base', 'diff', 'ls-tree', 'cat-file'].includes(args[0])) throw new Error('Unsupported read-only Git operation.');
    let stdout;
    try {
      const operation = execute('git', ['--no-pager', ...args], { cwd: repo, env, encoding: 'buffer',
        windowsHide: true, timeout: 10000, maxBuffer });
      if (input !== undefined) { operation.child.stdin.on('error', () => {}); operation.child.stdin.end(input); }
      ({ stdout } = await operation);
    } catch {
      throw new Error(`Git ${args[0]} failed or exceeded its read limit. Confirm local objects, branch and ancestry; no remote fetch is attempted.`);
    }
    if (binary) return stdout;
    try { return decoder.decode(stdout); }
    catch { throw new Error('Git output is not valid UTF-8; capture supports text changes only.'); }
  };
}

export async function committedChange(git, base, head) {
  validateCommit(base); validateCommit(head);
  await git(['merge-base', '--is-ancestor', base, head]);
  const args = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--no-relative', '--ignore-submodules=none', '--submodule=short'];
  const names = await git([...args, '--name-only', '-z', base, head, '--']);
  const changedFiles = names ? names.slice(0, -1).split('\0') : [];
  if (!names.endsWith('\0') || !changedFiles.length || changedFiles.length > 100) throw new Error('Capture requires 1 to 100 changed paths.');
  if (changedFiles.some(path => path.trim() !== path || /[\x00-\x1f\x7f]/.test(path))) throw new Error('Changed paths with surrounding whitespace or control characters are unsupported.');
  const counts = await git([...args, '--numstat', '-z', base, head, '--']);
  if (counts.split('\0').some(line => line.startsWith('-\t-\t'))) throw new Error('Binary changes are unsupported; capture text changes only.');
  const diff = await git([...args, '--src-prefix=a/', '--dst-prefix=b/', '--unified=3', base, head, '--']);
  return { changedFiles, diff };
}
