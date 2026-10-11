import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
const {Miniflare,convertV4MiniflareOptions,Response}=createRequire(new URL('../node_modules/wrangler/package.json',import.meta.url))('miniflare');

test('the default subscription transport invokes native Workers fetch with its proper receiver',async t=>{
  const source=`import {CloudflareSubscriptions} from './src/cloudflare/subscription-provider.ts';
    import {subscriptionPlan} from './src/cloudflare/artifact-subscriptions.ts';
    export default {async fetch(){
      const scope={accountId:'1'.repeat(32),namespace:'fixture',queueId:'2'.repeat(32),workspaceId:'fixture',ownerKey:'3'.repeat(64)};
      const provider=new CloudflareSubscriptions(scope,'inert-qualification-token');
      return Response.json(await provider.find(subscriptionPlan({...scope,repositoryName:'owned'})));
    }};`;
  const bundle=await build({stdin:{contents:source,resolveDir:fileURLToPath(new URL('../',import.meta.url)),sourcefile:'native-fetch-fixture.mjs'},bundle:true,write:false,format:'esm',platform:'neutral',target:'es2022',external:['node:crypto']});
  let requests=0;
  const runtime=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-08',compatibilityFlags:['nodejs_compat'],
    outboundService:async request=>{
      requests++;const url=new URL(request.url);assert.equal(url.origin,'https://api.cloudflare.com');
      assert.equal(request.method,'GET');assert.equal(request.headers.get('Authorization'),'Bearer inert-qualification-token');
      return Response.json({success:true,result:[],result_info:{total_pages:1}});
    }}));
  t.after(()=>runtime.dispose());
  const response=await runtime.dispatchFetch('http://localhost/');assert.equal(response.status,200);assert.deepEqual(await response.json(),[]);assert.equal(requests,1);
});
