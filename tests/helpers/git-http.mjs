import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn,execFile} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {ArtifactGit} from '../../src/cloudflare/git-transport.mjs';
const exec=promisify(execFile);

export async function gitHttpFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'projects-git-http-'));
  let server;
  t.after(async()=>{
    if(server?.listening){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir())+path.sep));await rm(root,{recursive:true,force:true});
  });
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' };
  const git = async (cwd, ...args) => (await exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd, env, windowsHide: true })).stdout.trim();
  const work = path.join(root, 'seed'); await mkdir(work);
  await git(root, 'init', '--bare', '--initial-branch=main', 'source.git');
  await git(work, 'init', '--initial-branch=main');
  await writeFile(path.join(work, 'checkout.mjs'), await readFile(new URL('../../fixtures/checkout.mjs',import.meta.url)));
  await git(work, 'add', 'checkout.mjs'); await git(work, 'commit', '-m', 'Seed');
  await git(work, 'push', path.join(root, 'source.git'), 'main');
  await git(root, 'clone', '--bare', 'source.git', 'fork.git');
  await git(path.join(root, 'source.git'), 'config', 'http.receivepack', 'true');
  await git(path.join(root, 'fork.git'), 'config', 'http.receivepack', 'true');
  const baseCommit = await git(work, 'rev-parse', 'HEAD');
  const received = [];
  let beforeReceive = async () => {};
  server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      received.push({ path: url.pathname, token: request.headers.authorization });
      if (url.pathname === '/source.git/git-receive-pack') await beforeReceive();
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const child = spawn('git', ['http-backend'], { env: { ...env, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1', REQUEST_METHOD: request.method,
        PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), CONTENT_TYPE: request.headers['content-type'] ?? '', CONTENT_LENGTH: String(body.length), REMOTE_USER: 'qa' }, windowsHide: true });
      const outputs = []; let diagnostic = '';
      child.stdout.on('data', data => outputs.push(data)); child.stderr.on('data', data => { diagnostic += data; });
      child.stdin.end(body);
      const [code] = await once(child, 'close');
      if (code !== 0) throw new Error(diagnostic);
      const result = Buffer.concat(outputs), separator = result.indexOf('\r\n\r\n');
      if (separator < 0) throw new Error('Git CGI headers missing');
      const headers = Object.fromEntries(result.subarray(0, separator).toString().split('\r\n').map(line => { const colon = line.indexOf(':'); return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()]; }));
      const status = Number(headers.status?.split(' ')[0] ?? 200); delete headers.status;
      response.writeHead(status, headers); response.end(result.subarray(separator + 4));
    } catch (error) { response.writeHead(500); response.end(error.message); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port;
  const transport = new ArtifactGit({ fetchImpl: (url, options) => fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, options) });
  const candidate = { remote: 'https://git.example.test/fork.git', token: 'fork-write-token', defaultBranch: 'main', branch: 'agents/one', baseCommit,
    files: [{ path: 'checkout.mjs', content: 'export const checkoutTotal = items => 42;\n' }],
    context: { taskId: 'task', runId: 'run', revision: 2 }, beforePush: async () => {} };
  const merge = headCommit => ({ remote: 'https://git.example.test/source.git', token: 'target-write-token', defaultBranch: 'main',
    candidateRemote: candidate.remote, candidateToken: 'candidate-read-token', candidateBranch: candidate.branch, baseCommit, headCommit, beforePush: async () => {} });
  return { root, work, git, transport, candidate, merge, baseCommit, received, interceptReceive: hook => { beforeReceive = hook; } };
}
