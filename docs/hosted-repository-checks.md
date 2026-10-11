# Hosted repository checks and base updates

Ordinary Artifacts projects use explicit command checks. The configured model
starter and retained pre-upgrade tasks have an explicit `checkout` profile; new
external tasks have a `commands` profile. There is no fallback to checkout tests
when ordinary verification fails. Both use the same project, task, candidate,
review and evidence views.

## Verify a candidate

After an agent submits a commit, open **Review → Configure independent checks**.
Choose commands, stdin, exact expected stdout (including newlines), and expected
exit codes independently of the agent. The hosted image includes Node and Python.
Other languages need a suitable runtime installed in the operator's pinned image;
diffs remain independent of language. There is no dependency download at check time.

`POST /api/runs/:id/checks` takes `{definition,definitionSha256}`, where `definition`
is the UTF-8 JSON string for `repository-command-checks/v1`. The shared schema and
hashing rules are in [repository verification](repository-verification.md).
The definition binds the exact head, task revision and SHA-256 of
`JSON.stringify({title,purpose,criteria,revision})` in that key order. It contains
1–12 named checks, each with `argv`, `stdin` and `expected:{exitCode,stdout}`.
The UI builds this definition and digest; the API also accepts operator-authored
definitions. The definition limit is 64 KiB; the HTTP envelope limit is 128 KiB.

`POST /api/runs/:id/verify` with `{headCommit,taskRevision}` reruns the saved
definition. A requirements change requires configuring a new definition. These
endpoints require bearer authentication and a stable `Idempotency-Key`. Reuse it
after a lost response. Completed or interrupted attempts never re-execute under
the same key. An expired attempt closes as unverified; use a new key to try again.

| Boundary | Enforcement |
| --- | --- |
| Source | Exact Artifacts commit; blob bytes checked against Git object hashes |
| Snapshot | 1–256 regular files, 1 MiB/file, 8 MiB total; no symlinks, submodules or path aliases |
| Execution | Fresh container for each check; no Git metadata, credentials or internet |
| Scoring | Worker compares exit code and exact stdout; expected results never enter the container |
| Time and output | 1–60 seconds total per definition; 64 KiB combined stdout/stderr per command |
| Concurrency | At most two verification/merge attempts per workspace |
| Cleanup | Destroy the whole instance, including descendants; DO alarm reaps interrupted attempts |
| Proof | Head, tree, requirements, definition, verifier source and image digests; input handoff digest |

The container filesystem is disposable and writable. UID/chmod is not a security
boundary with Durable Object container scheduling. A fresh instance per command
prevents one check from changing the files seen by another. Output is retained as
digests and comparison results, not raw candidate stdout. A normal failed assertion
is independently verified but failing. A runtime interruption is **unverified**.
Both retain the full declared check denominator, including commands not run.

During a recheck, the previous report stays visible and acceptance is blocked.
Earlier reports remain in history. Merge reruns the same checks and compares the
trusted proof fields. A failed or changed verifier revokes acceptance before push
and retains the new report and earlier decision. An uncertain already-started
merge stays locked for exact-head reconciliation.

## Update the base or resolve conflicts

In **Review**, use **Update to newer project code** (or the prominent panel when
main is known to have advanced). The server refreshes main before acting.

`POST /api/runs/:id/update-base` accepts `{headCommit,taskRevision,mode}` with a
stable `Idempotency-Key`:

| Mode | Result |
| --- | --- |
| `reapply` | Three-way application of the entire multi-commit candidate delta to current main in a new marked fork |
| `resolve` | New external-agent assignment on current main, linked to the original candidate and its retained diff |

Conflicts refuse reapplication before push and leave the old task base intact.
Resolution starts from current main; it does not automatically place conflict
markers or claim the conflict is solved. The agent reads the retained change in
the task handoff, implements the resolution, commits and submits it normally.

Successful updates advance the task revision, supersede old candidates and retain
their commits/reports/decisions. Applicable check definitions carry forward with
new commit and requirements digests. Results and approval never carry forward.
Fresh verification and human review are required before merge.

The coordinator reserves a fork name, marker, timestamp and push intent before
provider writes. Reapplication uses deterministic commit timestamps. A lost push
acknowledgement is recovered from the exact reserved branch; a completed replay
returns the original candidate. Main is never changed by a base update. Resolution
credentials issue once for 900 seconds; lost credentials require closing that
assignment and creating another ordinary alternative. No tokens enter snapshots,
Git remotes, handoffs, browser drafts or event logs.

## Configure and test

`wrangler.jsonc` binds `REPOSITORY_CHECKS` to `RepositoryCheckContainer`, uses
`durable_object` scheduling and a named `verifier` image built from
`containers/verification/Dockerfile`. Both Node/Python base images are digest-pinned.
The supplied image targets amd64. Wrangler resolves the resulting image to its
digest; that digest is required and recorded by the verifier. Changes to trusted
verifier code require `npm run verifier:stamp`; build/tests reject a stale stamp.

Use the provider-free fixture in [Cloudflare setup](cloudflare.md#run-a-provider-free-worker-fixture).
For full Workerd/container qualification use Linux, or WSL with current Node and
a working Docker connection. Wrangler dev exposes image tags instead of the
deployed digest-pinned map. The fixture therefore requires `FIXTURE_VERIFIER_IMAGE`
from `docker image inspect` and passes that actual immutable ID to the production
DO's runner. It changes only the image-reference source; execution, scoring,
single-attempt admission and cleanup use production code. Missing or mutable IDs
fail closed. Windows native Wrangler 4.147 rejects local container
development. To inspect the UI and verify failure handling on Windows:

```powershell
npx wrangler dev --local --enable-containers=false --config tests/runtime/wrangler.jsonc --ip 127.0.0.1 --port 8793 --persist-to qa/commands-fixture
# In another PowerShell 7 terminal:
node tests/runtime/qualify.mjs http://127.0.0.1:8793 --without-containers
```

This mode must record ordinary checks as unverified and refuse acceptance. It
does not qualify Workerd-to-container execution. Run the exact production command
observer/materializer against real Docker commands separately:

```powershell
docker build --network none -t projects-verifier-local:qa containers/verification
$env:PROJECTS_HOSTED_TEST_IMAGE = (docker image inspect projects-verifier-local:qa --format "{{.Id}}").Trim()
node --test tests/hosted-checks.test.mjs
```

The Docker test adapter is test-only; it is not another production runtime.
Live Artifacts access, hosted container availability, deployment and billing remain
unqualified. No resources were deployed or billing settings changed. Stop local
fixture servers after testing.

Current API references: [Sandbox introduction](https://developers.cloudflare.com/sandbox/get-started/),
[Durable Object container API](https://developers.cloudflare.com/containers/api/durable-object-container/),
[sandbox trust boundary](https://developers.cloudflare.com/sandbox/concepts/security/).
