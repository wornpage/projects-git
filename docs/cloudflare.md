# Cloudflare projects and agent queues

For ordinary project checks, base updates and resolution work, read [Hosted repository checks](hosted-repository-checks.md). The model starter and deployment preparation are described in [Hosted execution](hosted-execution.md). The project and external-agent API is below.

## What is implemented

The Worker serves the same `public/` dashboard and coordinates one SQLite Durable Object per configured workspace. The Durable Object persists the shared core workflow and a private repository/idempotency sidecar. The Artifacts binding supplies repository forks, commit/tree/blob inspection, and short-lived Git credentials. Local builds do not create or deploy resources.

| Capability | Behavior |
| --- | --- |
| Workspace state | SQLite snapshot with optimistic revision checks |
| Projects and task queues | One project per repository; atomic batches of 1–8 briefs; versioned admission pause |
| Agent claims | Reserve unassigned work before provider I/O; interrupted forks recover the same reservation |
| Agent isolation | Artifacts fork with a durably reserved name and ownership marker |
| Git credentials | Write token expires after 900 seconds; returned once |
| Completion | Inspect actual Git objects, the assigned branch and pinned ancestry |
| Harness reports | Candidate-supplied results remain explicitly unverified |
| Acceptance | Requires current exact-commit checks, independent review and the current authorization policy |
| Agent execution | Alarm queue, bounded edits and Git commits |
| Integration | Refresh independent checks and apply a guarded fast-forward |

Local tests and dry-run builds do not establish hosted behavior. Qualify your
own deployment, provider bindings and identity policy before relying on it.

## Configuration and local build

`wrangler.jsonc` declares `ARTIFACTS` in namespace `projects-agent-git`, `WORKSPACES`, `REPOSITORY_CHECKS`, SQLite migrations `v1`/`v2`, the named verifier container image, static assets, observability, and compatibility date `2026-10-03`. Namespace configuration does not create a remote namespace. The default explicit workspace ID is `competition`; changing it routes to another durable object.

Use Node 24.19 or newer. Wrangler must be at least 4.145.0 for the current Artifacts binding. This build uses Wrangler 4.147.0 and generated runtime types. Do not hand-edit `src/cloudflare/worker-configuration.d.ts`.

```powershell
npm run types
npm run typecheck
npm run build
node --test tests/cloudflare.test.mjs
```

Configure Cloudflare Access as described in [authenticated hosted ownership](authenticated-workspace.md). The Worker validates application assertions, pins one owner to its workspace, and authorizes service clients separately. Shared bearer-token authentication is removed. `MODEL_API_KEY` remains optional until explicitly bounded model execution is configured.

