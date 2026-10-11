# Publish a local change to private GitHub

The local app can publish an exact accepted and locally merged candidate to one
operator-configured private GitHub repository. It records three separate facts:
local merge, PR creation and an observed GitHub merge. It never merges a PR,
deploys, changes repository visibility or overwrites an existing remote branch.

## Configure the local operator

Install Git and GitHub CLI, then authenticate `gh` as an operator with write access
to the intended private repository. Start the local server from PowerShell 7:

```powershell
$env:PROJECTS_GITHUB_REPOSITORY = "owner/private-repository"
npm run dev
```

The setting is a repository name, not a URL, credential or request-body field.
Only GitHub.com and SHA-1 repositories are supported. Missing configuration keeps
publication unavailable. Public, renamed, archived, disabled or read-only targets
refuse publication. No login prompt or account switching happens automatically.

This uses the existing **local attribution** trust model: the loopback operator
and local processes with API access are trusted. It is not an authenticated human
presence check or an isolation boundary between local agents. Keep the port on
loopback; do not expose this mode to untrusted clients. The hosted Worker does not
offer these publication routes. Its Access roles and independent-review boundary
remain separate.

## Preview, publish and observe

1. Complete checks, record the owner decision and merge into the local project.
2. In Review, choose **Preview GitHub PR**. Inspect the private repository, target
   branch, upstream base, dedicated new branch and full approved commit.
3. Choose **Publish private PR** within five minutes. Repository workflows may
   run when the branch and PR are created.
4. Use **Refresh GitHub status** to record PR open, closed, changed or merged.
   Opening a PR link and refreshing status never approve or merge it.

The current GitHub default branch must equal the task's recorded base. Publication
stops if it moved; it does not rebase, cherry-pick or weaken the prior approval.
Reconcile work against the updated upstream and obtain fresh checks and approval.
This initial publication feature does not synchronize an advanced upstream into
the local project automatically. A GitHub squash/merge commit may therefore
require a separately prepared current project baseline for subsequent work.

The source is read from the coordinator-owned repository, with its retained ref,
diff and paths checked again. An agent checkout, caller-provided repository path,
branch, reviewer name or commit cannot select the publication target. GitHub CLI
credentials are used by bounded trusted processes, never passed to candidate code
or retained in workspace records, browser drafts or handoffs. Git configuration,
hooks, transport and environment overrides are restricted for the push.

The dedicated branch uses a Git creation-only lease with an empty expected value.
Even a racing branch creation makes the push refuse; no existing ref can be
replaced. See [Git's explicit lease semantics](https://git-scm.com/docs/git-push).
PR creation uses [GitHub's pull-request API](https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request)
through the operator's GitHub CLI account.

## Interrupted publication

A durable receipt is written before a push or PR request. The same request ID
returns its original record; a different preview under that ID conflicts.
Repository operations serialize competing clients. Provider errors, observed
branch heads, PR identities and previous statuses remain in publication history.

**Refresh GitHub status** only reads remote facts. **Continue publication** is an
explicit action that can perform an operation that has never started. For example,
after readback confirms the original push, it may create the PR once. An attempted
push or PR request is never blindly repeated. Absence after a timeout is not proof
that a write stopped; unresolved outcomes stay visible for inspection.

Status requires the original repository ID, PR number, branch and exact head.
A changed PR source is labeled **GitHub source changed**, even if that different
source was merged. The observed merge commit and time are historical provider
facts, not a deployment or current production-health claim.

## Local API

All endpoints are explicit JSON POSTs under `/api/runs/<runId>/publication/`:

| Endpoint | Body | Effect |
| --- | --- | --- |
| `preview` | `{}` | Validate local approval and read GitHub; retain an expiring preview |
| `publish` | `{ "previewId": "UUID", "requestId": "UUID" }` | Reserve and perform at most one push and one PR creation |
| `<requestId>/refresh` | `{}` | Read GitHub status; never perform a remote write |
| `<requestId>/resume` | `{}` | Explicitly continue only an operation not previously attempted |

Preview and publication data are scoped to their workspace, task and run.
Publication links and observation history are included in task handoffs; operator
paths and credentials are excluded. No publication control starts model inference.
