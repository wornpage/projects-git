# Self-service trial workflow

## Status and boundary

The bounded workflow is implemented and tested locally with real Git, SQLite and
workerd checks. Local Artifacts management and signed identities are fixtures;
hosted qualification is recorded separately below. Local tests alone do not prove
hosted signup, email delivery, billing, or live isolation.

`wrangler.trial-workflow.template.jsonc` is a non-public, unapproved template.
Its placeholder issuer, audience and namespace must never be deployed as a live
trial. Existing private workspace Access and the read-only public demo are separate.

## Visitor flow

The public entry is `https://git-demo.projectsdemo.org/`. **Start trial** opens
`https://try-git.projectsdemo.org/trial/`, where visitors can read the introduction
without signing in. **Continue with email** opens the separately protected
`/trial/signup` route. The trial API, workspace and existing private workspace
remain authenticated; browsing the introduction does not reserve a trial.

1. Sign in through a dedicated Cloudflare Access application and admit one trial.
2. Prepare the supplied checkout project and starter task.
3. Open Project settings and download separate coding-agent and reviewer connections.
4. Run `node scripts/trial-agent-mcp.mjs --connection <absolute-private-file.json>`
   from an installed source checkout. Bring your own coding tool and model account.
5. Claim and start the task, read its source, publish the bounded implementation,
   and submit the exact commit. No repository credential is given to the agent.
6. Run checks, assign independent review, decide acceptance, then merge. Each
   step retains its own evidence and authority; passing checks alone never merges.
7. Export source snapshots and retained history before the retention deadline.
   Closing ends access immediately and schedules cleanup.

Connection secrets are returned once, kept out of browser persistence, scoped to
one role and workspace, and expire within one hour or the trial's earlier expiry.
Replacing a connection revokes its predecessor. A lost response is reconciled with
the same key; it does not silently create a new credential.

## Explicit limits

| Measure | Limit and meaning |
| --- | --- |
| Admission template | 2 new trials per UTC day, 5 active, 10 lifetime; 7-day duration |
| Work per trial | 1 supplied project, 10 retained tasks, 10 candidate runs, 1 active run |
| Source | Only `checkout.mjs`, at most 32 KiB; no arbitrary imports or custom check execution |
| History | 100 retained operations, 4 MiB metadata; failures remain counted |
| Provider work | Explicit approved quota required, at most 600 reserved operations per trial |
| Checks | 20 per trial lifetime and 20 globally per UTC day; merge verification also counts |
| Execution | Fixed checkout checks, 1,000 ms CPU, no outbound requests or supplied bindings |
| Exports | 3 attempts per trial, including failures; at most 11 bounded source snapshots |
| Cleanup | 6 attempts, at most 32 provider operations each; unknown outcomes stay pending/blocked |
| Model funding | No operator-funded model calls |

These are application limits, **not a guaranteed dollar billing cap**. Export and
cleanup use their separate bounded allowances. Inbound traffic, retention and
account/Access charges require operator assessment. The source template has no
monetary approval and no enabled new-resource allowance.

## Launch requirements

Use a dedicated Artifacts namespace, trial registry/coordinator and trial-only
check loader. Configure a dedicated Access app with a real audience and email
login; the agent bearer route needs an explicitly scoped edge exception, while
the Worker still verifies its trial credential. Never weaken private workspace
Access. Configure bounded resource approval and edge abuse controls before opening
traffic. Verify actual hosted signup, two-user isolation, check limits, revocation,
export and cleanup before describing the hosted trial as ready.

On 2026-10-17, the Wrangler credential could not administer Access (HTTP 403 /
code 1010). The authenticated dashboard subsequently created a separate trial
application with no allow policy, and the trial Worker was deployed behind it.
The pilot permits 2 new trials per day and 5 total, with 5 active at most;
the private workspace's Access, deployed version and bindings were preserved.
The owner approved activation: email-PIN signup is enabled at
`https://try-git.projectsdemo.org/trial/signup`. The introduction and its static
assets are public. `/agent/api/*` uses application authentication instead of browser
login; the Worker requires a valid role/workspace-scoped trial token and
rejects anonymous or invalid credentials. Real email login, trial reservation,
sample repository/task creation, and connection issuance/revocation have been
verified on the deployed pilot. A manually implemented qualification candidate was
claimed through the scoped agent API, published as a real Git commit, submitted,
and passed all 16 hosted checkout checks.

The same qualification trial then completed an independent review of exact
candidate `c0f9e553544f8d926829a0da468fc911dfc2e550`, owner acceptance and a guarded
merge with another 16/16 hosted checks. The reviewer credential was also denied
owner merge authority. Its downloaded source/history export passed digest, blob
and Git tree verification; the exported checkout code passed all 16 local cases.
The export contains source snapshots and retained history, not a Git object database.

The owner closed this trial at `2026-10-17T07:57:17.932Z`, after saving the export.
Owner workspace/export access and reviewer access then returned `TRIAL_CLOSED`.
Cleanup becomes due at `2026-10-18T07:57:17.932Z`; deletion is not yet confirmed.
A follow-up is scheduled for October 18 at 9 a.m. America/New_York to inspect
the cleanup receipt and credential removal. Multi-user hosted isolation and
final app-source review remain separate from this single-trial qualification.

## Local validation

`node --test --test-concurrency=1 "tests/trial-*.test.mjs"` exercises admission,
authority, budgets, local runtime, source publication, scoped credentials, owner
decisions, independent review, real merge, export, expiry and cleanup. The full
workflow test runs the production checkout checks in local workerd.

For browser QA, run `node tests/runtime/trial-sample-ui-preview.mjs <evidence-dir>
--workflow`. This loopback fixture visibly labels invented identities and simulated
Artifacts. It creates no hosted resources. Type `stop` to dispose it.
