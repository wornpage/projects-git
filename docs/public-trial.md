# Open trial: follow-up release proposal

Status: local design, not an available hosted trial. Based on main
`f8f0eb001a5e3f1d69512b64587f4ef374678533`. No signup endpoint, new resources,
identity changes, deployment or spending are authorized by this document.

## Entry and first useful result

Use an open, self-service trial rather than invitations. Do not require an email
before someone can understand the product.

| Entry | Visitor experience | Current status |
| --- | --- | --- |
| Explore without signing up | Inspect the invented checkout project, failed candidate, checks, independent review and merge record | Available in the separate public read-only demo |
| Start a private trial | Verify email, receive an isolated sample repository, create a task and connect an existing coding agent | Proposed; not implemented |
| Deploy on Cloudflare | Use the MIT source and Cloudflare-first setup guide | Source available; independent installation remains unqualified |

The public sample stays available when trial capacity is full. No waitlist or
manual approval is part of normal admission. A capacity refusal says why and
links back to the sample; it must not pretend a workspace has been created.

The trial's first useful result is a real change to the sample repository with
commit-bound checks and a separate review record. Opening a seeded project does
not count as completing a workflow. A task created by the visitor is not an
agent-written candidate. A seeded review must never satisfy a new candidate's
review gate. Existing independent-review and owner-decision criteria stay intact.

## Architecture boundary

The current runtime is deliberately configured for one workspace and owner:
`src/cloudflare/access.ts` pins `WORKSPACE_ID` and `ACCESS_OWNER_SUB`;
`src/cloudflare/index.ts` routes to `WORKSPACES.getByName(env.WORKSPACE_ID)`.
Repository member permissions do not provide public account creation or tenant
selection. Adding every visitor to the real workspace's member list would not
create isolated trials.

Prepare a separate trial deployment and an admission registry, using the existing
Cloudflare-first application. Keep the real workspace's hostname, Access app,
audience, bindings and owner configuration unchanged. Resource names and account
inventory belong in a private installation handoff, not this public source file.

| Owner | Required responsibility |
| --- | --- |
| Trial authentication boundary | Validate signature, issuer, audience, expiry and identity type from a dedicated trial login application; use the verified identity's immutable subject, never a submitted email as authority |
| Admission registry | Map `(issuer, subject)` to exactly one trial ID, workspace ID, limits and expiry using a durable idempotent transition; one published policy revision owns those values |
| Request context | Resolve workspace and owner on the server; a supplied workspace ID can only be an equality precondition, never a selector that grants authority |
| Workspace coordinator | One Durable Object per admitted workspace, with fresh active/expired and authority checks before effects and saves |
| All downstream resources | Carry the same tenant identity through Artifacts repository ownership, indexes, queue messages, events, subscriptions, caches, exports, agent assignments and review handoffs |
| Cleanup owner | Stop new work, fence uncertain effects, delete only the recorded trial's resources and retain a bounded outcome receipt; never infer success from a missing response |

Authentication alone does not admit a trial. Creation uses a durable intent and
idempotency key, records each actual resource and exposes partial failure without
blindly replaying creation. An interrupted request resumes the same admission.
The identity-to-trial fence survives resource deletion for its stated
abuse-retention window; signing in after expiry cannot silently create another.
No fallback to the existing owner's workspace is allowed.

Use one resolved workspace-context path in the application when tenant support
is implemented; do not duplicate the application or leave an alternate browser-
selected tenant path. The existing single-workspace deployment must retain its
pinned authority. This is an owning-chain change, not a change to Access alone.

Cloudflare's [JWT validation documentation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
describes application audience and signature validation. Trial enrollment and
resource isolation remain application responsibilities. Provider login, abuse
protection and subscription limits need their own review before configuration.

## Proposed trial limits

These are design values, not configured quotas or approved spending. Keep them in
one server-side trial policy when implemented; the UI reads that policy.

| Item | Proposed limit | Visible outcome |
| --- | --- | --- |
| Duration | 7 days from successful admission | Exact expiry date and remaining time |
| Identity | One trial per verified subject | Existing trial opens on repeat sign-in |
| Repository | One supplied sample; 32 MiB Git-object budget | Used / total; no arbitrary repository import initially |
| Tasks and runs | 10 tasks; 1 active run | Used / total and the reason another run cannot start |
| Metadata | 4 MiB, including retained history | Used / total; no hidden truncation |
| Launch capacity | 20 new trials per UTC day; 50 active trials | Automatic capacity decision and public sample link |
| Model spend supplied by operator | None | Connect your own coding agent; no included model credits |
| Hosted check compute | Not enabled until a separate allowance and enforceable execution limits are approved | No claimed full-workflow trial before checks are available |
| External effects | GitHub delivery, arbitrary webhooks, arbitrary code import and public repository creation off initially | Explain the unavailable action in context |