The `CURRENT_POLICY` service must target this application's Worker name and its
`WorkspacePolicy` entrypoint. Automatic integration fails closed if that private
binding is absent or unavailable. Keep exactly one version in the active
deployment; see [background authority and rollout checks](automatic-merge.md#fresh-background-authority).

The default configuration disables `workers_dev`, preview/version URLs and custom
routes. A hosted activation must
deliberately configure its protected ingress. Static assets and APIs require a
verified Access session; only minimal health is public. Health indicates
the Worker is responding, not that Artifacts or independent verification has been
qualified. Browser API access uses its Access session. Browser mutations must be
same-origin. CLI clients authenticate at Access using their own service credentials.

**A production Artifacts binding can access remote resources during local Wrangler development.** Use the local Git server (`npm run dev`) and mocked-provider tests for a build with no provider calls. Local Worker health, authentication, assets, and empty workspace reads do not call Artifacts; task/assignment/completion/review routes can. Provider operations require separately authorized activation.

## Account access preflight

Before a live repository rehearsal, check the intended account and product access
without creating resources:

```powershell
cf auth whoami
cf artifacts namespaces list --limit 20
node node_modules/wrangler/bin/wrangler.js whoami
node node_modules/wrangler/bin/wrangler.js artifacts namespaces list --json
node node_modules/wrangler/bin/wrangler.js containers list --json
```

The two CLIs have separate login profiles. Confirm they select the same account;
an authenticated login alone does not qualify either product. Artifacts currently
requires the [Workers Paid plan](https://developers.cloudflare.com/artifacts/platform/pricing/),
and hosted ordinary-project checks require
[Containers access](https://developers.cloudflare.com/containers/).

| Result | Meaning / next action |
| --- | --- |
| Artifacts authentication error | Confirm the selected account and Artifacts permissions in that CLI's existing login. |
| Artifacts `403 / 10004` | Access is denied; namespace existence and repository operations remain unverified. Resolve account eligibility or permissions before proceeding. |
| Containers reports a Workers Paid requirement | This account is not admitted to Containers. Confirm its plan or entitlement with the account owner; do not change billing as part of qualification. |
| Subscription lookup is denied | The plan is unknown through this credential; do not label it Free or Paid based on that failure. |
| Both product reads succeed | Confirm the dedicated namespace and proceed with separately authorized repository operations. This still does not prove forks, push/clone, checks, or merge. |

Keep a sanitized preflight receipt in ignored `qa/`, recording time, HTTP status,
error codes, and which operations did not run. Do not retain credentials or raw
authentication output. A CLI shutdown error is a separate failure; confirm the
API result before interpreting its exit status. Stop qualification at a denied
access gate without deploying, changing billing, or substituting fixture results
for live evidence.

## Run a provider-free Worker fixture

For command-container integration use Linux (or WSL) with current Node and a working Docker connection. Run in two terminals from the repo root:

```powershell
docker build --network none -t projects-verifier-local:qa containers/verification
$fixtureImage = (docker image inspect projects-verifier-local:qa --format "{{.Id}}").Trim()
npx wrangler dev --local --config tests/runtime/wrangler.jsonc --ip 127.0.0.1 --port 8790 --persist-to qa/worker-fixture --var "FIXTURE_VERIFIER_IMAGE:$fixtureImage"
```

```powershell
node tests/runtime/qualify.mjs http://127.0.0.1:8790
```

Generate a local RSA Access fixture with `node tests/runtime/access-fixture.mjs --prepare qa/access-fixture.private.json`. Set `PROJECTS_ACCESS_FIXTURE_KEY` for the qualifier and supply the returned public `ACCESS_TEST_JWKS` to the local Worker. This fixture uses signed test identities and never substitutes for real Access qualification. For another project in the browser, connect
`browser-starter` at base `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`.
The same UI runs against SQLite and an inert local RPC service standing in for
Artifacts. Git objects and Git credentials are synthetic; no real clone, remote
push or paid model call occurs. The command checks execute Node and Python in
real isolated containers and score results in the Worker. The separate checkout
fixture also checks 16 behaviors and refuses a forged report. On native Windows,
use the explicit [container-disabled failure test](hosted-repository-checks.md#configure-and-test);
that mode cannot prove successful container execution. Never deploy this fixture config. Press **x** in
its terminal afterward and retain SQLite data as proof. Use a fresh persistence
directory for each qualification; its accepted candidate intentionally stays unmerged.

## API flow

All JSON responses are `Cache-Control:no-store`. Inputs must be UTF-8 JSON objects.
Task-stack and check-definition requests allow 128 KiB; other requests allow 32 KiB. Artifacts uses full
lowercase 40-character SHA-1 IDs. Creation, assignments, claims, checks, rechecks, base updates and model requests
require an `Idempotency-Key` of 8–128 allowed characters. Reuse a key only for the
same request; keep it until the outcome is known. The browser persists pending
UUIDs, never authentication or Git credentials.

### 1. Connect code and queue tasks

`POST /api/tasks`:

```json
{
  "source": "repository",
  "projectName": "Customer portal",
  "repo": "customer-portal",
  "baseCommit": "FULL_LOWERCASE_40_CHARACTER_COMMIT_ID",
  "tasks": [{
    "title": "Make checkout totals trustworthy",
    "purpose": "Calculate exact integer-cent totals and reject invalid orders.",
    "owner": "Project coordinator",
    "criteria": ["Pass the independent checkout contract."]
  }]
}
```

`repo` is an existing repository name in the configured namespace, not a URL or
local path. The base must be its current default branch head. Supply 1–8 task
briefs, each with an owner and 1–12 criteria. The atomic response contains
`projectId`, `taskId`, ordered `taskIds`, `workspace` and `replayed`.
No agent or model is started. A repository can belong to only one project.

For later batches use `{source:"project",projectId,tasks}` at the same endpoint.
Queueing works while agents run or admission is paused. To recover an uncertain
browser request, `POST /api/task-requests/:uuid/release` returns its saved result
or retires its key; a late provider response cannot then publish tasks.

### 2. Claim work or prepare an alternative

`POST /api/projects/:id/claim` with `{label:"Validation agent"}` reserves the
oldest unassigned task. `POST /api/tasks/:id/agents` prepares an alternative on
a particular task. The old `/assign` route has been removed.

The result contains `projectId,taskId,runId,workspace,credentialStatus` and
`credentials:{token,expiresAt,remote,branch,baseCommit}`. Hold that response in
memory: do not log it or save it as a receipt. Clone the credential-free remote
using an ephemeral Git credential helper, check out the returned base and push
only to the assigned branch. Tokens must stay out of URLs, command arguments,
Git configuration and source files.

Scope the helper to the exact HTTPS remote. For Basic auth, return a nonempty
username and the token secret before `?expires=` as the password; keep this value
in memory and never implement the helper's persistent store action. An HTTP client
can instead send the complete token as an in-memory Bearer header. See the
[Artifacts Git protocol](https://developers.cloudflare.com/artifacts/api/git-protocol/).

The run and fork name are saved before provider I/O. Concurrent claims reserve
different tasks. An interrupted preparation recovers its own marked fork under
the same key; active leases return `OPERATION_IN_PROGRESS`. Recovery revokes
orphaned credentials before issuing 900-second Git write access. Provider errors
are never echoed or logged. Completed retries return the original run with
`credentials:null`; they do not issue another credential. Idle claims also
replay as idle; use a new key when looking for new work later.

Up to four external reservations or running model jobs occupy execution slots;
prepared model jobs can wait beyond that limit. Queued tasks have no checkout and
consume no slot. A pending merge must be reconciled before admitting more agents.
The first assignment refreshes the project default head; alternatives retain the
task's pinned base. Shared queue and policy rules live in `src/core/project-work.mjs`.

### 3. Report start, submission or failure

| Endpoint | Body | Effect |
|---|---|---|
| `POST /api/runs/:id/start` | `{}` | Records agent-reported start; respects pause |
| `POST /api/runs/:id/submit` | `{headCommit,summary,report?}` | Reads actual Git changes; revokes credentials |
| `POST /api/runs/:id/fail` | `{message}` | Closes unfinished external work; revokes credentials |

Preparing a fork creates an **assigned** run; it does not claim execution started.
Submission requires a reported start, exact assigned branch head and pinned ancestry.
Client-provided changed paths/diffs are ignored. Optional reports need individual
checks, matching passed/total counts, command, exitCode and output. They are always
`verified:false`, `source:"hosted-harness-report"`. The old `/complete` route is removed.

If credentials are lost or expire, close unfinished work and prepare another
assignment on that task. Existing code/history stays retained. An abandoned fork
preparation that never became ready can be claimed again under a new key; the
closed key cannot revive it. Other attempted work needs an explicit alternative,
so failure does not silently repeat inference.

### 4. Verify, review and merge separately

First configure ordinary project checks using `/api/runs/:id/checks` with
`{definition,definitionSha256}`. Use `/api/runs/:id/verify` with `{headCommit,taskRevision}` to rerun the pinned definition, `/review` with
`{decision,note,reviewer,headCommit,taskRevision,ownerVersion,comparisons}`, and
`/merge` with `{headCommit}`. A merge updates the project's recorded main only
after fresh checks and a confirmed Git push. Agent reports alone cannot authorize it.

`POST /api/projects/:id/policy` takes `{acceptingWork,expectedVersion}` using the
current `policyVersion`. Pausing blocks new assignments and starts; task queueing,
existing submissions, verification and review continue.

## Runtime boundaries and migration

Projects, queues, command checks and base updates use the same panels in both
adapters. Hosted commands use the operator's digest-pinned container image;
local commands use an installed immutable Docker image. Reapplication creates a
new candidate; conflicting changes receive a resolution assignment on current main.
Earlier evidence stays retained; new verification and review are mandatory. Live Artifacts access,
100/1,000-agent scale and multi-user authorization remain unqualified.

Old task-only snapshots migrate once into one project per repository, retaining IDs,
results and allowances. Pre-command-verifier tasks retain an explicit `checkout`
profile; new tasks use `commands`. A missing repository mapping or legacy in-flight fork without
a run reservation fails explicitly; finish that assignment with the previous version
before upgrading. Do not delete recovery records. Historical reviewer names remain
attribution; new hosted decisions require the pinned authenticated owner.

## Explicit prototype limits

| Bound | Value |
|---|---:|
| Task-stack request / other API requests | 128 KiB / 32 KiB |
| Tasks per batch / execution slots | 8 / 4 |
| Ancestry traversal | 256 commits |
| Trees inspected per commit | 128 |
| Tree depth | 24 |
| Tree entries per commit | 2,000 |
| Changed paths | 100 |
| Changed blob | 64 KiB |
| Total before/after changed contents | 96 KiB |
| Rendered diff | 180,000 characters |
| Harness output | 16,000 characters |
| Individual durable record (UTF-8 JSON) | 1,900,000 bytes |
| Idempotency records | Retained SQLite rows; no lifetime count cutoff or automatic deletion |

The verifier fingerprint discovers the runtime dependency closure from the Worker,
container and stamp entrypoints and includes package pins. Missing, redirected,
unbounded or unsupported imports refuse stamping. The generated identity value
is excluded from the digest but its exact source format is checked. Independent
evidence also records the separate container image and check-definition digests;
this source stamp is not a provider signature or a deployment receipt.

## Retained-work indexing (local qualification)

Durable Objects own workflow state and an atomic per-project indexing outbox.
Cloudflare Queues delivers only workspace/project identity and a source revision.
The consumer reads the authoritative records again and projects task requirements,
candidate summaries, changed filenames, exact commit/revision identities and
review notes into D1. It excludes diffs, command outputs, checkout locations,
credentials and provider receipts. Search requests require an authenticated owner
or allowlisted agent in the configured workspace and a project belonging to it.
This milestone has one human owner, not general multi-user membership.

The D1 schema is in `migrations/search/0001_retained_work.sql`. Index generations
are immutable and become visible only after all expected documents are staged.
Duplicate deliveries are safe; older generations cannot replace newer ones.
The outbox retains delivery failures and stops automatic transport attempts after
four attempts for the same source revision. Queue consumption is configured with
three retries and a dead-letter queue. A workflow update creates a newer intent.
Indexing and cleanup serialize per project. Stale deliveries cannot spend a newer
intent's retry budget. Cleanup removes obsolete generations in batches of 100,
confirming Vectorize deletion before dropping the corresponding D1 IDs. Failed
cleanup leaves those IDs and a visible error for retry. Source history is never
deleted by index cleanup.

| Route | Behavior |
| --- | --- |
| `GET /api/projects/:id/search?q=words&offset=0` | Literal all-word search, including retained requirement history; 20 results per page with total/matched denominators |
| `GET /api/projects/:id/search?mode=semantic&q=phrase` | Up to 20 scoped similarity results; no exhaustive match count; requires enabled embeddings and a ready generation |
| `GET /api/projects/:id/search-index` | Desired, delivered and indexed revisions, attempt count and sanitized error code |
| `POST /api/projects/:id/search-index` | Rebuild from authoritative records with `{ "expectedRevision": <current index revision> }`; stale guards refuse |

Search documents carry commit/revision identities, not acceptance authority.
The browser resolves each result against its loaded authoritative workspace,
labels the matched historical revision separately, and uses the existing outcome
selectors for current readiness. Similarity is a ranking score, not confidence
or verification. Refresh the candidate's current workflow state before making a
decision. Edited search controls do not change the query/mode of an existing
pagination sequence; changing index generations refuses mixed pages.

### Semantic indexing and budgets

The production configuration supplies `SEARCH_AI` and `SEARCH_VECTORS` bindings
but sets `SEARCH_EMBEDDINGS_ENABLED` to `"false"`. Enabling it is an operator action
requiring separately authorized provider use. `SEARCH_EMBEDDING_DAILY_LIMIT`
bounds new provider attempts per workspace per UTC day (default 100, valid 1–1000).
Document and query embeddings share that allowance. Duplicate cached text does
not consume another call; budget exhaustion is an explicit failure, not a switch
to different search semantics.

The fixed model is `@cf/baai/bge-base-en-v1.5`, 768 dimensions, mean pooling.
Semantic indexing uses the first 480 UTF-8 bytes of each record, preserving whole
characters. Literal search covers the full indexed text. Queries over 480 UTF-8
bytes are refused. The caller deadline is 30 seconds per embedding request.
These are bounded retrieval excerpts, not full-code embeddings or a demonstrated
retrieval-quality improvement.

Embeddings are keyed by model, pooling, project scope and excerpt. A durable
reservation precedes every provider call. Failed, interrupted and uncertain
reservations stay recorded and are never automatically regenerated. Rebuilding
an index reuses ready vectors; it does not silently reset failed reservations.
After a failed attempt, inspect the error and provider outcome before separately
authorizing any operator repair/retry. A database restore or manual deletion of
the reservation can permit another charge and must not be used as an automatic
recovery step. Ordinary queue/vector transport retries reuse cached embeddings.

Vectorize uses both a hashed workspace/project namespace and indexed metadata
filters (`scope`, `generation`). Returned IDs and metadata are checked again,
then resolved through D1 with the same workspace/project/generation. Vectorize
responses may omit their optional `namespace` echo. Scoped metadata, generation
and derived IDs remain required, and a conflicting explicit namespace is refused.
The local fixture now omits the echo to exercise that documented response shape.
Upserts must be observed through `getByIds` before that semantic generation is
marked ready; eventual visibility can temporarily return a pending status.
Every document's scope is validated before provider work. Each delivery stages
all missing batches before returning visibility-pending, so larger generations
do not consume one retry per batch. Later deliveries reuse cached embeddings.

For provider-free local qualification, use PowerShell 7 and separate terminals:

```powershell
npx wrangler d1 migrations apply SEARCH_DB --local --config tests/runtime/wrangler.jsonc --persist-to .local/retained-index-runtime
npx wrangler dev --local --config tests/runtime/wrangler.jsonc --persist-to .local/retained-index-runtime --port 8795 --inspector-port 9237 --enable-containers=false
# In a second terminal:
node tests/runtime/qualify-search.mjs http://127.0.0.1:8795
```

Stop that development server afterward. The qualifier uses synthetic Artifacts
objects and local Workerd, D1 and Queues. Embedding and vector services are explicit
deterministic local fixtures; they do not use remote AI/Vectorize bindings. The
qualifier checks authentication, scope, asynchronous indexing, exact candidate
commits, historical/current requirements, rejection retention without evidence,
acceptance refusal, fixture semantic retrieval, cached query replay and guarded
rebuilds. It also queues 64 additional tasks and walks every literal result page
before checking the larger semantic generation. The local vector fixture delays
visibility by 250 ms; the qualifier allows up to 90 seconds per indexing phase
for the production queue's 60-second retry. Allow several minutes for the whole
run. It performs no model-provider requests or
hosted resource changes. Local receipt:
`qa/retained-search-runtime.json` (not part of published source).

For an authorized hosted rollout, first back up/export the current workspace and
retain the deployed version. Provision the named D1 database and both queues,
record the actual D1 database ID in deployment configuration, and apply the D1
migration before deploying. Do not deploy these new bindings over the existing
qualified Worker without that separate authorization. A rollback to the old
single-row build requires restoring the pre-migration database, not simply
changing Worker code.

Create the proposed `projects-git-retained-v1` Vectorize index with 768 dimensions
and cosine distance, and metadata indexes `scope` (string) and `generation`
(number), before enabling semantic search. Keep model/pooling/dimensions aligned;
changing them requires a separately named index and a reviewed migration.
The [Vectorize setup guide](https://developers.cloudflare.com/vectorize/get-started/embeddings/)
and [metadata-index instructions](https://developers.cloudflare.com/vectorize/reference/metadata-filtering/)
describe resource setup. No remote resource provisioning is part of local qualification.

After applying the D1 schema, opening an existing workspace migrates its retained
records and creates initial per-project outbox entries. For backfill after D1 or
Vectorize loss, use **Evidence → Rebuild index**, or read `search-index` and POST
its exact desired `revision` as `expectedRevision`. A new immutable generation
is built from the Durable Object, including retained history, then old derived
generations are cleaned. Monitor desired/indexed revisions and errors; never
delete source records to make an index look healthy. `INDEX_CLEANUP_FAILED` can
be retried through the same guarded rebuild; failed embedding reservations
remain a separate explicitly reviewed provider-recovery boundary.

The code and local fixtures are verified separately from actual hosted Vectorize
consistency, Workers AI responses, embedding quality and production permissions.
Hosted identity and permissions are enforced through the configured Cloudflare
Access issuer, audience and owner/builder/reviewer policy. Team administration
and per-project membership are outside the current single-owner scope.

KV is intentionally omitted: current search is authenticated and changes with
task intent, while static assets already have a delivery path. No measured
read-heavy cache need justifies an additional eventually consistent store here.

## Sources

- [Artifacts Workers binding and generated types](https://developers.cloudflare.com/artifacts/api/workers-binding/)
- [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
- [Durable Objects rules](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
- [Workers Node.js crypto support](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/)
