import { open, unlink } from 'node:fs/promises';
import { MAX_HANDOFF_BYTES } from '../src/core/handoff.mjs';
import { requiredOptions, readBounded } from '../src/local/cli-input.mjs';
import { verifyRepositoryHandoff } from '../src/local/repository-checks.mjs';

let output, outputPath, written = false;
try {
  const options = requiredOptions(process.argv.slice(2), ['repo', 'handoff', 'checks', 'checks-sha256', 'image', 'out']);
  const input = await readBounded(options.handoff, MAX_HANDOFF_BYTES, 'Handoff');
  const definitionBytes = await readBounded(options.checks, 65536, 'Check definition');
  let handoffText;
  try { handoffText = new TextDecoder('utf-8', { fatal: true }).decode(input); }
  catch { throw new Error('Handoff must be valid UTF-8.'); }
  // Reserve a new output before starting containers. Existing receipts are never overwritten.
  output = await open(options.out, 'wx'); outputPath = options.out;
  const record = await verifyRepositoryHandoff({ repo: options.repo, handoffText, definitionBytes, definitionSha256: options['checks-sha256'], image: options.image });
  await output.writeFile(JSON.stringify(record, null, 2) + '\n'); written = true;
  const evidence = record.payload.runs[0].evidence;
  console.log(JSON.stringify({ sha256: record.sha256, commit: evidence.commit, revision: evidence.taskRevision,
    checks: record.payload.recordedMetrics.checks, nextAction: record.payload.nextAction, verification: evidence.verification }));
  if (!evidence.verified || evidence.exitCode !== 0) process.exitCode = 1;
} catch (error) {
  console.error(error?.code ? `Verification failed (${error.code}); existing receipts were not replaced.` : error instanceof Error ? error.message : 'Verification failed.');
  process.exitCode = 1;
} finally {
  await output?.close();
  if (outputPath && !written) await unlink(outputPath);
}
