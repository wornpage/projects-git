import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('the default Worker configuration cannot reopen public ingress or enable paid embeddings', () => {
  const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.equal(config.workers_dev, false, 'A later deploy must preserve the requested public shutdown.');
  assert.equal(config.preview_urls, false, 'Preview/version URLs must remain disabled too.');
  assert.deepEqual(config.routes, [], 'No custom route is admitted by default.');
  assert.equal(config.route, undefined);
  assert.equal(config.vars.SEARCH_EMBEDDINGS_ENABLED, 'false', 'Embedding activation needs separate authorization.');
});

test('the registration service has no public ingress, repository bindings or committed account credential',()=>{
  const config=JSON.parse(readFileSync(new URL('../wrangler.subscriptions.jsonc',import.meta.url),'utf8'));
  assert.equal(config.workers_dev,false);assert.equal(config.preview_urls,false);assert.deepEqual(config.routes,[]);
  assert.equal(config.vars.SUBSCRIPTIONS_API_TOKEN,undefined);
  for(const name of ['artifacts','assets','durable_objects','containers','services'])assert.equal(config[name],undefined);
  const app=JSON.parse(readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
  assert.equal(app.vars.ARTIFACTS_EVENTS_AUTOMATIC,'false');
  assert.deepEqual(app.services.find(binding=>binding.binding==='EVENT_SUBSCRIPTIONS'),{binding:'EVENT_SUBSCRIPTIONS',service:config.name,entrypoint:'ArtifactSubscriptionService'});
});
