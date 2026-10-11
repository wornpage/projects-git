import { readFile, stat } from 'node:fs/promises';
import { readTaskHandoff, MAX_HANDOFF_BYTES } from '../src/core/handoff.mjs';

try {
  const [path, ...extra] = process.argv.slice(2);
  if (!path || extra.length) throw new Error('Usage: node scripts/inspect-handoff.mjs <handoff.json>');
  if ((await stat(path)).size > MAX_HANDOFF_BYTES) throw new Error('Handoff exceeds 2 MiB.');
  const data = await readFile(path);
  const record = await readTaskHandoff(new TextDecoder('utf-8', { fatal: true }).decode(data));
  const { task, runs, recordedMetrics, nextAction, boundaries } = record.payload;
  console.log(JSON.stringify({ integrity: 'matches included checksum; not authenticated', sha256: record.sha256,
    task: { id: task.id, title: task.title, revision: task.revision, baseCommit: task.baseCommit, mergedCommit: task.mergedCommit },
    candidates: runs.map(run => ({ id: run.id, origin: run.origin ?? 'workspace-run', headCommit: run.headCommit, changedFileCount: run.changedFiles.length, status: run.status, evidenceRevision: run.evidence?.taskRevision ?? null,
      ...(run.evidence?.verification ? { verification: run.evidence.verification } : {}) })),
    recordedMetrics, nextAction, boundaries }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Could not inspect handoff.');
  process.exitCode = 1;
}
