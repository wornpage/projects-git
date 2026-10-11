# Artifacts push events

The working Worker can consume `cf.artifacts.repo.pushed` notifications from a
dedicated Cloudflare Queue. Repository observations are separate from
authenticated agent submissions, independent checks, owner acceptance and merge.
The public read-only demo has no event, repository or workspace binding.

## What a push does

The queue checks its channel, account, namespace, subscription, repository and
event schema before calling the configured workspace. The coordinator requires
its enrolled owner binding, records the delivery and read attempt in SQLite, and
awaits disk confirmation before reading Artifacts.

It reconciles the **live branch head**, rather than treating the event's `after`
hash or timestamp as the latest truth. A pushed assignment displays **New push
observed**. Execution stays assigned/running until the authenticated agent submits
or fails it. A changed submitted branch blocks checks-based acceptance and
independent review; an unmerged owner decision is moved into history. A changed
project main requires a candidate-base update. Historical merges remain history.

The consumer does not infer an actor from Git author text, issue credentials,
create forks, run models/checks or write Git. The four execution slots and two
concurrent verification attempts remain independently enforced. An observation
marks the affected history index stale and pauses its automatic delivery without
spending the retry budget. The owner can explicitly rebuild that index, or a later
authenticated workflow change can renew normal indexing. Old queued jobs cannot
spend an embedding budget on an event-held index.

## Configure an owned repository subscription

