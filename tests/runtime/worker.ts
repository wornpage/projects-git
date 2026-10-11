import worker, { createAuthenticatedFetch } from '../../src/cloudflare/index.ts';
import {AccessVerifier, accessPolicy} from '../../src/cloudflare/access.ts';
import { WorkerChecks } from '../../src/cloudflare/sandbox.ts';
import { RepositoryCheckContainer as HostedCheckContainer } from '../../src/cloudflare/check-container.ts';
export { WorkspaceCoordinator } from '../../src/cloudflare/index.ts';
export { ArtifactsFixture, ArtifactsFixtureStore } from './artifacts-fixture.ts';
export { SearchFixture, SearchFixtureStore } from './search-fixture.ts';

// Wrangler dev exposes mutable image tags, unlike the deployed named-image map.
// Pin the real locally built image ID explicitly. All execution, alarms and
// one-attempt admission use the production DO implementation unchanged.
export class RepositoryCheckContainer extends HostedCheckContainer {
  protected verificationImage(): string {
    const image = (this.env as Env & { FIXTURE_VERIFIER_IMAGE?: string }).FIXTURE_VERIFIER_IMAGE;
    if (!image || !/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Set FIXTURE_VERIFIER_IMAGE to the actual locally built Docker image ID.');
    return image;
  }
}

// Local-only harness: Artifacts is an inert service fixture, never a live binding.
export default {
  queue: worker.queue,
  async fetch(request: Request, env: Env) {
    const url=new URL(request.url);
    if(!['127.0.0.1','localhost','::1'].includes(url.hostname))return new Response('Local fixture only',{status:403});
    const fixture=env as Env & {ACCESS_TEST_JWKS?:string};
    const verifier=new AccessVerifier(async target=>{
      if(String(target)!==env.ACCESS_TEAM_DOMAIN+'/cdn-cgi/access/certs'||!fixture.ACCESS_TEST_JWKS)throw new Error('Local fixture signing keys not configured');
      return Response.json(JSON.parse(fixture.ACCESS_TEST_JWKS));
    });
    if (url.pathname !== '/verify-fixture') return createAuthenticatedFetch(verifier)(request, env);
    const principal=await verifier.authenticate(request,accessPolicy(env));
    if(principal.kind!=='owner')return new Response('Owner fixture required',{status:403});
    if (request.method !== 'POST') return Response.json({ fixture: true, providerCalls: 0 });
    const data = await request.json() as { source: string };
    return Response.json(await new WorkerChecks(env.LOADER).verify(data.source, 'a'.repeat(40)));
  },
};
