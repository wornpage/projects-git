# Local trial admission and isolation

This document records the original metadata/sample-only mode, where `workflowReady`
is false. The [bounded full workflow](trial-workflow.md) extends its admission and
isolation boundary with scoped agent credentials, checks, review, merge and export.

## Implemented scope

The separate `src/cloudflare/trial-worker.ts` entry point admits authenticated
human Access identities without invitations. It reserves one durable trial per
`(issuer, subject)`, enforces global daily/active/lifetime admission limits, and
routes allowed metadata reads to separate SQLite-backed workspace coordinators.

The [signup UI](trial-signup.md) is implemented and reviewed locally. The trial is
not deployed and its email login policy is not configured. [Supplied sample setup](trial-sample-setup.md)
is implemented and checked with local provider fixtures; no Cloudflare repository
has been provisioned. [Cleanup and resource controls](trial-cleanup-controls.md) are
implemented for the supplied-sample preview and checked locally. Agent connection
and hosted execution remain unavailable. `workflowReady`
is explicitly false. All unsupported capabilities return a denial, including
repository discovery, Git access, exports, search, assignments and execution.
This stage must not be advertised as a working full-workflow trial.

## HTTP contract

Every API endpoint needs a signed human JWT for the trial-specific Access audience.
Neither a submitted email nor an unsigned header authenticates a user. A later
hosted configuration must use an identity provider/login method that actually
verifies email; these fixtures do not prove delivery or the provider's policy.

| Route | Request | Result |
| --- | --- | --- |
| `GET /api/trial/session` | No query or workspace header | Verified email, identity precondition and current duration; no enrollment |
| `POST /api/trial` | Empty JSON object; valid idempotency key and `X-Trial-Identity` precondition; same-origin browser mutation | Stable admission status; no providers or Git operations |
| `GET /api/trial` | No query or workspace header | Current identity's status, expiry and unavailable capabilities; no auto-enrollment |
| `POST /api/trial/close` | Empty JSON object; valid idempotency key and `X-Trial-Identity` precondition | Idempotent closure; denies further workspace access; does not claim deletion |
| `GET/POST /api/trial/sample` | Active admission; supplied sample contract only | Inspect or explicitly prepare/resume one fixed sample; separate trial Artifacts binding required |
| `GET /api/workspace` | Optional matching workspace precondition | The admitted identity's isolated metadata; management and execution capabilities false |
| `GET /api/projects/catalog` | Existing catalog paging contract | Only the selected identity's coordinator records |
| `GET /api/projects/:id/metrics` or `/access` | Existing project read contract | A project in that identity's workspace, or a denial |

The normal application assets require an active admission. The trial landing and
its closed static dependency list are public; the signup document needs a verified
identity but never automatically reserves a trial. This entry point does not
replace or alter the separate public read-only sample. The existing private app
retains its pinned owner and Access audience.

Missing or invalid authentication returns 401/403. A new identity without an
admission returns 404; full capacity returns 429. Closed/expired workspace access
returns 403. Unsupported trial workflow actions return 409. An unavailable
registry returns a bounded error and never selects a default workspace.

## Durable state and routing

- `TrialAdmissionStore` owns the admission policy and reservations in one bounded
  SQLite registry. Capacity checks and insertion share a synchronous transaction.
  Hashing precedes it, with a fresh identity check before the write.
- The server derives `trial-<SHA-256([issuer, subject])>`; it never routes by an
  HTTP email, body identity, client-selected role or workspace selector.
- Repeat admission, including a different request key or lost first response,
  returns the retained reservation. It never extends the lifetime. Closed and
  expired identities cannot automatically re-enroll.
- Closed/expired reservations remain in daily and total denominators. The lifetime
  row limit bounds the registry; it fails closed rather than dropping identity
  fences to make room. Policy changes require an explicit reviewed migration.
- Workspace state remains in one coordinator per derived name. The constructor
  requires the name supplied by `getByName`; missing or arbitrary names fail
  before a workspace store is initialized. The coordinator independently checks
  registry ownership and current trial policy before reading.
- Header and body workspace preconditions are checked separately. One matching
  value cannot hide another mismatching value. Trial query selectors cannot
  choose another workspace. Foreign project IDs are denied by the existing
  repository permission boundary.
- RPC errors use a closed result contract because Workers RPC does not preserve
  custom `ApiError` fields. Unknown failures expose no internal exception text.

The registry retains immutable owner subjects and first request-key hashes, not
email addresses or JWTs. These records remain sensitive identity metadata, even
when the workspace name is hashed. Retention and deletion must be settled before
public admission is enabled. Closing a reservation blocks access; it does not
delete its data or release its daily/lifetime admission count.

## Local configuration

`wrangler.trial-local.jsonc` is an isolated source/local fixture configuration,
not an approved hosted installation. It has no hostname routes, workers.dev,
preview URLs, real account identifiers, credentials, provider bindings, containers,
search/AI bindings or event services. Its Access issuer/audience are test values.
Its compatibility date is pinned to the installed local runtime's supported date.
`trial-local-configuration.d.ts` is generated from this configuration.

The trial runtime rejects a configured real workspace/owner and ordinary provider bindings.
Only sample setup may use the dedicated `TRIAL_ARTIFACTS` binding; metadata reads do not need it.
The existing `wrangler.jsonc` and private deployment configuration are unchanged.
The application HTTP validation, controller and SQLite store are reused; there
is no separate copy of the workflow or fallback to the maintainer's workspace.

## Verification

```sh
node --test tests/trial-admission.test.mjs tests/trial-isolation.test.mjs tests/trial-runtime.test.mjs
npm run typecheck
```

The tests cover concurrent signup, quotas and UTC boundaries, restart/lost
response recovery, changed request keys, expiry/closure, signed identity failures,
cross-tenant requests and foreign records, forged coordinator RPC input, registry
outage, unavailable provider paths and the existing pinned-owner application.

The runtime test uses local Miniflare 5/workerd and real SQLite DO RPC. It has
telemetry disabled, creates no provider resources, and handles every outbound
request in process with a fixture JWKS response; any other outbound URL fails the
test. The local runtime is disposed afterward. It is not a hosted workflow,
benchmark or independent Cloudflare-installation claim.

Before a hosted trial, qualify sample-resource ownership and cleanup on Cloudflare,
then implement/review execution quotas, edge abuse controls, exports and terms.
Then obtain a separate resource/configuration and spending decision. A capacity
limit is not a guaranteed dollar spending cap.