Use the [Cloudflare event-subscription guide](https://developers.cloudflare.com/artifacts/guides/event-subscriptions/)
and the [subscription management guide](https://developers.cloudflare.com/queues/event-subscriptions/manage-event-subscriptions/).
Provision the dedicated queue and its dead-letter queue, subscribe the intended
Artifacts repository's push events, and record the provider-returned subscription
ID. Configure these values together:

| Setting | Meaning |
| --- | --- |
| `ARTIFACTS_EVENTS_ACCOUNT_ID` | Exact account supplying the notifications |
| `ARTIFACTS_EVENTS_NAMESPACE` | Exact namespace of this Worker's `ARTIFACTS` binding |
| `ARTIFACTS_EVENTS_QUEUE` | Dedicated queue name; match the consumer configuration |
| `ARTIFACTS_EVENTS_SUBSCRIPTIONS` | JSON array of `{ "id": "provider-subscription-id", "repositoryName": "owned-repo" }` |
| `WORKSPACE_ID` | Workspace with the configured, explicitly enrolled owner |

Missing configuration fails closed. Subscription setup stays outside agent
credentials and outside request bodies. Existing operator-pinned subscriptions
remain valid and are never silently replaced. The existing indexing queue
continues to consume its own schema.

## Automatic registration for new projects and forks

The optional private `ArtifactSubscriptionService` manages repository-scoped
`pushed` subscriptions. Deploy it with `wrangler.subscriptions.jsonc` and bind its
named entrypoint as `EVENT_SUBSCRIPTIONS`. Its HTTP handler always returns 404;
workers.dev, preview URLs and routes remain disabled. It has no Artifacts, Git,
Access, model or workspace binding. Store a token with **Queues Write** for the
one configured account as its `SUBSCRIPTIONS_API_TOKEN` secret. The application
Worker and agent clients never receive that token. Cloudflare's
[subscription API](https://developers.cloudflare.com/api/resources/queues/subresources/subscriptions/methods/create/)
currently accepts Queues Write or Workers Scripts Write; this service needs only
the former.

| Application setting | Registration service setting |
| --- | --- |
| `ARTIFACTS_EVENTS_ACCOUNT_ID` | `SUBSCRIPTIONS_ACCOUNT_ID` |
| `ARTIFACTS_EVENTS_NAMESPACE` | `SUBSCRIPTIONS_NAMESPACE` |
| `ARTIFACTS_EVENTS_QUEUE_ID` (provider queue ID) | `SUBSCRIPTIONS_QUEUE_ID` |
| `WORKSPACE_ID` | `SUBSCRIPTIONS_WORKSPACE_ID` |
| SHA-256 of the canonical `ownerBinding(accessPolicy(env))` JSON | `SUBSCRIPTIONS_OWNER_KEY` |

Set `ARTIFACTS_EVENTS_AUTOMATIC` to `true` only after configuring that private
service and the dedicated Queue consumer. Its default is `false`. With automatic
registration enabled, `ARTIFACTS_EVENTS_SUBSCRIPTIONS` may be an empty array or
retain existing operator-pinned subscriptions. The Queue boundary checks the
account, namespace and event schema; the coordinator additionally requires an
exact operator-pinned or durably registered subscription/repository pair before
recording any event or reading Git.

Connecting or restoring a project retains ownership before registering its
repository. Creating an assignment or base-update fork retains the reservation
and verifies the fork marker before registration. Git credentials are withheld
until registration is confirmed. A failed registration leaves the project,
tasks, reservation and Git fork intact. Retrying the original operation key
reconciles those same objects, with no inference or duplicate fork requested by
the registration service.

The SQLite ledger stores the workspace, owner hash, account, namespace, queue,
repository and deterministic subscription name before provider I/O. It records
each attempt separately:

| State | Next action |
| --- | --- |
| Reserved | Look up the exact name; create a disabled subscription if absent. |
| Creating | Creation may have occurred. Read the provider inventory; never repeat an uncertain POST. |
| Bound | Subscription ID is durable and admitted by the consumer. Enable that exact ID. |
| Ready | Enabling was confirmed; duplicate requests reuse this result. |

A confirmed rejected create can be retried. An uncertain create with no visible
provider result remains unresolved; it needs later reconciliation or operator
investigation, rather than another POST. Lost enable responses recover through
GET and an idempotent PATCH. Ambiguous matches, changed owner/queue configuration,
redirects, oversized inventory and mismatched provider records fail closed. A
new attempt fences late callbacks from an interrupted attempt. The ledger keeps
all failed and superseded attempts, with limits of 128 repositories and 4,096
attempts. It never retains API response messages or secrets.

`artifactSubscriptions` in the workspace response reports registered repositories,
confirmed-ready subscriptions, repositories awaiting recovery and total retained
attempts. These counts cover automatic registrations; configured manual
subscriptions remain separately listed in deployment configuration.

Local qualification uses `tests/runtime/prepare-subscription-local.mjs` and
`tests/runtime/qualify-subscriptions.mjs`. The fault entrypoints exist only in the
qualification Worker and are exposed through a private service binding. Its
loopback driver is never an application deployment entrypoint. These fixtures
simulate identity and provider APIs; real hosted registration requires separate
source-bound qualification.

## Delivery and recovery

Repeated payloads reuse the same durable observation; a changed payload under
the same delivery ID conflicts. Completion is acknowledged after persistence.
Receipts retain pending, failed, superseded and completed read attempts. A newer
attempt and workspace revision fence a delayed callback. Recovery may repeat a
read; it cannot replay a model or Git write because this consumer performs none.

If workflow commit succeeds before receipt completion, replay finds the retained
timeline key and completes the receipt without another observation. Pending
verification, merge, assignment or base-update operations defer observation;
queue retry and eventual dead-letter delivery keep that unresolved work visible.

| Count | Definition |
| --- | --- |
| Events | Distinct admitted provider notifications |
| Completed / pending / failed | Current receipt state for those events |
| Attempts | Every retained reconciliation attempt, including superseded attempts |
| Deliveries | Bound queue delivery IDs; distinct from events and attempts |

A workspace admits at most 4,096 delivery IDs and 16,384 attempts. It refuses
further admission at capacity; history is never silently deleted. Export the
operator-held event ledger separately before rotating qualification resources.
The project Git bundle and task handoff do not export this service-delivery ledger.

## Qualification boundary

Controller/SQLite tests use deterministic barriers. The local Workerd qualifier
uses real SQLite and Queue dispatch with simulated owner binding and Artifacts
heads. A separately run hosted qualifier uses real provider subscriptions, pushes,
Queue delivery and Durable Objects, while its seeded workflow and fault controls
remain explicitly scripted. Its public fetch handler always returns 404; controls
are reachable only through a private binding and are absent from the application
entry point. Neither mode establishes model quality or human acceptance.
