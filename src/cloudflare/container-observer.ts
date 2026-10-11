import type { SnapshotFile } from './artifacts.ts';
import { portablePath } from '../core/snapshot-path.mjs';
import { Buffer } from 'node:buffer';

export interface CommandObservation { exitCode: number; stdout: string; image: string }
export const MATERIALIZE = `const fs=require('node:fs');let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{const files=JSON.parse(input);fs.mkdirSync('/project');for(const file of files){const name='/project/'+file.name;fs.mkdirSync(require('node:path').dirname(name),{recursive:true});fs.writeFileSync(name,Buffer.from(file.base64,'base64'),{flag:'wx',mode:file.mode==='100755'?0o755:0o644});}});`;

function validateFiles(files: SnapshotFile[]) {
  if (!Array.isArray(files) || !files.length || files.length > 256) throw new Error('Invalid verification snapshot.');
  const names = new Set<string>(); let bytes = 0;
  for (const file of files) {
    if (!portablePath(file.name) || names.has(file.name.toLowerCase()) || !['100644', '100755'].includes(file.mode)) throw new Error('Invalid verification snapshot path.');
    names.add(file.name.toLowerCase());
    if (typeof file.base64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.base64)) throw new Error('Invalid verification file encoding.');
    const size = Buffer.byteLength(file.base64, 'base64'); bytes += size;
    if (size > 1048576 || bytes > 8388608) throw new Error('Verification snapshot exceeds its byte allowance.');
  }
}

async function readBounded(stream: ReadableStream | null, budget: { remaining: number }): Promise<string> {
  if (!stream) return '';
  const reader = stream.getReader(), decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }); let text = '';
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      budget.remaining -= next.value.byteLength;
      if (budget.remaining < 0) throw new Error('Command output exceeds 64 KiB.');
      text += decoder.decode(next.value, { stream: true });
    }
    return text + decoder.decode();
  } finally { await reader.cancel().catch(() => {}); }
}

/** One container per check, no credentials/network, whole-instance cleanup on every exit. */
export async function observeContainer(container: Container, image: string, files: SnapshotFile[], argv: string[], input: string, timeoutMs: number): Promise<CommandObservation> {
  validateFiles(files);
  if (!image || !/(?:@|^)sha256:[a-f0-9]{64}$/.test(image)) throw new Error('The configured verification image must be digest-pinned.');
  if (!Array.isArray(argv) || !argv.length || argv.length > 32 || argv.some(value => typeof value !== 'string' || value.length > 8192 || value.includes('\0'))
    || typeof input !== 'string' || input.length > 16384 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('Invalid bounded command.');
  if (container.running) throw new Error('Verification requires a fresh container.');
  let timer: ReturnType<typeof setTimeout> | undefined, expired = false;
  let cleanup: Promise<void> | undefined;
  const stop = () => cleanup ??= container.destroy();
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { expired = true; reject(new Error('Verification time allowance exhausted.')); void stop().catch(() => {}); }, timeoutMs);
  });
  try {
    container.start({ image, enableInternet: false, entrypoint: ['sleep', 'infinity'], env: {}, instance: 'lite' });
    const work = async () => {
      const setup = await container.exec(['/usr/local/bin/node', '-e', MATERIALIZE], { env: {}, stdin: new Blob([JSON.stringify(files)]).stream() });
      const setupOutput = await Promise.all([setup.exitCode, readBounded(setup.stdout, { remaining: 1024 }), readBounded(setup.stderr, { remaining: 8192 })]);
      if (setupOutput[0] !== 0 || expired) throw new Error('Verification snapshot preparation failed.');
      const process = await container.exec(argv, { cwd: '/project', env: { HOME: '/tmp', TMPDIR: '/tmp' }, stdin: new Blob([input]).stream() });
      const budget = { remaining: 65536 };
      const [exitCode, stdout] = await Promise.all([process.exitCode, readBounded(process.stdout, budget), readBounded(process.stderr, budget)]);
      if (expired) throw new Error('Verification time allowance exhausted.');
      return { exitCode, stdout, image };
    };
    return await Promise.race([work(), deadline]);
  } finally {
    clearTimeout(timer);
    // Killing only the direct child can leave descendants alive. Destroy the VM.
    await stop();
  }
}
