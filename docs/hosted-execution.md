# Hosted execution and qualification

## Scope

Artifacts stores candidate code repositories. Harness context, requirements, reviews and evidence remain in coordinator SQLite; full model attempt receipts use its `attempts` table. New model-created commits no longer add `.projects/task.json`. Historical commits containing that file remain readable. The continuation dialog can export [bounded Git notes](git-notes.md) for explicit attachment and synchronization. Notes do not replace the workspace or its full project exports, and an ordinary clone is not a self-contained archive of workflow history.

## Operator setup

Use Node 24.19+, Git and `npm ci`. Builds do not deploy or create remote resources. Resource creation and deployment require separate operator authorization.

1. Authenticate Wrangler to the intended account; confirm Artifacts, Containers and Dynamic Workers access before choosing hosted features. Set the account ID in deployment configuration. This step does not authorize billing changes.
2. Create a dedicated starter repository. A missing namespace is created with the repository ([namespace documentation](https://developers.cloudflare.com/artifacts/concepts/namespaces/)):

   ```powershell
   npx wrangler artifacts repos create checkout-starter --namespace projects-agent-git --default-branch main --json
   ```

   Securely retain the returned remote and token; never commit them or paste them into logs/chat.
3. Seed a small separate repository on `main`, containing `fixtures/checkout.mjs` as root `checkout.mjs`. Push using the exact returned remote and an ephemeral Git credential mechanism. Artifacts accepts the full token in a Bearer header ([Git protocol](https://developers.cloudflare.com/artifacts/api/git-protocol/)). Keep credentials out of remote URLs, command arguments and persistent Git config; revoke bootstrap credentials afterward. Do not seed with this entire application repository.
4. In `wrangler.jsonc`, set `MODEL` to an explicit model supporting Chat Completions JSON output, `MODEL_ENDPOINT` to its HTTPS endpoint, and `MODEL_REPOSITORY` to the starter. No model or endpoint fallback exists.
5. Configure the pinned Access owner and allowlisted agent identities. Add the model API key only when model execution is intended; the authenticated workbench can deploy with inference disabled:

   ```powershell
   # Configure the pinned Access issuer, audience, owner subject and allowlisted clients.
   # Follow docs/authenticated-workspace.md; no shared control token is accepted.
   npx wrangler secret put MODEL_API_KEY
   ```

   Use ignored `.dev.vars` for local Worker secrets. Never give these secrets to generated code. Static assets and APIs require a verified Access session; minimal health remains public. Hosted reviews derive the owner's identity on the server.
6. Run tests, typecheck and dry-run build. Deploy with `npx wrangler deploy` only when authorized. Sign in through the application's Access login.

**Production Artifacts bindings can use remote resources under local Wrangler development.** The runtime test below substitutes an inert local RPC service for Artifacts and has no live provider credentials.

## Local runtime qualification

Use Linux or WSL with current Node and a working Docker connection. Run in two terminals from the repository root:

```powershell
docker build --network none -t projects-verifier-local:qa containers/verification
$fixtureImage = (docker image inspect projects-verifier-local:qa --format "{{.Id}}").Trim()
npx wrangler dev --config tests/runtime/wrangler.jsonc --local --ip 127.0.0.1 --port 8790 --persist-to qa/worker-fixture --var "FIXTURE_VERIFIER_IMAGE:$fixtureImage"
```

```powershell
node tests/runtime/qualify.mjs
```

This verifies SQLite task stacks, concurrent claims, start/submission/closure, credential exclusion, ordinary Node/Python commands and separate review. The checkout fixture scores 16/16 for correct source and 0/16 for forged reports; outbound networking is denied. Native Windows requires the explicit `--enable-containers=false`/`--without-containers` failure mode documented in [hosted checks](hosted-repository-checks.md#configure-and-test). Git objects and credentials are synthetic; no real remote push or hosted account is qualified. Use fresh persistence per qualification. The public token belongs only to this fixture. Stop its server afterward; never deploy it.

`tests/git-transport.test.mjs` exercises production Git transport against native `git http-backend`. It checks source/context commits and fast-forward merge, including a real server refusal when the target changes after advertisement but before receive-pack.

## Model allowance

`POST /api/model-runs` requires bearer authentication and a unique `Idempotency-Key`:

```json
{"candidates":2,"limits":{"maxRequests":1,"maxInputBytes":32768,"maxOutputTokens":4096,"timeoutMs":120000}}
```

This permits at most two requests and 8,192 output tokens, with 120 seconds per candidate. Input limits apply to each full conversation. Limits are not price estimates. Missing usage is unknown, not zero. Poll `GET /api/workspace` after `202 {taskId,workspace,replayed}`.

Same-key retries reuse the original task, base and allowance. The alarm runs up to four queued jobs concurrently. It marks work running and persists request reservations before inference. Interrupted running jobs are retained as failures rather than repeating inference. A pending commit is retained before push; it does not prove remote success. Internal model agents never receive Git credentials. Their commit/push/merge tokens last 180 seconds and are revoked afterward.

The browser saves an unconfirmed model-start request and its exact allowance in
the current workspace and identity's tab storage. Its inputs remain locked and
the action is labeled **Retry same model start**. Reloading restores the request
without executing it; an explicit retry sends the same ID and body. A definite
refusal of the first attempt unlocks editing. A later retry refusal keeps an
earlier uncertain request, because it does not establish that request's outcome.
If model execution becomes unavailable, the
saved request stays visible and disabled rather than turning into queued work.
Browser storage failures are reported; keep the tab open when its request ID
cannot be saved.

## Revised intent and guarded merge

| Endpoint | Body / effect |
| --- | --- |
| `POST /api/tasks/:id/revise` | `{expectedRevision,purpose,criteria,reason}`; retains history and revokes approval |
| `POST /api/runs/:id/verify` | `{headCommit,taskRevision}`; actual immutable source, then branch recheck |
| `POST /api/runs/:id/review` | `{decision,note,reviewer,headCommit,taskRevision}`; current revision and exact head |
| `POST /api/runs/:id/merge` | `{headCommit}`; separate accepted-candidate fast-forward |

Rechecking preserves the commit and spends no model allowance. It requires an Idempotency-Key. Model-starter and legacy tasks use the checkout contract; ordinary tasks require their explicit pinned command definition. Added written criteria require human review; no automatic requirement-to-test coverage is claimed.

Merge reruns checks, pins source/base, uses `force:false` and compares the advertised object ID. Git receive-pack atomically rejects a changed expected-old ID. The coordinator verifies the remote result before recording success. An uncertain push preserves a merge intent and blocks requirement changes. Retrying that merge reconciles an already-updated exact head without another push. A different head is refused; deleting the intent is not recovery.

Transport limits: 64 requests, 30 seconds, 8 MiB upload and 8 MiB download per Git operation. Receipt limit: 1.9 MB. Dynamic Workers have no bindings, outbound networking or subrequests, 1,000 ms CPU and a five-second caller deadline. Scoring stays outside the candidate environment. Existing snapshot/inspection limits are in [Cloudflare integration](cloudflare.md).

Sources: [Dynamic Worker egress](https://developers.cloudflare.com/dynamic-workers/usage/egress-control/), [DO alarms](https://developers.cloudflare.com/durable-objects/api/alarms/), [pre-push inspection](https://isomorphic-git.org/docs/en/onPrePush). The prototype keeps one workspace owner. [Repository grants](repository-access.md) restrict member reads, builders and independent reviewers; broader administration and delegated merge remain outside scope. Ordinary command execution retains its explicit image, source, time and output limits. Live multi-user qualification remains separate.
