# Repository access for a private team

The workspace owner grants access separately for each repository. Cloudflare
Access authenticates the identity; a valid session alone grants no repository
access. Existing repositories begin owner-only after this upgrade. The owner must
configure grants before existing builders and reviewers can resume work.

| Identity | Repository role | Additional requirement |
| --- | --- | --- |
| Human member | Read | Subject in `ACCESS_MEMBER_SUBJECTS` and an Access edge policy |
| Builder service identity | Read, or read and build | Client in `ACCESS_AGENT_CLIENT_IDS`; mutations remain restricted to its own assignments |
| Independent human/service reviewer | Independent review | Existing reviewer configuration and a current owner-issued candidate assignment |
| Workspace owner | Manage, accept and merge | Existing pinned owner identity; grants cannot delegate these powers |

Identity lists are JSON arrays of stable subjects or service client IDs. Members,
builders, independent reviewers and the owner must be disjoint. Matching emails
never create or link grants. Members cannot create projects, change requirements,
run checks, accept or merge. Local loopback development remains a trusted
single-operator environment, not a simulation of Cloudflare identity enforcement.

## Configure access

Open a private project, then **Project settings → People and access**. Select
roles and save. An empty grant list deliberately keeps the repository owner-only.
The inspector shows the access version and unfinished credential cleanup.
Installation identities removed from the allowlists no longer qualify, even if
older grants remain in history.

Backend reads filter projects, tasks, candidates and associated events before
pagination, numbering and metrics. Catalog and page denominators cover accessible
repositories. Workspace-wide capacity remains a separately labeled shared resource.
Reviewers read only assigned, sealed candidate context. Owner-only subscription and
event administration summaries are not returned to members.

Access changes use an explicit UUID, principal-bound durable receipt, exact inputs
and expected version. The browser retains an uncertain request in its open
inspector for explicit recovery with the same UUID and inputs. It never retries
automatically. Pending cleanup includes the original request in the owner API so
recovery survives reloads. Access changes require a fresh independent assessment;
old assessments remain historical evidence.

## Revocation and recovery

Repository permissions and their version are rechecked at persistence and provider
effect boundaries, including a revoke/regrant cycle. Owner-delegated builder and
reviewer work checks the target identity's grant too.

Removing build access records the new policy first, then revokes retained fork
credentials for affected settled assignments. Pending provider assignments remain
an explicit cleanup uncertainty: an elapsed lease does not prove an external
effect stopped. Reconcile or explicitly close the original assignment through
existing owner recovery, then **Continue credential cleanup** with the saved
request. New access changes wait for that cleanup to settle.

A provider error may happen after the policy was saved or some tokens were revoked.
Inspect the current policy and receipt before continuing. Already downloaded source
cannot be recalled. Until cleanup is confirmed, an earlier Git credential may still
work within its original scope and expiry. This differs from current permission to
claim, submit, review or integrate through Projects Git.
Cleanup requires a complete token inventory and a final read with no active
credentials. A partial list or inventory above the application's 1,000-token
cleanup budget remains an explicit recovery blocker rather than a successful
partial cleanup.

`HostedController` is request-scoped. Every API call constructs a fresh controller
with its authenticated policy. Do not retain one controller as a team session.

## Local qualification

Access, repository-access, controller, UI, browser-asset and workspace-store tests
use signed local JWTs, in-memory SQLite and controlled provider responses. They do
not establish live multi-user installation, provider token revocation, enterprise
readiness or public-trial isolation. Qualify those separately before deployment.
