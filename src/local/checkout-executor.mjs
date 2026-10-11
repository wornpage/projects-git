// This bridge runs in an untrusted container. It receives inputs, never expected results.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const inputs = JSON.parse(readFileSync(0, 'utf8'));
function decode(value) {
  if (value && typeof value === 'object' && Object.keys(value).length === 1 && '$special' in value) {
    return { undefined: undefined, NaN: NaN, Infinity: Infinity }[value.$special];
  }
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, decode(entry)]));
  return value;
}
function freezeInput(value) {
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) freezeInput(entry);
    Object.freeze(value);
  }
  return value;
}
// Freeze before loading candidate code so it cannot replace these intrinsics.
const argumentsList = inputs.map(input => freezeInput(decode(input)));
const { checkoutTotal } = await import(pathToFileURL(process.argv[2]).href);
const responses = argumentsList.map(input => {
  try {
    const result = checkoutTotal(input);
    return { threw: false, value: typeof result === 'number' && Number.isFinite(result) ? result : null };
  } catch { return { threw: true }; }
});
process.stdout.write(JSON.stringify(responses));
