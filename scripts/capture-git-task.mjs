import { writeFile } from 'node:fs/promises';
import { captureGitTask } from '../src/local/git-capture.mjs';
import { requiredOptions, readBounded, parseJson } from '../src/local/cli-input.mjs';

try {
  const options = requiredOptions(process.argv.slice(2), ['repo', 'base', 'branch', 'brief', 'out']);
  const brief = parseJson(await readBounded(options.brief, 16384, 'Brief'), 'Brief');
  const record = await captureGitTask({ repo: options.repo, base: options.base, branch: options.branch, brief });
  await writeFile(options.out, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ sha256: record.sha256, baseCommit: record.payload.task.baseCommit,
    headCommit: record.payload.runs[0].headCommit, changedFiles: record.payload.runs[0].changedFiles.length,
    checks: record.payload.recordedMetrics.checks, nextAction: record.payload.nextAction.kind }));
} catch (error) {
  // Filesystem errors can include private paths. Git diagnostics are already sanitized.
  console.error(error?.code ? `Capture failed (${error.code}); no existing output is overwritten.` : error instanceof Error ? error.message : 'Capture failed.');
  process.exitCode = 1;
}
