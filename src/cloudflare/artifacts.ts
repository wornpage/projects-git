import { ApiError, commitId } from "./security.ts";
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { portablePath } from '../core/snapshot-path.mjs';

export interface SnapshotFile { name: string; base64: string; mode: '100644' | '100755'; oid: string }
export interface ArtifactSnapshot { commit: string; tree: string; files: SnapshotFile[] }

export async function exactCommit(repo: ArtifactsRepo, hash: string): Promise<ArtifactsCommitMetadata> {
  commitId(hash);
  const commit = await repo.readCommit(hash);
  if (!commit || commit.hash !== hash) throw new ApiError(422, "COMMIT_NOT_FOUND", "The exact commit does not exist in this repository.");
  return commit;
}

export async function branchHead(repo: ArtifactsRepo, branch: string, expected: string): Promise<void> {
  // The Artifacts binding resolves branch names, including names with slashes.
  const latest = await repo.log({ ref: branch, limit: 1 });
  if (latest[0]?.hash !== expected) throw new ApiError(409, "STALE_HEAD", "The reported commit must be the current assigned branch head.");
}

async function requireAncestor(repo: ArtifactsRepo, base: string, head: ArtifactsCommitMetadata): Promise<void> {
  const pending = [...head.parents];
  const visited = new Set<string>();
  while (pending.length) {
    const hash = pending.shift()!;
    if (hash === base) return;
    if (visited.has(hash)) continue;
    visited.add(hash);
    if (visited.size > 256) throw new ApiError(422, "HISTORY_LIMIT", "Commit ancestry exceeds the 256-commit review limit.");
    const commit = await exactCommit(repo, hash);
    pending.push(...commit.parents);
  }
  throw new ApiError(422, "UNRELATED_COMMIT", "The submitted commit must descend from the pinned task base.");
}

async function files(repo: ArtifactsRepo, treeHash: string): Promise<Map<string, ArtifactsTreeEntry>> {
  const result = new Map<string, ArtifactsTreeEntry>();
  const pending = [{ hash: treeHash, prefix: "", depth: 0 }];
  let trees = 0;
  let entries = 0;
  while (pending.length) {
    const next = pending.pop()!;
    if (++trees > 128 || next.depth > 24) throw new ApiError(422, "TREE_LIMIT", "Repository tree exceeds the bounded review limit.");
    const children = await repo.readTree(next.hash);
    if (!children) throw new ApiError(422, "TREE_NOT_FOUND", "A required Git tree is missing.");
    entries += children.length;
    if (entries > 2_000) throw new ApiError(422, "TREE_LIMIT", "Repository trees are limited to 2,000 entries for this prototype.");
    for (const child of children) {
      if (!child.name || child.name === "." || child.name === ".." || /[\\/\u0000-\u001f\u007f]/.test(child.name)) {
        throw new ApiError(422, "INVALID_GIT_PATH", "Git paths contain unsupported characters.");
      }
      const path = next.prefix + child.name;
      if (path.length > 500) throw new ApiError(422, "INVALID_GIT_PATH", "Git paths are limited to 500 characters.");
      if (child.type === "tree") pending.push({ hash: child.hash, prefix: path + "/", depth: next.depth + 1 });
      else {
        if (result.has(path)) throw new ApiError(422, 'INVALID_GIT_PATH', 'A Git tree contains duplicate paths.');
        result.set(path, child);
      }
    }
  }
  return result;
}

/** Materialize bounded immutable Git blobs; never clone credentials into a verifier. */
export async function readArtifactSnapshot(repo: ArtifactsRepo, head: string): Promise<ArtifactSnapshot> {
  const commit = await exactCommit(repo, head), entries = await files(repo, commit.treeHash);
  if (!entries.size || entries.size > 256) throw new ApiError(422, 'SNAPSHOT_LIMIT', 'Verification requires 1 to 256 committed regular files.');
  const seen = new Map<string, string>(), output: SnapshotFile[] = [];
  let total = 0;
  for (const [name, entry] of entries) {
    if (!portablePath(name) || entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) throw new ApiError(422, 'UNSUPPORTED_SNAPSHOT', 'Verification requires portable regular files; symlinks and submodules are unsupported.');
    const parts = name.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const spelling = parts.slice(0, i).join('/'), key = spelling.toLowerCase();
      if (seen.has(key) && seen.get(key) !== spelling || i < parts.length && entries.has(spelling)) throw new ApiError(422, 'UNSUPPORTED_SNAPSHOT', 'File paths collide in the verification snapshot.');
      seen.set(key, spelling);
    }
    const blob = await repo.readBlob(entry.hash);
    if (!blob) throw new ApiError(422, 'BLOB_NOT_FOUND', 'A committed file is missing.');
    total += blob.size;
    if (blob.size > 1048576 || total > 8388608) throw new ApiError(422, 'SNAPSHOT_LIMIT', 'Verification source is limited to 1 MiB per file and 8 MiB total.');
    const bytes = Buffer.from(await blob.arrayBuffer());
    if (createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== entry.hash) throw new ApiError(422, 'BLOB_HASH_MISMATCH', 'A provider blob does not match the committed Git object.');
    output.push({ name, base64: bytes.toString('base64'), mode: entry.mode as SnapshotFile['mode'], oid: entry.hash });
  }
  return { commit: head, tree: commit.treeHash, files: output };
}

