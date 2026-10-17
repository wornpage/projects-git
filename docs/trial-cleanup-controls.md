# Trial cleanup and resource controls

Status: implemented for the supplied-sample preview, with local proof only. No
Cloudflare resource, hosted workflow, deployment or monetary allowance is approved
by this source change. The supplied configurations have `approval: null` and zero
new-resource allowances. The private app and challenge artifacts are unchanged.

## Spending boundary

`TrialPolicy.resources` is mandatory and owns the resource approval reference and
expiry, daily and lifetime sample starts, attempts per trial, provider-operation
allowance and cleanup retention. Missing fields, unknown fields, unlimited values
and nonzero allowances without approval fail closed. Retained registry terms are
immutable; changing approval or limits requires a reviewed migration.

The admission registry owns the synchronous SQLite reservation ledger. It checks
current identity and closure/expiry again after asynchronous authorization, then
reserves before each sample attempt and provider operation. Unknown outcomes and
failed attempts still consume their allowance. UTC rollover permits new daily
starts but does not reset an existing trial or the lifetime count. One physical
create is permitted per trial; an uncertain create is inspected on explicit resume,
never blindly repeated. A complete replay does not create or reseed a repository.

The private registry RPC `pauseResources(policy, reason)` latches a durable stop.
Visitors have no approval, pause or resume-administration HTTP route. Status reads
and cleanup remain available after a pause or approval expiry. There is no automatic
unpause or silent approval renewal.

These controls bound application work. **They are not a guaranteed Cloudflare
invoice cap.** They do not meter billing, Access seats, incoming HTTP traffic,
storage retention charges or every Git transport packet. Responses explicitly
report `billingCapGuaranteed: false`. Operator-funded models and hosted checks
remain disabled. Hosted launch still requires verified account costs, an approved
monetary allowance and edge abuse controls. No prices or dollar conversion are
invented here.

Owned credential teardown is a separate bounded cleanup allowance. It can inspect
ownership and revoke initial/temporary tokens even if spending stops or the trial
closes while creation is in flight. It cannot mint new tokens or attach new work.
Sample token inventories are limited to 16 complete, distinct, known-state tokens.

## Cleanup ownership and recovery

The registry schedules its own Durable Object alarm on admission and closure.
Cleanup becomes due after `cleanupDelayMs` from closure or expiry. The minimum is
five minutes, beyond this slice's three-minute write-token lifetime; supplied
unapproved templates retain for one day. This is a retention grace period, not an
export feature. Exports remain unavailable.

| Boundary | Enforcement |
| --- | --- |
| Scheduling | At most five due trials per alarm; claim each attempt durably before RPC |
| Recovery allowance | Six retained attempts with backoff; crashes consume their claim; exhaustion blocks further automatic work |
| Active work | Coordinator fences new calls and waits for active calls and retained creation leases |
| Deletion targets | One fixed sample from the exact retained creation intent; no namespace listing or browser-supplied names |
| Ownership | Match repository name, ID where known, exact creation marker and current metadata |
| Credentials | Confirm complete inventory and revoke active tokens before deleting |
| Provider work | At most 32 operations per cleanup attempt; uncertain results remain pending |
| Uncertain deletion | Save the observed ID before deletion; later attempts inspect absence and never blindly resend delete |
| Local purge | One SQL transaction drops workspace content and retains a minimal cleanup tombstone |
| Admission | Registry identity, admission counts and resource reservations survive cleanup; re-signing in cannot restart a trial |

A missing repository does not prove an unconfirmed create never happened. Without
a prior observed repository identity, that case remains pending and eventually
blocked for operator attention. Foreign/replaced repositories are not revoked or
deleted. Unknown cleanup counts are `null`, not a fabricated zero denominator.
Late attempt results cannot overwrite a later attempt or completed receipt.

The Artifacts namespace must be dedicated to this runtime, with no other
application writer. The binding deletes by name; it has no conditional-ID deletion
parameter. Namespace exclusivity and hosted behavior must be qualified before launch.

This slice intentionally blocks cleanup of retained tasks, runs, forks and untracked
resources. Enabling workflows requires extending the same inventory and effect
leases first. Future credential hashes in the registry need a scoped purge before
the final completed receipt; they are not part of the current sample-only runtime.
Minimal admission/abuse records remain and are not advertised as total erasure.

## Visitor UI

Unapproved, paused or exhausted setup has no enabled preparation action. The UI
shows setup attempts and provider operations as used / allowed, rejects malformed
allowances and false billing-cap claims, and retains existing identity and expiry
fences. Closed/expired views distinguish pending cleanup, operator attention and
confirmed deletion. A confirmation never promises immediate deletion.

## Local proof

Tests use actual SQLite, authenticated local HTTP and loopback Git with a simulated
Artifacts control plane. They cover approval and quota refusal, concurrent and
changed-key attempts, retained stop/expiry, closure during creation, two-user
isolation, lost create/delete responses, replaced resources, bounded alarm claims,
restart recovery and atomic workspace purge. No hosted provider, model or benchmark
is exercised. Local fixtures use explicit fake approvals; they do not authorize spend.
