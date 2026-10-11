import { spawn } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { checkoutCases, encodeInput, scoreCheckout } from '../../fixtures/checkout-cases.mjs';

const bridge = fileURLToPath(new URL('./checkout-executor.mjs', import.meta.url));

function command(args, { input = '', timeoutMs = 15000, signal, limit = 262144 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [], stderr = [];
    let size = 0, stopped = false;
    // Docker proxies SIGTERM to the guest, which may ignore it. Stop the client
    // unconditionally; observe() then awaits forced container removal.
    const stop = () => { stopped = true; child.kill('SIGKILL'); };
    const timer = setTimeout(stop, timeoutMs);
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    const collect = target => data => {
      size += data.length;
      if (size > limit) { stop(); return; }
      (target === 'stdout' ? stdout : stderr).push(data);
    };
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    child.stdin.on('error', () => {});
    child.once('error', error => { clearTimeout(timer); signal?.removeEventListener('abort', stop); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      if (stopped) reject(new Error('Sandbox stopped at its time/output limit or by cancellation.'));
      else {
        try {
          const decoder = new TextDecoder('utf-8', { fatal: true });
          resolve({ stdout: decoder.decode(Buffer.concat(stdout)), stderr: decoder.decode(Buffer.concat(stderr)), exitCode: code });
        } catch { reject(new Error('Sandbox output must be valid UTF-8.')); }
      }
    });
    child.stdin.end(input);
  });
}

export class DockerChecks {
  constructor({ image, timeoutMs = 15000 }) {
    if (typeof image !== 'string' || !/^(?:sha256:[a-f0-9]{64}|[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64})$/.test(image)) throw new Error('Configure an immutable Docker image ID or digest.');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) throw new Error('Sandbox timeout must be 1000 to 60000 ms.');
    this.image = image;
    this.timeoutMs = timeoutMs;
  }

  async ready() {
    const result = await command(['image', 'inspect', this.image, '--format', '{{.Id}}']);
    if (result.exitCode !== 0 || !/^sha256:[a-f0-9]{64}$/.test(result.stdout.trim())) throw new Error('Sandbox image is unavailable. Prepare it before starting model work.');
    return result.stdout.trim();
  }

  async observe(sourcePath, { runnerPath, input = '', target = '/candidate', argv, scratch = false, signal }) {
    const source = await realpath(sourcePath);
    const runner = runnerPath ? await realpath(runnerPath) : null;
    if (source.includes(',') || runner?.includes(',')) throw new Error('Docker mount paths cannot contain commas.');
    const name = `projects-check-${crypto.randomUUID()}`;
    let result;
    try {
      result = await command(['run', '--rm', '--pull=never', '--name', name, '--network=none', '--read-only',
        '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=64', '--memory=128m', '--cpus=1',
        ...(scratch ? ['--tmpfs=/tmp:rw,nosuid,nodev,size=64m,mode=1777'] : []),
        '--user=65534:65534', `--entrypoint=${argv[0]}`, '--workdir=/candidate', '-i',
        '--mount', `type=bind,source=${source},target=${target},readonly`,
        ...(runner ? ['--mount', `type=bind,source=${runner},target=/runner.mjs,readonly`] : []),
        this.image, ...argv.slice(1)], { input, timeoutMs: this.timeoutMs, signal });
    } finally {
      const cleanup = await command(['rm', '--force', name]);
      if (cleanup.exitCode !== 0 && !cleanup.stderr.includes('No such container')) throw new Error('Sandbox cleanup failed; inspect the retained container before further work.');
    }
    return result;
  }

  async verify(modulePath, signal) {
    const stat = await lstat(modulePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 131072) throw new Error('Candidate must be a bounded regular source file.');
    const input = JSON.stringify(checkoutCases.flatMap(group => group.trials.map(trial => encodeInput(trial.input))));
    const result = await this.observe(modulePath, { runnerPath: bridge, input, target: '/candidate/checkout.mjs', argv: ['node', '/runner.mjs', '/candidate/checkout.mjs'], signal });
    const report = scoreCheckout(result.exitCode === 0 ? result.stdout : '');
    return { ...report, exitCode: report.passed === report.total ? 0 : 1,
      output: report.checks.map(check => `${check.passed ? 'PASS' : 'FAIL'} ${check.name}`).join('\n'),
      command: `isolated checkout behavior checks (${this.image})`, source: 'independent-sandbox-checks', verified: true,
      verifiedAt: new Date().toISOString() };
  }

}
