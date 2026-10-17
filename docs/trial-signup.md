# Local trial signup UI

## Scope

Built on `f4c9c51`, the separate trial entry point now serves a no-invitation signup
flow. The UI reserves real local trial records and opens their isolated metadata
workspace. It is not deployed, and no email delivery or hosted authentication has
been qualified. [Sample repository setup](trial-sample-setup.md) is now implemented
with explicit preparation, status and recovery controls in this UI; it is not
automatically invoked by signup. Agents, checks, exports and cleanup remain
unavailable. The page states these workflow limits before and after reservation.

The existing private app, demo, challenge README, video and tag are unchanged by
the local UI work. No Cloudflare resource, login policy, credential or spend has
been provisioned or approved.

## Visitor flow

| Stage | UI behavior | Effect |
| --- | --- | --- |
| `/trial/` | Public introduction, no-signup sample link, **Continue with email** | Static content only; no admission or identity lookup |
| `/trial/signup` | Verified identity shown with actual configured duration | Cloudflare Access must verify the human before this document is served; no automatic reservation |
| Reserve | **Reserve trial**, pending state, confirmed expiry | Empty-body admission POST with idempotency key and identity precondition |
| Reserved | Clear preview label, expiry, status check and workspace link | Authenticated read-only workspace; no project or candidate is manufactured |
| Close | Modal explains lost access and retained records; **Keep trial** receives initial focus | Explicit closure POST after confirmation; cancellation returns focus to the trigger |
| Closed/expired | No renewal or open-workspace action | Retained data is not represented as deleted; public sample remains linked |
| Capacity/error | Manual availability/status check | No automatic POST retries or promise of when capacity will reopen |

Email entry and code verification belong to Cloudflare Access. There is no local
email form or fake verification endpoint in product source. A later Access rollout
must protect the signup, API and workspace destinations while allowing only the
intended landing/static paths. That configuration remains unapproved and untested.

## Identity and recovery

`GET /api/trial/session` exposes the current verified email, trial duration and a
hashed identity precondition. This hash is not a credential and grants no authority.
Both admission mutations now require `X-Trial-Identity` to match the authenticated
identity. A stale browser tab cannot reserve or close a trial for a newly signed-in
user. There is no deployed caller requiring the former header-free contract, so
the local API and fixtures use this single protocol.

The browser stores no JWT, email or reservation in persistent storage. It keeps
one idempotency key per action and identity for explicit retries. Reload recovery
uses the server's existing reservation; the backend's one-trial-per-identity rule
also prevents a new key from creating another trial or extending its expiry.

Each bootstrap/mutation has an abort signal and generation. Older responses cannot
replace a newer user's state. Identity and reservation details clear on failed or
uncertain responses, page suspension and authentication changes. Restored browser
pages recheck identity. A successful reservation schedules one read at its observed
expiry; it never treats a local timer as authoritative or automatically repeats a
mutation. Interrupted saves and closes ask the visitor to inspect status first.

Session/status JSON is bounded to 32 KiB and validated before display. Unknown
success shapes and unsupported capabilities cannot become success states. Error
text from the server is not rendered. Identity text uses text nodes, not HTML.

## Source owners

| Source | Responsibility |
| --- | --- |
| `src/cloudflare/trial-ui-assets.mjs` | Closed public asset routes, CSP, no forwarded cookies/assertions |
| `src/cloudflare/trial-worker.ts` | Verified session DTO and identity preconditions; existing admission/isolation |
| `public/trial/client.js` | HTTP contract, state, request ownership and recovery |
| `public/trial/view.js` | Accessible state views, confirmation and focus |
| `public/trial/app.js` | Page bootstrap and suspension lifecycle |
| `public/trial/styles.css` | Responsive layout and focus/touch styling |
| `public/ui/views/projects.js` | Trial-specific preview notice instead of unavailable project onboarding |

The signup HTML and scripts use one same-origin CSP with no inline scripts, remote
fonts, analytics, forms or third-party dependencies. The landing's **Explore without
signing up** link goes to the existing separate read-only sample. Private workspace
assets still require an active admission and use the existing workbench renderer.

## Local verification

```sh
node --test tests/trial-ui-client.test.mjs tests/trial-ui-view.test.mjs tests/trial-ui-http.test.mjs tests/trial-isolation.test.mjs tests/trial-runtime.test.mjs tests/repository-catalog.test.mjs
npm run typecheck
```

For a manual browser review, pass a disposable local evidence directory:

```sh
node tests/runtime/trial-ui-preview.mjs /absolute/path/to/local-qa
```

The fixture prints a loopback-only URL and uses invented signed identities. Its
control bar is injected only by the test server. Normal reservation/closure uses
the real local workerd registry and SQLite coordinators. Capacity, expiry and
unavailable-session display cases are labelled UI response fixtures. The forced
lost-response case commits locally and drops its reply; a browser may transparently
replay that transport request, which the stable key and durable reservation fence.
These cases are not hosted email, provider or independent-installation proof.

All outbound requests are intercepted with local fixture JWKS; no other destination
is permitted. Type `stop` in the fixture terminal to dispose its server/runtime and
write the QA receipt. It also stops after 20 minutes. Keep fixture controls and
invented login injection outside product assets and deployment configuration.