async function content(repo: ArtifactsRepo, entry: ArtifactsTreeEntry | undefined, budget: { bytes: number }): Promise<string | null> {
  if (!entry) return "";
  if (entry.type === "gitlink") return `Submodule commit ${entry.hash}\n`;
  const blob = await repo.readBlob(entry.hash);
  if (!blob) throw new ApiError(422, "BLOB_NOT_FOUND", "A changed Git blob is missing.");
  budget.bytes += blob.size;
  if (blob.size > 65_536 || budget.bytes > 98_304) throw new ApiError(422, "DIFF_LIMIT", "Changed file contents exceed the 96 KiB review limit (64 KiB per file).");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.includes(0)) return null;
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes); }
  catch { return null; }
}

function diffLines(contents: string, prefix: string): string {
  if (!contents) return "";
  const lines = contents.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line) => prefix + line + "\n").join("");
}

/** Read immutable Git objects; the client never supplies changed paths or diff text. */
export async function inspectResult(repo: ArtifactsRepo, baseHash: string, headHash: string, branch: string): Promise<{ changedFiles: string[]; diff: string }> {
  if (baseHash === headHash) throw new ApiError(422, "EMPTY_CHANGE", "Submit a new commit with changes.");
  await branchHead(repo, branch, headHash);
  const base = await exactCommit(repo, baseHash);
  const head = await exactCommit(repo, headHash);
  await requireAncestor(repo, baseHash, head);
  const [before, after] = await Promise.all([files(repo, base.treeHash), files(repo, head.treeHash)]);
  const changedFiles = [...new Set([...before.keys(), ...after.keys()])].sort().filter((path) => {
    const a = before.get(path);
    const b = after.get(path);
    return a?.hash !== b?.hash || a?.mode !== b?.mode;
  });
  if (!changedFiles.length || changedFiles.length > 100) throw new ApiError(422, "CHANGE_LIMIT", "A result must change between 1 and 100 paths.");
  const budget = { bytes: 0 };
  let diff = "";
  for (const path of changedFiles) {
    const oldEntry = before.get(path);
    const newEntry = after.get(path);
    const oldText = await content(repo, oldEntry, budget);
    const newText = await content(repo, newEntry, budget);
    diff += `diff --git a/${path} b/${path}\n`;
    if (oldEntry?.mode !== newEntry?.mode) diff += `mode ${oldEntry?.mode ?? "absent"} -> ${newEntry?.mode ?? "absent"}\n`;
    if (oldText === null || newText === null) diff += "Binary or non-UTF-8 content changed; text preview unavailable.\n";
    else {
      const oldLines = oldText ? oldText.split("\n").length - Number(oldText.endsWith("\n")) : 0;
      const newLines = newText ? newText.split("\n").length - Number(newText.endsWith("\n")) : 0;
      diff += `--- ${oldEntry ? "a/" + path : "/dev/null"}\n+++ ${newEntry ? "b/" + path : "/dev/null"}\n@@ -${oldLines ? 1 : 0},${oldLines} +${newLines ? 1 : 0},${newLines} @@\n`;
      diff += diffLines(oldText, "-") + diffLines(newText, "+");
    }
    if (diff.length > 180_000) throw new ApiError(422, "DIFF_LIMIT", "The rendered diff exceeds 180,000 characters.");
  }
  await branchHead(repo, branch, headHash);
  return { changedFiles, diff };
}

export function safeRemote(remote: string): string {
  const url = new URL(remote);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new ApiError(502, "UNSAFE_REMOTE", "Provider returned an unsupported repository URL.");
  }
  return url.href;
}
