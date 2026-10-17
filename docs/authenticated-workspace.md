# Authenticated hosted ownership

The hosted Worker requires Cloudflare Access. One pinned human owner manages the
workspace; individually allowlisted Access service clients perform agent work.
The local loopback adapter retains explicitly named attribution. Local names and
historical shared-token reviews are not authenticated identities.

## Configure the boundary

Set `ACCESS_TEAM_DOMAIN` to the exact HTTPS Cloudflare Access team domain,
`ACCESS_AUD` to the application's audience, `ACCESS_OWNER_SUB` to the verified
human subject, and `WORKSPACE_ID` to the intended durable workspace.
`ACCESS_AGENT_CLIENT_IDS` is a JSON array of permitted service client IDs.
`ACCESS_REVIEWER_CLIENT_IDS` separately allows read-only code reviewers. The two
lists must be disjoint; no reviewer configuration means hosted acceptance stays
blocked until an independent assessment can be obtained.
`ACCESS_REVIEWER_SUBJECTS` optionally allowlists verified human Access subjects
for review. A human reviewer also needs an Access edge policy. The owner remains
the only person who can accept, merge or enable a project automation policy, and explicitly assigns reviewers to
each candidate before they can read its source or submit an assessment.
Empty or invalid configuration refuses access. Never infer the owner from the
first caller, an email header, task coordinator text, or a submitted reviewer name.

The Access application needs a human Allow policy for the owner and a Service
Auth policy for its explicitly selected agent clients. Keep unrelated applications
and policies untouched. Configure protection before enabling the dedicated
qualification hostname. The default Worker and preview endpoints stay disabled.

Obtain the owner session through `cloudflared access login` / `access token` for
this application, verify its signature, issuer, audience, expiry and email, and
then record its subject as configuration. Tokens and service secrets belong in
the operator's credential environment, never source, URLs, records or logs.
The Worker accepts only the verified `Cf-Access-Jwt-Assertion` supplied by Access.
It has no shared bearer-token fallback. Signing-key requests are HTTPS-only,
reject redirects, and have five-second and 128 KiB bounds. Public keys cache for
five minutes; unknown-key refresh has a thirty-second cooldown.

