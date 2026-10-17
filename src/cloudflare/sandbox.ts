import { checkoutCases, encodeInput, scoreCheckout } from '../../fixtures/checkout-cases.mjs';
import type { Evidence } from '../core/workflow.mjs';

const bridge = `
// Capture the trusted output path before guest module evaluation. No guest-
// mutable serializer, iterator or prototype method observes the result rows.
const NativeResponse = Response;
const finite = Number.isFinite;
const defineProperty = Object.defineProperty;
const noThen = Object.freeze(Object.assign(Object.create(null), {value: undefined}));
function decode(value) {
  if (value && typeof value === 'object' && Object.keys(value).length === 1 && '$special' in value) return { undefined: undefined, NaN: NaN, Infinity: Infinity }[value.$special];
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, decode(entry)]));
  return value;
}
function freeze(value) { if (value && typeof value === 'object') { for (const entry of Object.values(value)) freeze(entry); Object.freeze(value); } return value; }
export default { async fetch(request) {
  const inputs = (await request.json()).map(input => freeze(decode(input)));
  const { checkoutTotal } = await import('./candidate.mjs');
  let output = '[';
  for (let index = 0; index < inputs.length; index++) {
    if (index) output += ',';
    try {
      const value = checkoutTotal(inputs[index]);
      output += '{"threw":false,"value":' + (typeof value === 'number' && finite(value) ? value : 'null') + '}';
    } catch { output += '{"threw":true}'; }
  }
  const response = new NativeResponse(output + ']');
  // Async return must not invoke a guest-installed inherited thenable hook.
  defineProperty(response, 'then', noThen);
  return response;
} };`;

export class WorkerChecks {
  private loader: WorkerLoader;
  constructor(loader: WorkerLoader) { this.loader = loader; }

  async verify(source: string, commit: string, signal?: AbortSignal): Promise<Evidence> {
    if (new TextEncoder().encode(source).byteLength > 65536) throw new Error('Candidate source exceeds 64 KiB.');
    const worker = this.loader.load({ compatibilityDate: '2026-10-03', mainModule: 'runner.mjs',
      modules: { 'runner.mjs': { js: bridge }, 'candidate.mjs': { js: source } }, env: {}, globalOutbound: null,
      limits: { cpuMs: 1000, subRequests: 0 } });
    const stop = signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000);
    let output = '';
    try {
      const response = await worker.getEntrypoint().fetch('https://checks.invalid/', { method: 'POST', signal: stop,
        body: JSON.stringify(checkoutCases.flatMap(group => group.trials.map((trial: { input: unknown }) => encodeInput(trial.input)))) });
      if (!response.ok || !response.body) throw new Error('Candidate execution failed.');
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
      let bytes = 0;
      try {
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          bytes += item.value.byteLength;
          if (bytes > 65536) throw new Error('Candidate output exceeds 64 KiB.');
          output += decoder.decode(item.value, { stream: true });
        }
        output += decoder.decode();
      } finally { await reader.cancel(); }
    } catch {
      if (signal?.aborted) signal.throwIfAborted();
      // An execution/format failure is retained as failed checks, never as a pass report.
      output = '';
    }
    const result = scoreCheckout(output);
    return { ...result, verified: true, commit, source: 'independent-sandbox-checks',
      command: 'Cloudflare isolated checkout behavior checks; network disabled',
      exitCode: result.passed === result.total ? 0 : 1,
      output: result.checks.map(check => `${check.passed ? 'PASS' : 'FAIL'} ${check.name}`).join('\n'),
      verifiedAt: new Date().toISOString() };
  }
}
