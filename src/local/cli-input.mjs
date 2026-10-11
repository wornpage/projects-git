import { open } from 'node:fs/promises';

export function requiredOptions(args, keys, optional = []) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].slice(2);
    if (!args[i].startsWith('--') || ![...keys,...optional].includes(key) || key in options || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Use each required option once: ${keys.map(key => '--' + key).join(' ')}.`);
    options[key] = args[i + 1];
  }
  if (keys.some(key=>!(key in options))) throw new Error(`Required: ${keys.map(key => '--' + key).join(' ')}.`);
  return options;
}

export async function readBounded(path, limit, label) {
  const handle = await open(path, 'r');
  try {
    if (!(await handle.stat()).isFile()) throw new Error(`${label} must be a regular file.`);
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) throw new Error(`${label} exceeds ${limit / 1024} KiB.`);
    return buffer.subarray(0, length);
  } finally { await handle.close(); }
}

export function parseJson(bytes, label) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error(`${label} must be valid UTF-8 JSON.`); }
}
