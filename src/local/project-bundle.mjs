import {mkdir, readFile, writeFile, lstat, realpath} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {RepositoryRunner} from './repository-runner.mjs';
import {readProjectArchive, MAX_PROJECT_ARCHIVE_BYTES} from '../core/project-archive.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
const MAX_STAGED_OBJECTS = 16_384;
const refuse = message => { throw Error('Project bundle: ' + message); };
function refs(archive) {
  const main = 'refs/heads/' + archive.payload.project.defaultBranch;
  const primary = 'refs/heads/projects-archive';
  const collision = archive.payload.commits.some(hash => {
    const retained = primary + '/' + hash;
    return retained === main && hash !== archive.payload.project.mainCommit
      || retained.startsWith(main + '/') || main.startsWith(retained + '/');
  });
  // Choose one disjoint namespace only when the primary layout would lose main
  // or create a file/directory conflict. Existing valid v1 layouts stay identical.
  const namespace = collision ? primary + '-retained' : primary;
  return new Map([[main, archive.payload.project.mainCommit], ...archive.payload.commits.map(hash => [namespace + '/' + hash, hash])]);
}
async function boundedFile(directory, name, limit) {
  const file = path.join(directory, name), stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit || await realpath(file) !== file) refuse('Invalid or oversized ' + name);
  const bytes = await readFile(file);
  if (bytes.length > limit) refuse('File grew beyond its limit.');
  return bytes;
}
async function freshDirectory(directory) {
  const result = path.resolve(directory);
  await mkdir(result); // Never overwrite an earlier export, restore or failed attempt.
  if (await realpath(result) !== result) refuse('Destination must not be redirected.');
  return result;
}

/** Operator-only local export. Sources are explicit local repositories, never URLs. */
export async function writeProjectBundle({archive, expectedArchiveSha256, sources, directory}) {
  archive = await readProjectArchive(JSON.stringify(archive), expectedArchiveSha256);
  const root = await freshDirectory(directory), runner = new RepositoryRunner(root);
  await runner.initialize();
  const git = args => runner.git(root, args);
  await git(['check-ref-format', 'refs/heads/' + archive.payload.project.defaultBranch]);
  const repository = path.join(root, 'objects.git');
  await mkdir(repository); await runner.git(repository, ['init', '--bare']);
  const objectBudget = {remainingBytes: MAX_BUNDLE_BYTES, remainingObjects: MAX_STAGED_OBJECTS, seen: new Set()};
  for (const hash of archive.payload.commits) {
    const source = sources[hash];
    if (typeof source !== 'string' || !path.isAbsolute(source)) refuse('Every referenced commit needs an explicit absolute local source.');
    await runner.copyCommit(source, repository, hash, {boundary: '0'.repeat(40), objectBudget});
  }
  for (const [ref,hash] of refs(archive)) await runner.git(repository, ['update-ref', ref, hash, '0'.repeat(40)]);
  await runner.git(repository, ['symbolic-ref', 'HEAD', 'refs/heads/' + archive.payload.project.defaultBranch]);
  await runner.git(repository, ['fsck', '--strict', '--full']);
  // Bound Git's output while it is produced; an oversized stream never becomes
  // a partial package on disk. The staging budget is independent of compression.
  const bytes = await runner.git(repository, ['bundle', 'create', '-', '--all'], undefined, [], {binary: true, maxBuffer: MAX_BUNDLE_BYTES});
  await writeFile(path.join(root, 'project.bundle'), bytes, {flag: 'wx'});
  const archiveBytes = JSON.stringify(archive);
  await writeFile(path.join(root, 'project.json'), archiveBytes, {flag: 'wx'});
  const manifest = {format: 'projects-git-bundle/v1', archiveSha256: archive.sha256, bundleSha256: digest(bytes),
    bundleBytes: bytes.length, refs: Object.fromEntries(refs(archive))};
  const manifestBytes = JSON.stringify(manifest);
  await writeFile(path.join(root, 'manifest.json'), manifestBytes, {flag: 'wx'});
  return {directory: root, manifestSha256: digest(manifestBytes), archiveSha256: archive.sha256, bundleSha256: manifest.bundleSha256,
    commits: archive.payload.commits.length, bundleBytes: bytes.length};
}

/** Restore Git and read-only history offline. Never installs imported checks or acceptance. */
export async function restoreProjectBundle({directory, destination, expectedManifestSha256}) {
  const root = path.resolve(directory);
  if (await realpath(root) !== root) refuse('Archive directory must not be redirected.');
  const manifestBytes = await boundedFile(root, 'manifest.json', 64 * 1024);
  if (!/^[a-f0-9]{64}$/.test(expectedManifestSha256) || digest(manifestBytes) !== expectedManifestSha256) refuse('Manifest digest mismatch.');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (Object.keys(manifest).sort().join(',') !== 'archiveSha256,bundleBytes,bundleSha256,format,refs' || manifest.format !== 'projects-git-bundle/v1') refuse('Unsupported manifest.');
  const archive = await readProjectArchive((await boundedFile(root, 'project.json', MAX_PROJECT_ARCHIVE_BYTES)).toString('utf8'), manifest.archiveSha256);
  const bundle = await boundedFile(root, 'project.bundle', MAX_BUNDLE_BYTES);
  if (digest(bundle) !== manifest.bundleSha256 || bundle.length !== manifest.bundleBytes) refuse('Git bundle digest mismatch.');
  const expectedRefs = Object.fromEntries(refs(archive));
  if (JSON.stringify(manifest.refs) !== JSON.stringify(expectedRefs)) refuse('Git references differ from the archive.');
  const restored = await freshDirectory(destination), runner = new RepositoryRunner(restored);
  await runner.initialize();
  const git = args => runner.git(restored, args);
  await git(['init', '--bare']);
  await git(['check-ref-format', 'refs/heads/' + archive.payload.project.defaultBranch]);
  const bundlePath = path.join(restored, 'project.bundle');
  // Git consumes the exact bytes already checked, not a reread of the supplied package.
  await writeFile(bundlePath, bundle, {flag: 'wx'});
  await git(['bundle', 'verify', bundlePath]);
  const actualRefs = (await git(['bundle', 'list-heads', bundlePath])).split('\n').map(line => line.split(' ')).filter(([,ref]) => ref !== 'HEAD');
  if (actualRefs.length !== Object.keys(expectedRefs).length || actualRefs.some(([hash,ref]) => expectedRefs[ref] !== hash)) refuse('Unexpected Git bundle references.');
  await git(['bundle', 'unbundle', bundlePath]);
  for (const [ref, hash] of Object.entries(expectedRefs)) {
    await git(['cat-file', '-e', hash + '^{commit}']);
    await git(['update-ref', ref, hash, '0'.repeat(40)]);
  }
  await git(['symbolic-ref', 'HEAD', 'refs/heads/' + archive.payload.project.defaultBranch]);
  await git(['fsck', '--strict', '--full']);
  if (await git(['rev-parse', 'HEAD']) !== archive.payload.project.mainCommit) refuse('Restored main differs.');
  await writeFile(path.join(restored, 'project-history.json'), JSON.stringify(archive), {flag: 'wx'});
  return {directory: restored, mainCommit: archive.payload.project.mainCommit, commits: archive.payload.commits.length,
    archiveSha256: archive.sha256, manifestSha256: expectedManifestSha256, historical: true};
}
