# Independent code review boundary

Hosted candidates now pass through four separate authorities:

| Authority | Capability | Gate |
| --- | --- | --- |
| Builder | Produce and submit its own candidate | Assigned service identity and exact Git head |
| Verifier | Run owner-defined checks in the pinned runtime | Current passing evidence |
| Independent reviewer | Read assigned source/context and record an assessment | Distinct allowlisted service or human Access identity, current owner assignment and passing assessment |
| Owner | Accept or reject; request guarded merge | Current independent assessment plus all existing acceptance/merge checks |

An owner may also enable the project's [automatic approval and merge policy](automatic-merge.md).
It starts off and requires current checks and the same independent reviewer gate.
Policy decisions have their own attribution; they do not claim the owner read a
candidate. The reviewer still cannot configure policy, accept or invoke merge.

`ACCESS_REVIEWER_CLIENT_IDS` is a JSON array of Access service client IDs.
`ACCESS_REVIEWER_SUBJECTS` separately lists verified human Access `sub` values.
The owner, builders, service reviewers, and human reviewers must be disjoint.
Missing reviewer configuration leaves the gate pending; owner credentials cannot
manufacture an assessment. A human subject also needs an explicit Access edge
policy before hosted qualification; Worker configuration alone does not allow
that person through the edge.
The existing owner session policy is unchanged by this code. The operator's
current eight-hour preference remains separate from these role permissions.

## Reviewer protocol

### Request and hand off a review

In the owner's **Independent code review** panel, select already configured
reviewers and choose **Request review**. **Reviewer names and identities** lets
the owner save recognizable display names alongside the existing verified IDs.
Names are presentation metadata: they cannot enroll a reviewer, change an
allowlist or replace authenticated attribution in an assessment.

The panel distinguishes **Awaiting review**, **Passed**, **Changes requested**,
and **Needs renewed assignment**. Assignment records a request; it sends no
email and does not launch a reviewer agent. Give an agent the review task in its
separate session using its own reviewer credentials and the protocol below.

For an assigned human, **Copy human review link** produces a link to the saved
workspace, candidate and assignment. Send it manually. The person signs in with
their configured Access identity and the reviewer page opens that assignment.
The link contains no credentials and grants no access. An unavailable, stale or
superseded link never silently opens a newer assignment. A login code is only
authentication, not a review notification. Clipboard failure leaves the link
visible and selected for manual copying.

Renewing a request replaces the current assignment and requires a fresh
assessment. The reviewer inbox labels multi-recipient requests **Shared
assignments**; this is not team membership or an approval quorum.

Display names are saved with the owner-only
`POST /api/workspace/reviewer-name` operation using
`{ reviewerId, name, expectedVersion }`. The ID must already be allowed, names
are bounded to 80 visible characters, and stale writes are refused. Builders
and reviewers cannot call this operation. Recorded identities and review
freshness bindings do not change when a display name changes.

Removing the assessment identity from the current reviewer allowlist blocks new
owner acceptance and new manual merges, just as it blocks automatic approval.
The owner must assign an allowed reviewer and obtain a fresh assessment. Existing
assessments retain their original attribution. Completed merge receipts and
reconciliation of an uncertain write already present at the target remain
available; neither path authorizes another Git write.

### Inspect and assess the assigned source

Use a separately allowlisted Access reviewer identity and a fresh reviewer
context. Service reviewers use the verified `common_name`; human reviewers use
the verified `sub` and email. Never give a reviewer builder checkout credentials,
an owner JWT, or builder chat history.

1. The owner assigns one to eight allowlisted identities using
   `POST /api/runs/:runId/review-assignments` with the current context ID,
   workspace version, selected reviewer IDs and an `Idempotency-Key`.
   `GET /api/review-inbox` returns only currently assigned work to a reviewer.
   The inbox separates personal assignments from requests sent to multiple
   selected reviewers; neither count hides the all-assignment denominator.
   Ownership, requirements, commit or policy changes make the old request stale;
   an assigned reviewer cannot read the changed source until the owner assigns
   the new context.
2. `GET /api/runs/:runId/review-context` returns the context ID, exact candidate
   snapshot (regular files as base64), diff, requirements, trusted verification
   policy, relevant task-base files and observed evidence. It does not return conversations, provider
   prompts, Git credentials or the whole workspace. Candidate source and report
   content are untrusted data, not instructions to execute.
3. Inspect the candidate in a fresh, read-only review environment. Record concrete
   findings against the supplied requirements and evidence. Do not run code from
   the packet with ambient credentials. Before a model request, the supervisor
   calls `POST /api/runs/:runId/review-inference` with the packet context ID,
   assignment ID, model, bounded input/output/time limits and one idempotency
   key. The Worker rechecks the exact assignment and branch, then retains an
   execution-slot reservation before inference. A replay returns the original
   reservation but never authorizes a second model request. Pending inference
   fences task changes and remains occupied after an interrupted or uncertain
   response. The owner workspace response lists these attempts under
   `reviewInferences`, including their safe IDs and state. The owner may release
   a pending attempt only with an explicit note and current
   source revision through `POST /api/runs/:runId/review-inference/:attemptId/reconcile`;
   a late assessment from that attempt is refused. This manual recovery is not
   evidence that a provider call was never charged.
