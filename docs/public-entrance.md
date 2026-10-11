# Public entrance, private working workspace

## Visitor journey

The entrance explains who Projects Git is for and what remains after an agent
writes code. Visitors can explore a fictional checkout project in the existing
workbench, including a retained failure, independent review and separate owner
and merge records. Every example is labelled. No agent, check or Git operation
runs; the example never connects to a working workspace API.

The separate **Sign in to workspace** action enters `/workspace/`. Cloudflare
Access and the Worker's JWT validation continue to determine the principal and
workspace permissions. There is no public signup or automatic owner enrollment.

The source configuration keeps the public entrance disabled. The optional
entrance can be evaluated locally without changing a hosted Access policy.

| Route | Intended audience | Worker behavior when enabled |
| --- | --- | --- |
| `/` | Everyone | Product introduction; no live data |
| `/entrance/styles.css` | Everyone | The entrance stylesheet only |
| `/demo/` | Everyone | Labelled fictional read-only workbench |
| `/demo/assets/<approved file>` | Everyone | Exact closed dependency allowlist |
| `/workspace`, `/workspace/*` | Authorized Access identities | Verify identity before serving any page or asset |
| `/api/*` | Authorized Access identities | Existing identity and resource checks; `/api/health` remains a non-sensitive health response |
| `/?view=…`, `/index.html?view=…` | Legacy working links | Redirect to `/workspace/?view=…`; no records are read |
| `/reviewer.html` | Legacy reviewer link | Redirect to `/workspace/reviewer`; no records are read |

All non-read methods on public routes return **405**. Public responses use
`connect-src 'none'`, `form-action 'none'`, `no-store` and no cookies. JWTs,
credentials and incoming cookies never reach the public asset binding.
Workspace storage, providers and Git credentials are unavailable to the public
handler: it receives only the static asset binding.

## Local review

```powershell
npm ci
npm run dev:entrance
```

Open **http://127.0.0.1:8908/**. This local Worker has only static assets; private
workspace links show a 401 preview notice rather than pretending to perform an
Access login. The working app is not connected to this preview.

```powershell
node --test tests/public-entrance.test.mjs tests/access-http.test.mjs tests/demo.test.mjs
npm run typecheck
npm run build:entrance
```

The demo asset allowlist comes from the workbench's actual closed import graph.
`scripts/entrance-assets.mjs` checks it; intentional changes must be reviewed and
regenerated with `--write`. HTML, source maps, the reviewer UI, proof records,
configuration, repository links and videos are excluded from the public surface.

## Optional operator configuration

Enabling a public entrance is a separate operator decision. Keep the working
workspace behind Access and verify all protected paths before enabling public
routes on your own deployment.

1. After owner authorization, record the currently deployed source/configuration, Access application ID,
   audience, exact destinations and owner/service/reviewer policies. The source
   configuration is a proposal, not proof of current account state.
2. Preserve the existing Access application and its audience. Prepare protected
   destinations for `git.example.com/workspace` and
   `git.example.com/api`. Access path inheritance covers their children;
   **query strings cannot separate the public and private app**. Do not create a
   replacement identity application or expand the existing principal allowlist.
3. Deploy the reviewed source with the entrance flag still off, retaining all
   live workspace bindings and variables. Verify the private baseline first.
4. Enable the reviewed entrance and open only the intended public surface at
   Access. Ensure the more-specific `/workspace` and `/api` rules still apply.
   Keep workers.dev and preview/version URLs disabled. Never use a hostname-wide
   anonymous bypass without the protected destinations and Worker checks.
5. Check anonymous entrance/demo navigation, all approved assets, read-only
   denials, private Access redirects and direct Worker rejection without an
   assertion. Check a real owner and reviewer session on the new private paths;
   no live task, review or merge is needed to verify this routing change.
6. Record exact source, public asset hashes, Access audience/policies, observed
   responses and the rollback source/configuration. Local JWT fixtures do not
   establish live Access behavior.

Rollback: restore the recorded hostname-wide Access protection first; then turn
the entrance flag off and restore the previous deployment if required. Restoring
Access is separate from reverting a Worker version. Keep retained workspace data and credentials private throughout.

Current references: [Access application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/),
[JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/),
[Worker-first assets](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/).
