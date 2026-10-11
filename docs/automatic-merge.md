# Automatic approval and merge

The hosted app has an **Automatically approve and merge** switch in Project
settings. It starts **Off**, including for existing and restored projects. Only
the authenticated workspace owner can change it. Local attribution and the
read-only demo cannot enable it.

Turning it on authorizes the policy to approve eligible changes already waiting
and future eligible changes in that project. It removes the per-candidate human
acceptance and merge steps for those changes. It does not launch agents, request
reviewer inference or change the owner's check definitions.

## Eligibility

| Gate | Required result |
| --- | --- |
| Owner policy | Enabled current version, bound to this workspace owner and session-revocation cutoff |
| Candidate | Submitted exact commit, current task revision and project base |
| Checks | Current independent report with every required check passing |
| Code review | Current passing structured assessment by an assigned, still-allowlisted independent reviewer |
| Selection | One remaining candidate; no active related work or overlapping candidates requiring comparison |
| Git update | Fresh merge checks with the same verified source/policy/runtime; guarded fast-forward to the exact accepted commit |

Competing alternatives need an owner choice. A project policy cannot silently
compare implementations, dismiss blocking findings or waive the independent
review boundary. Check and review configuration still belong to the owner.

## Records and stopping

The decision records the project policy version, its enabling owner, the exact
candidate and the independent assessment. The actor is **Automatic merge policy**;
no owner review identity or JWT is fabricated. History and exports preserve that
distinction. A later owner decision replaces the unmerged policy decision while
retaining its original record.

The private Durable Object alarm performs the work even when the browser is
closed. One merge is admitted at a time per project across both manual and
automatic requests, using the existing two-attempt verification allowance.
Automatic decisions wait for occupied project or verification capacity.
Duplicate alarms reuse the retained decision and intent. A failed attempt and
its stop receipt are retained in the same durable update. Failures before a Git
write are distinguished from uncertain writes. An interrupted or
uncertain Git write needs explicit owner reconciliation; it never auto-retries.
If the target already has the exact retained commit, reconciliation records that
outcome without another push.

Turning the switch off, changing its version or revoking workspace sessions
prevents a later automatic push. A Git update already sent may still finish and
must be reconciled. Revoking sessions also switches enabled policies off.

Owner API: `POST /api/projects/:projectId/automatic-merge` with
`{"enabled":true,"expectedVersion":0}` for the first change. Read the current
version from the project response before subsequent changes. The server derives
all identity, time and version fields. Builders, reviewers and HTTP callers
claiming to be the alarm cannot configure or run this operation.

## Capacity and scope

There are **four occupied execution slots per workspace** and a separate
**two-attempt verification limit**. A slot is capacity, not an agents-per-minute
promise. An idealized four-slot workload taking five minutes per job gives 0.8
job completions/minute before verification, review and integration bottlenecks.

The current app has one pinned owner and separate builder/reviewer permissions.
It has no team membership, approval quorum or delegated merge roles. A future
team policy must explicitly define who may change it, applicable repositories,
branch rules and required approvers.
