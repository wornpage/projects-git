import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createApplication } from '../src/local/server.mjs';

test('pinned browser component and external CSS retain release integrity under the local CSP', async t => {
  const directory = new URL('../public/vendor/wornpage-button-0.2.3/', import.meta.url);
  const provenance = JSON.parse(await readFile(new URL('provenance.json', directory), 'utf8'));
  const bundle = await readFile(new URL('worn-button.js', directory));
  const css = await readFile(new URL('worn-button.css', directory));
  assert.equal(createHash('sha256').update(bundle).digest('hex'), provenance.bundleSha256);
  assert.equal(createHash('sha256').update(css).digest('hex'), provenance.cssSha256);
  // The external stylesheet must match the exact compiled styles the loader skips.
  const styles = [...bundle.toString().matchAll(/hash: "(svelte-[a-z0-9]+)",\s+code: ("(?:[^"\\]|\\.)*")/g)];
  assert.equal(styles.length, 1);
  assert.equal(styles[0][1], provenance.stylesheetId);
  assert.equal(css.toString(), JSON.parse(styles[0][2].replaceAll('\t', '\\t')) + '\n');

  const dataDir = await mkdtemp(join(tmpdir(), 'projects-git-browser-assets-'));
  const app = createApplication({ dataDir });
  t.after(async () => {
    await app.close();
    assert.ok(resolve(dataDir).startsWith(resolve(tmpdir()) + sep));
    await rm(dataDir, { recursive: true, force: true });
  });
  await app.ready;
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const htmlResponse = await fetch(url);
  assert.equal(htmlResponse.status, 200);
  assert.match(htmlResponse.headers.get('content-security-policy'), /style-src 'self';/);
  assert.doesNotMatch(htmlResponse.headers.get('content-security-policy'), /unsafe-inline/);
  const html = await htmlResponse.text();
  // Every local ES module must remain servable without a framework build step.
  const pending=['/app.js','/reviewer.js'],visited=new Set();
  while(pending.length){
    const path=pending.pop();if(visited.has(path))continue;visited.add(path);
    const response=await fetch(url+path);assert.equal(response.status,200,path);assert.match(response.headers.get('content-type'),/javascript/);
    const source=await response.text();
    if(path.startsWith('/vendor/'))continue;
    for(const match of source.matchAll(/(?:import|export)\s+(?:[^;\n]*?\s+from\s+)?["']([^"']+)["']/g)){
      const target=new URL(match[1],url+path);assert.equal(target.origin,url,'Browser imports stay local');pending.push(target.pathname);
    }
  }
  assert.ok(visited.has('/ui/review-form.js'));assert.ok(visited.has('/api-client.js'));
  assert.ok(visited.has('/browser-session.js'));assert.ok(visited.has('/ui/task-creation.js'));
  assert.ok(visited.has('/workspace-connection.js'));assert.ok(visited.has('/workbench-actions.js'));
  for(const view of ['projects','queue','work','review','evidence'])assert.ok(visited.has('/ui/views/'+view+'.js'));
  assert.ok(visited.has('/ui/error-notice.js'));
  const feedback=await fetch(url+'/action-feedback.css');assert.equal(feedback.status,200);assert.match(feedback.headers.get('content-type'),/text\/css/);
  assert.ok(html.includes(`id="${provenance.stylesheetId}" rel="stylesheet" href="/vendor/wornpage-button-0.2.3/worn-button.css"`));
  for (const [file, expected, type] of [['worn-button.js', bundle, 'javascript'], ['worn-button.css', css, 'text/css']]) {
    const response = await fetch(`${url}/vendor/wornpage-button-0.2.3/${file}`);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('content-type').includes(type));
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
  }
  assert.equal(app.snapshot().runs.length, 0, 'Serving browser assets must not create candidate work.');
});
