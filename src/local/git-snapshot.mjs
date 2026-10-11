import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validateCommit } from '../core/workflow.mjs';
import { readOnlyGit } from './git-reader.mjs';
import { portablePath } from '../core/snapshot-path.mjs';

/** Materialize only committed regular blobs into a newly created private directory; no Git checkout. */
export async function readSnapshotEntries(repo, commit) {
  validateCommit(commit);
  const git = readOnlyGit(repo);
  if ((await git(['rev-parse', '--verify', `${commit}^{commit}`])).trim() !== commit) throw new Error('Candidate must identify a commit object.');
  const tree = validateCommit((await git(['rev-parse', '--verify', `${commit}^{tree}`])).trim());
  const listing = await git(['ls-tree', '-r', '-l', '-z', commit]);
  const entries = listing.split('\0').filter(Boolean).map(line => {
    const match = /^([0-7]{6}) (blob|commit) ([a-f0-9]+) +([0-9]+|-)\t([\s\S]+)$/.exec(line);
    if (!match || !['100644', '100755'].includes(match[1]) || match[2] !== 'blob' || !portablePath(match[5])) throw new Error('Snapshot requires portable regular file paths; symlinks and submodules are unsupported.');
    return { oid: validateCommit(match[3]), size: Number(match[4]), name: match[5] };
  });
  if (!entries.length || entries.length > 256 || entries.some(entry => entry.size > 1048576) || entries.reduce((sum, entry) => sum + entry.size, 0) > 8388608) throw new Error('Snapshot exceeds 256 files, 1 MiB per file or 8 MiB total.');
  const seen = new Map();
  for (const entry of entries) {
    const parts = entry.name.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const spelling = parts.slice(0, i).join('/'), key = spelling.toLowerCase();
      if (seen.has(key) && seen.get(key) !== spelling) throw new Error('Case-colliding paths are unsupported.');
      seen.set(key, spelling);
    }
  }
  return { tree, entries };
}

export async function snapshotCommit(repo, commit, destination) {
  const { tree, entries } = await readSnapshotEntries(repo, commit);
  const git = readOnlyGit(repo);
  await mkdir(destination); // Caller supplies a fresh child of its private temporary directory.
  const root = path.resolve(destination);
  const deadline = Date.now() + 30000;
  for (const entry of entries) {
    if (Date.now() > deadline) throw new Error('Snapshot exceeded its 30-second read allowance.');
    const target = path.resolve(root, entry.name);
    if (!target.startsWith(root + path.sep)) throw new Error('Snapshot path escaped its directory.');
    const data = await git(['cat-file', 'blob', entry.oid], { binary: true });
    if (data.length !== entry.size) throw new Error('Git blob size changed during snapshot.');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data, { flag: 'wx', mode: 0o644 });
  }
  return tree;
}
