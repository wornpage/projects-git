# Trial sample repository setup

Status: source/local implementation only. This is not a provisioned or available
hosted trial. Spending remains unapproved. No signup automatically provisions a
repository, runs code, or starts an agent. The signup UI now offers explicit sample
preparation, status inspection and safe resume controls. The workspace itself
remains a read-only preview; preparing code does not enable coding workflows.

## API

Both endpoints require an active admitted human owner, with the workspace derived
from the verified identity. No email, repository name, import URL, template,
workspace selector or file contents are accepted from the client.

| Request | Contract | Result |
| --- | --- | --- |
| `GET /api/trial/sample` | No body, query or workspace header | Last confirmed local setup state; never creates or contacts Artifacts |
| `POST /api/trial/sample` | Empty JSON object, same-origin request, valid `Idempotency-Key`, matching `X-Trial-Identity` from the verified session | Prepare or explicitly resume the one supplied sample |

States are `not-started`, `preparing`, `failed`, and `ready`. A retryable failure
means the same durable intent can be inspected/resumed; there is no automatic
mutation retry. Different client keys cannot create additional samples. A fresh
success returns 201; a completed replay returns 200 without minting credentials
or reseeding. `ready` describes repository setup only; `workflowReady` stays false.

## Sample setup UI

After checking the current verified identity and active reservation, the browser
reads sample status. Signup and page load never prepare a repository automatically.

| State | Visible action and consequence |
| --- | --- |
| Not started | **Prepare sample repository** sends one empty, identity-bound POST |
| Request pending | Preparation is disabled; **Check sample status** can inspect the saved outcome |
| Outcome uncertain | Inspect status first; no prepare/resume action is offered until a fresh read |
| Preparing / retryable failure | Check status or explicitly **Resume sample setup** using the same retained request key |
| Permanent or inconsistent setup | Operator attention; no replacement or resume action |
| Unavailable | Keep the verified reservation and offer the read-only workspace preview |
| Ready | **Open sample project** links to the confirmed project; full repository and commit are in optional details |

The client validates the complete DTO, derived repository name, workspace identity,
project ID, commit and false workflow-readiness flag. Malformed and foreign results
never become a ready state. Authentication loss, identity changes, closure and
expiry clear prior sample data. Hidden/page-restored tabs use the existing single
trial client lifecycle; late responses cannot repaint another identity's sample.

The application does not automatically repeat a mutation. Network transports may
repeat requests, so the backend's one-intent rule and idempotency remain essential.
Preparing a sample and opening/cancelling closure do not extend the trial deadline.

The response contains the template ID and the owned repository/project IDs and
recorded commit where known. A `baseCommit` during incomplete setup is a reserved
or previously observed commit, not proof that a push succeeded. No tokens, remote
credentials, provider exception text or other tenants' records are returned.

## One owning path

`checkout-v1` in `src/core/trial-sample.mjs` contains four fixed UTF-8 files: a
sample README, the existing incomplete checkout starter, a package manifest and
illustrative tests. It contains no retained tasks, candidate reports, reviews or
acceptance decisions. The starter tests intentionally expose missing validation;
they are not independent verification.

The trial-derived repository name is `sample-<workspace hash>`. Setup extends the
existing `HostedController.createRepository` path. Its SQLite operation retains
the name, unique ownership marker, template/content fingerprint, repository ID,
project ID, timestamp, lease and expected commit. The initial intent is saved
before provider creation. Lost creation, token or push responses resume it after
restart. Existing or replaced repositories and unexpected branch heads are never
adopted or overwritten.

The existing Git transport makes a deterministic, non-force root commit from
bounded regular files. A sample is connected only after exact commit/branch
confirmation and complete token revocation. Initial and temporary write tokens
are never persisted or returned. The project is labelled as a trial sample and
does not accept tasks in this slice.

Admission, original owner/terms, caller session and operation ownership are
rechecked before provider creation, token minting, push and final attachment.
Closing or expiring a trial fences further setup and attachment. An external
effect already in flight can finish; its intent/known commit is retained for later
cleanup rather than represented as rolled back or deleted. Cleanup of credentials
issued by an owned attempt remains allowed after sign-out/closure.

## Configuration and local proof

The existing private application bindings and the metadata-only local config are
unchanged. Samples require the separate `TRIAL_ARTIFACTS` binding; missing it gives
`TRIAL_SAMPLE_UNAVAILABLE`, never a fallback to `ARTIFACTS`. The trial still rejects
real-owner, ordinary Artifacts, execution, model, search and subscription bindings.

`wrangler.trial-sample.template.jsonc` is an unapproved source template with a
placeholder namespace, fixture identity settings, no routes, no workers.dev or
preview URLs, and remote development disabled. It creates no resources. A later
deployment requires reviewed real resource configuration and separate approval.

Installed Miniflare 5 exposes Artifacts through a remote proxy and has no local
Artifacts emulator. Do not enable remote access to make these local tests pass.
The HTTP setup tests use simulated Artifacts metadata/token management with real
SQLite and real Git smart-HTTP on loopback. Existing native workerd tests exercise
admission/RPC and verify that sample requests without the dedicated binding fail
closed. Neither proves hosted Artifacts, email delivery or full-trial readiness.

```sh
node --test --test-concurrency=1 tests/trial-sample.test.mjs tests/repository-creation.test.mjs tests/trial-isolation.test.mjs tests/trial-runtime.test.mjs
node --test --test-concurrency=1 tests/trial-sample-ui-client.test.mjs tests/trial-sample-ui-http.test.mjs tests/trial-ui-client.test.mjs tests/trial-ui-view.test.mjs tests/trial-ui-lifecycle.test.mjs
npm run typecheck
```

Generate binding types without contacting a provider:

```sh
wrangler types --config wrangler.trial-sample.template.jsonc --env-interface TrialSampleEnv --include-runtime=false --strict-vars=false src/cloudflare/trial-sample-configuration.d.ts
```

General repository creation/discovery, Git access for external agents, assignments,
execution/checks, exports, deletion and scheduled cleanup remain unavailable.
Spending, provisioning, hosted runs and launch are separate decisions. The deleted
speed goal, private workspace, submitted video, challenge README and tag are not
changed by this work.