For authenticated API requests, the Worker passes its validated Access policy
alongside the verified principal over the internal Durable Object RPC. The
workspace uses that request policy for authorization, including manual acceptance
and merge; it must not reconstruct it from a retained Durable Object environment
that may predate a settings-only deployment. Missing forwarded policy fails closed.
Request bodies and headers cannot override this internal policy field. The policy
is a request snapshot, not a claim of instantaneous revocation of already-admitted
work. Background automatic integration separately reads current policy through
the private `CURRENT_POLICY` RPC before admission and side effects; it never
reuses the last request's policy. Follow the single-version deployment and
qualification requirements in [automatic integration](automatic-merge.md#fresh-background-authority),
and keep automatic merge off during identity-policy rollouts.

## Permissions and identities

| Principal | Permissions |
| --- | --- |
| Owner | Workspace management, task briefs and coordination, check policy, owner acceptance/rejection, merge, recovery and automatic merge policy |
| Human member | Read repositories explicitly shared with its stable subject; no workflow mutations |
| Agent client | Read explicitly shared repositories; build permission allows claims and changes to its own assignments |
| Reviewer client | Repository review grant plus candidate assignment allows exact review context and its own bound assessment; no build, verification, acceptance or merge actions |
| Private workspace alarm | Execute a current owner-enabled automatic policy; cannot configure it or manufacture a human decision |
| Other identity | No workspace access |

There is one pinned workspace owner. [Repository grants](repository-access.md)
provide member reads, builder access and independent-review access for configured
identities. `ACCESS_MEMBER_SUBJECTS` optionally lists human member subjects. There
are no delegated team administrators, approval quorums or delegated merge powers.
A task's owner label grants no account access. Existing repositories require
explicit owner grants before non-owner access resumes after this upgrade.
Repository grants also require a single-version rollout: an older Worker serving
pre-grant reads cannot coexist through traffic splits, version overrides or an old
zero-percent policy target. Qualify the exact deployed source before claiming the
new boundary is enforced; local source checks do not prove that rollout.

Projects can opt in to [automatic approval and merge](automatic-merge.md), off
by default. That policy requires current independent checks and code review;
it records policy authorization rather than a human acceptance. The alarm does
not retain or reuse an owner's JWT. Session revocation disables enabled policies.

Agent clients send `CF-Access-Client-Id` and `CF-Access-Client-Secret` to the
Access-protected hostname. Worker authorization uses the signed application
assertion, not those caller-provided headers. Self-claims derive their assignment
identity from that assertion. Owner-created assignments require an allowlisted
`agentClientId`. Raw idempotency keys are scoped to the principal and workspace;
replays never issue another Git credential.

Hosted review bodies contain decision, note, commit, requirements revision,
owner version and compared heads. They must omit `reviewer`, `identity`,
`reviewerIdentity`, `principal` and `policy`; these fields are refused. The controller
derives attribution from the authenticated human. Review and handoff records
retain the verified identity without retaining the JWT.

Independent assessment uses the separate `/code-review` endpoint, requires a
verified reviewer identity. A reviewer pass alone grants no merge authority;
either a human acceptance or a current owner-enabled policy must authorize it.
See [the independent-review contract](independent-review.md) for context binding,
staleness, history, local limitations and the two-endpoint reviewer protocol.

`GET /api/workspace` exposes authentication mode, current principal, permissions,
and whether explicit owner adoption is needed. Owner responses also list
allowlisted agent IDs. Browser requests use the Access session; there is no
control-token entry form. Hosted review names are read-only, and tab state is
scoped by workspace, issuer, principal kind and subject/client ID.

## Respond to a stolen session

A valid JWT is a bearer credential: a thief can replay it with that principal's
permissions until it expires or is refused. MFA protects sign-in; it does not
prevent replay of an already stolen application session. Owner compromise can
authorize reviews and merges. Agent compromise is limited to that client and
workspace, including its own assignments.

The owner can use **Workspace access → Revoke all workspace sessions**, or call
`POST /api/workspace/revoke-sessions` with `{}`. The Durable
Object stores a monotonically increasing, server-selected `sessionsValidAfter`
cutoff. All owner and agent tokens issued at or before that second are refused,
including the caller's. Sign in again with a token issued in a later second.
Expiry and this cutoff are rechecked before durable writes, at operation fences,
and before credentials are returned. Reservations and uncertain operations remain
available for explicit recovery. A lost revocation response can be resolved by
authenticating again and reading the retained cutoff; the old session stays refused.

Also revoke the affected application/user sessions in Cloudflare Access and secure
the identity provider account. Revoke and replace exposed agent service credentials
and remove compromised clients from the allowlist. Already-issued Git credentials
have their own lifetime and revocation controls. This endpoint neither revokes them
nor cancels previously admitted internal jobs. Provider calls already dispatched
can finish; a Git write that crossed its final fence requires reconciliation.
The cutoff does not undo actions performed before revocation. Preserve receipts,
inspect changed policy and commits, and renew affected owner decisions.

JWT signature validation uses public signing keys and does not automatically learn
Cloudflare's session revocations. Use both the durable cutoff and Access controls.
If a clean owner session cannot be obtained, use Cloudflare administration to
block ingress and recover the identity first. No shared recovery password or
first-caller enrollment bypass exists.

See [Cloudflare session management](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/).

## Adopt retained data deliberately

A fresh empty workspace binds to the configured owner. For retained pre-Access
data, the owner must call `POST /api/workspace/adopt-owner` with `{}` after pending
assignments, jobs and operations have been reconciled using the previous private
deployment. Adoption refuses while any are pending. Original reviews remain in
history. Unmerged legacy acceptances return to review; merged history stays
unchanged. A different configured owner cannot silently rebind retained data.

Optional `X-Workspace-Id` or `expectedWorkspaceId` assertions must match the
configured workspace. All referenced projects, tasks and runs are resolved only
inside its Durable Object. Worker authorization and controller resource checks
both enforce these boundaries.

## Capacity and recovery

Four execution slots are shared per workspace. Running jobs and reserved external
assignments, including resolution checkouts being prepared, occupy them. Queued internal jobs wait without occupying a slot.
The response shows `capacity.running`, `reserved`, `occupied`, `queued`, and
`limit`. Verification has its own `capacity.verification.occupied`, `waiting` and
`limit=2`. Model development and final checks use the same two slots as submitted
candidate and merge checks. Waiting model checks retain their admitted execution
slot and wake on a durable state change, without polling or repeating inference.
Pending attempts remain occupied after a lease expires until recovery stops the
executor. Recovery fences the old attempt before stopping it; a late completion
cannot replace the retained interruption report. The same request ID closes an
interrupted check without repeating execution; a fresh ID requests new checks.

Local crypto/controller fixtures, real local Workerd/container checks, and private
Cloudflare qualification are separate proof populations. Qualification uses
disposable tasks and explicitly scripted actors; it does not establish general
multi-user or large-scale readiness, or human acceptance of the parent project.