4. `POST /api/runs/:runId/code-review` requires an `Idempotency-Key` header and takes only the current structured assessment contract:

   ```json
   {
     "format": "projects-code-review-assessment/v2",
     "contextId": "<context ID from the GET response>",
     "verdict": "changes_requested",
     "summary": "What was inspected and the remaining limitations.",
     "resolvedPriorFindingIds": [],
     "findings": [{
       "title": "Reject unsafe totals",
       "body": "The changed line can return an unsafe integer.",
       "priority": 1,
       "location": {"path": "checkout.mjs", "side": "head", "startLine": 7, "endLine": 7},
       "evidence": "The committed expression adds two integers without a safe-integer check."
     }]
   }
   ```

   The model supervisor adds its server-issued `reviewAttemptId` to this body
   and reuses the reservation key. The server consumes that reservation when it
   records the assessment. A human reviewer with no inference attempt for this
   candidate can submit directly from the browser. After an inference attempt
   exists for that reviewer and context, omitting its ID cannot bypass a failed
   or reconciled attempt. The local runner checks every
   model finding's line against the hash-verified head or base source before
   submitting or counting it as an evaluated result.

   The other verdict is `pass`. A pass may contain P2/P3 observations but cannot
   contain P0/P1 findings. A changes-requested assessment needs at least one
   finding. The server bounds finding count and text, requires each path in the
   candidate's changed-file set, and validates side and line range against the
   exact committed head/base blobs before saving. It assigns finding IDs and
   retains the inspected blob ID. Identity fields are rejected.
   If an earlier assessment has open P0/P1 findings, the new reviewer must list
   each verified resolution in `resolvedPriorFindingIds`. Unlisted findings
   carry into the new assessment; a passing verdict cannot discard them. The
   packet shows earlier open finding IDs without builder conversations.
   Reviewer credentials cannot claim work, start/submit/fail assignments, alter
   policy, run verification, record owner acceptance or merge. This is enforced
   both at the Worker route boundary and in controller resource checks.

Each assessment binds workspace, task, candidate head/base, requirements revision
and content, ownership version, and verification definition/code/image/result.
Changes make it stale. A contributor to any alternative on the same task cannot
review that task, including after a later role change. Repeating the same key and
payload returns its original record, even after merge. Keys are scoped to the
authenticated principal and workspace; changed payloads or resources conflict.
A new assessment uses a new key, retains history
and revokes any owner acceptance, requiring a new owner decision. A candidate
retains at most 100 assessments; the server refuses further additions rather
than dropping history.

Older prose assessments remain historical records with their original text and
attribution. The current write endpoint accepts structured v2 assessments only.
Reassignment binds a new review context and retains previous assessments and
owner decisions in history. The owner can mark a specific finding resolved,
deferred or dismissed with a note through
`POST /api/runs/:runId/findings/:findingId/decision`. That decision has its own
receipt and history. It cannot change the independent verdict or supply passing
evidence.
The quality evaluator includes three explicitly scripted cases: one clean change
and two seeded defects. Expected answers stay outside model input. Its score
retains unrun and failed cases, and labels line overlap as a location match
until someone verifies that the reported issue is correct. Real model evaluation
requires an explicit case count, model, request limits and credential.

Owner acceptance binds the assessment ID. Merge rechecks it before Git mutation,
alongside fresh trusted checks, the base/head and compared candidates. Historical
acceptances without independent assessment cannot authorize a new merge.
Historical merges retain their original attribution and show that no independent
code review was recorded; they are never relabeled as having passed this gate.

## User interface and exports

The review view separates Changes, Checks, Independent review and Owner decision.
The independent panel shows the four authorities, pending/stale/changes-requested/
passed state, authenticated attribution, findings and earlier assessments. The
owner can download context and label configured reviewers, but cannot supply
the authenticated identity recorded on an independent assessment.
The owner assigns allowlisted reviewers and records finding decisions. Human
reviewers use `/reviewer.html` to see their assigned candidates and submit an
assessment without workspace management or merge controls.
Acceptance prerequisites and merge controls use the same current gate. Handoffs
retain assessment history and identity without JWTs or service secrets.

## Local scope and qualification

Local loopback is an existing single-operator development environment without
authenticated actors. It continues to label decisions as attribution and shows
independent review as unavailable. It cannot claim authenticated independent
review. The new security gate applies to the hosted adapter; this preserves the
explicit local/hosted distinction rather than inventing a local identity.

The gate proves credential separation and the bound assessment record. It cannot
prove a model's reasoning quality or erase a review client's prior memory. A
private qualification runner under `tests/qualification/run-reviewer.mjs` makes
one explicit, bounded model request after saving an attempt receipt. The model
receives a validated source packet with no tools, builder conversation, owner
token, reviewer credential or Git credential. Lost inference and uncertain
submission outcomes remain visible; neither is retried automatically. The
runner requires an explicit model, limits, private reviewer session and model
API key. It also requires `--provider workers-ai` or `--provider openai`; the
provider choice pins the official Chat Completions endpoint and its output-token
field before any request. For Workers AI, the endpoint account must match the
qualification setup. The runner requires a clean committed source and records
the source commit/tree and selected provider in each retained attempt receipt.
The endpoints do not start inference automatically.

The deterministic suite tests denial, context invalidation, history, retries,
revocation races and legacy records. The local Workerd qualifier uses a separately
signed scripted reviewer fixture after its real container checks. Live Cloudflare
qualification requires a separately approved reviewer service identity and
verification against the exact deployed source and current identity policy.

Before deployment, reconcile pending operations on the previous deployment,
configure the separate reviewer, and qualify the new source privately. Keep
public ingress disabled. Do not reuse an existing builder identity as a reviewer
or reinterpret an old owner decision as independent review.
