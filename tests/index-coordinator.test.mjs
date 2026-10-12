import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const { transformSync } = createRequire(new URL('../node_modules/wrangler/package.json', import.meta.url))('esbuild');

// Execute the production DO methods under Node with only platform imports
// substituted. Workerd qualification separately exercises real DO/D1/Queues.
function coordinator() {
  const file = new URL('../src/cloudflare/index.ts', import.meta.url);
  const require = createRequire(file), module = { exports: {} };
  const compiled = transformSync(readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
  const state = { cleanup: async () => false };
  function load(name) {
    if (name === 'cloudflare:workers') return { DurableObject: class {}, WorkerEntrypoint: class {} };
    if (name === './check-container.ts') return { RepositoryCheckContainer: class {} };
    if (name === './search-index.ts') return { RetainedIndex: class { cleanup(...args) { return state.cleanup(...args); } } };
    return require(name);
  }
  new Function('require', 'module', 'exports', compiled)(load, module, module.exports);
  const instance = Object.create(module.exports.WorkspaceCoordinator.prototype);
  instance.indexWork = new Map();
  instance.env = { WORKSPACE_ID: 'workspace', SEARCH_DB: {} };
  return { instance, state };
}

test('indexing and cleanup for one project serialize across awaits and failures do not poison the chain', async () => {
  const { instance } = coordinator();
  const events = []; let release;
  const blocked = new Promise(resolve => { release = resolve; });
  instance.performIndexProject = async (_, revision) => {
    events.push('start-' + revision);
    if (revision === 1) { await blocked; events.push('cleanup-1'); throw new Error('Retained failure'); }
    events.push('cleanup-' + revision);
  };
  const first = instance.indexProject('project', 1, false);
  const failed = assert.rejects(first, /Retained failure/);
  const second = instance.indexProject('project', 2, false);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['start-1']);
  release(); await failed; await second;
  assert.deepEqual(events, ['start-1', 'cleanup-1', 'start-2', 'cleanup-2']);
  assert.equal(instance.indexWork.size, 0);
});

test('an exhausted stale delivery cannot consume a newer intent retry budget or start indexing', async () => {
  const { instance } = coordinator();
  instance.store = {
    indexState: () => ({ revision: 2, indexed_revision: 0, attempts: 0 }),
    read: () => assert.fail('Stale message read newer workflow data'),
    indexFailure: () => assert.fail('Stale message charged a newer intent'),
  };
  await instance.indexProject('project', 1, true);
});

test('an event-held index cannot reach document, vector or embedding work even with an exact queued revision',async()=>{
  const {instance}=coordinator();instance.store={indexState:()=>({revision:2,automatic:0}),read:()=>assert.fail('Held event index spent work'),indexFailure:()=>assert.fail('Held event index spent a retry')};
  await instance.indexProject('project',2,false);
});

test('cleanup continuation uses the project intent revision, not the newer global snapshot generation', async () => {
  const { instance, state } = coordinator();
  state.cleanup = async () => true;
  const messages = [];
  instance.env.SEARCH_JOBS = { send: async message => { messages.push(message); } };
  instance.store = { indexState: () => ({ revision: 10, indexed_revision: 11 }), cleanupFailure: (_, failed) => assert.equal(failed, false) };
  await instance.indexProject('project', 10, false);
  assert.deepEqual(messages, [{ workspaceId: 'workspace', projectId: 'project', revision: 10 }]);
});