Seeded tasks and records consume the same quotas as visitor-created records.
Show both counts when helpful, with a fixed total; do not reset the denominator
after sample setup or omit retained failed attempts from storage usage.

Request, storage and execution quotas bound admitted activity; they are not a
guaranteed dollar billing cap. Record the approved aggregate allowance and stop
conditions before launch. No plan upgrade, identity seats or ongoing storage cost
may be assumed free. At present all spending remains unapproved.

At expiry, refuse new mutations and cancel or fence pending work before any
further effect. Proposed retention: 24 hours of authenticated export-only access,
then scheduled resource deletion with an outcome receipt. Explain separately how
long backups, provider logs and minimal abuse-prevention records remain; do not
promise immediate total erasure. Verify this policy and its disclosures before
accepting real user data. Do not silently migrate a trial into the real workspace.

## UI changes

| Surface | Required change |
| --- | --- |
| Public welcome | Primary action: **Explore without signing up**. Secondary action: **Start a private trial**, only once actual admission works. Keep **Deploy on Cloudflare** as a separate option. |
| Trial start | One email verification step, concise limits and data-retention link. No credit-card, invitation, newsletter consent or marketing questionnaire required for admission. |
| Admission | Real states: verifying, preparing, ready, capacity full, failed and expired. Safe retry opens the same pending admission. |
| First workspace | Sample label, exact expiry and remaining quotas. One task setup and instructions for connecting the visitor's coding agent. No automatic agent run on signup. |
| Work/review | Existing checks and independent reviewer requirements. Explain remaining steps without representing illustrative records as new evidence. |
| Trial settings | Export, delete, expiry and remaining limits. A distinct self-host setup link; no implied migration or paid conversion. |

No live trial button, inactive signup form or invented signup-success screen is
part of this source-only preparation. The existing public demo remains read-only.

## Bounded implementation and release gates

1. Implement the admission policy/state machine with local fixtures: duplicate
   signup, concurrent creation, capacity, expiry, interrupted creation and cleanup.
   No provider resources or emails in these fixtures.
2. Carry server-derived workspace context through the existing owning chain.
   Prove two trial owners and the pinned real owner cannot read or mutate each
   other's catalog, code, tasks, reviews, exports, indexes, events or credentials.
   Include queued/late callbacks and revocation during an awaited effect.
3. Add the UI states above. Review desktop and phone layouts with invented data.
   Keep sample, historical and current evidence distinguishable.
4. Obtain independent source review and exact-source focused checks. Present the
   exact trial configuration, resource list, login policy, budget and rollback for
   approval. No automatic deployment or spending follows source acceptance.
5. After separate authorization, provision only the trial resources and prove one
   bounded two-user trial, expiry, export and cleanup. Do not use the real workspace
   as a test tenant or run a benchmark. Stop on isolation, quota or cleanup failure.
6. Only after proof, publish trial-available copy and submit selected release-list
   entries. If compute remains unapproved, launch the source and public sample
   honestly; do not advertise a full hosted workflow trial.

The real workspace, deleted speed goal, original submitted video and challenge
tag remain unchanged throughout. Use a new product release tag if a release is
later authorized; do not replace competition artifacts.

## Launch measurements

No analytics collector or new tracking is configured. If later approved, collect
the smallest aggregate counters needed; never send code, emails, tokens or task
text to release directories. State the observation interval and missing coverage.

| Metric | Definition and denominator |
| --- | --- |
| Sample entry rate | Observed sample opens / observed landing visits; report missing observation coverage |
| Verification rate | Distinct verified trial subjects / distinct started verification attempts; bot/rate-limit exclusions shown separately |
| Admission success | Ready trials / admitted creation intents; failed and pending intents remain in the denominator |
| Time to first useful result | Admission-ready to first non-seeded candidate with current checks and independent review; eligible ready trials and missing timestamps shown |
| Trial usage | Active / admitted / expired trials reported separately for one fixed cohort |
| Cleanup completion | Fully confirmed cleanup / trials due for cleanup; uncertain or partial deletion is a failure or pending state |

These are planned KPI definitions. There are no measured signup, conversion,
activation, hosting-cost or trial-success results yet.
