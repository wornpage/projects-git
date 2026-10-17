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

## Fresh background authority

Automatic integration requires the private `CURRENT_POLICY` service binding to
the **same application Worker**, with named entrypoint `WorkspacePolicy`. Both
shipped application configurations include it; update its `service` when renaming
the Worker. The entrypoint has no public HTTP route and returns no session or
service-token secrets.

Each lookup reads the active Worker's Access configuration. The alarm never
authorizes an automatic merge from its retained Durable Object environment or a
cached policy forwarded by an earlier API request. It checks current ownership
and reviewer access before approval, before each verification command, before
issuing Git credentials and immediately before push. Lookups are scoped to the
workspace, bound to a fresh request nonce and limited to five seconds. Missing,
unavailable or invalid authority fails closed. Index delivery can still run
when automatic authority is unavailable.

An in-flight check or Git write cannot be undone by revocation. No subsequent
command or push is admitted after a revocation is observed. Already-issued
credentials are retired, interrupted reports keep their full check denominator,
and uncertain writes retain the existing owner-only reconciliation path. A
confirmed exact target commit can be recorded without a second check or push.

### Deployment requirement

Use **exactly one version in the active application deployment** when changing
identity policy or running automatic integration. Do not use a gradual split,
retain an old policy version at 0%, or pin `CURRENT_POLICY` to another version or
service. A fresh RPC and nonce are not proof of the newest policy if routing can
still select older configuration. Keep the project switch off during a policy
rollout until the single-version deployment is confirmed. See Cloudflare's
[service RPC behavior](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/),
[gradual deployments](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/)
and [version overrides](https://developers.cloudflare.com/workers/versions-and-deployments/version-overrides/).

Local Node and Workerd/SQLite tests exercise revocation, actual Worker binding
changes, restarts, authority outages and uncertain writes with scripted checks
and Git transport. They do not qualify hosted routing. Before enabling a new
deployment, separately verify the private binding and reviewer revocation against
that deployment, including a coordinator with retained state. Preserve its exact
source, configuration and deployment-version receipt.

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

The current app has one pinned owner and [repository grants](repository-access.md)
for members, builders and independent reviewers. Grants do not delegate owner
acceptance, merge or automation-policy administration. Approval quorums, delegated
merge and branch-specific administration require a separate authorization design.
