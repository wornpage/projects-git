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

## Deliver a hosted merged candidate from your machine

Hosted Review offers **Export task for local delivery** to the owner after a
candidate is merged. The Worker never receives GitHub credentials. This optional
path delivers the exact original commit through the same private-PR protocol;
it does not convert hosted history into a locally merged task.

The export is historical, untrusted evidence. Its checksum proves integrity
against the separately pinned digest, not authenticated provenance, fresh hosted
approval or permission to publish. Read the source and exported checks, independent
assessment and owner decision. The operator's later explicit delivery approval is
a new local action bound to that exact source and GitHub destination.

This path requires a merged candidate with retained repository command checks,
an immutable verification image and tree, structured independent review and a
bound owner decision. Earlier starter-only reports without that proof refuse;
the adapter does not fabricate or upgrade historical evidence.

### Prepare offline

Use a trusted local Git repository containing the complete original base/head
ancestry, or an independently verified recovered bare repository. Do not apply
the rendered diff to recreate commits. Obtain Git objects separately; this CLI
does not authenticate to Artifacts, fetch code, create a fork or run checks.

Inspect the task export and independently record its workspace ID, selected run,
export SHA-256, base, head and verification tree. `node scripts/inspect-handoff.mjs
HANDOFF_FILE` displays the recorded candidate/verification fields. Treat a digest
copied from the same untrusted file as unverified provenance.

Run the CLI from a source checkout with `npm ci` installed. All file/directory
arguments must be absolute. The delivery directory must be new and outside source
control, including outside a bare or recovered repository; keep its evidence and
receipt files private. Canonical source/target overlap and redirected parents are
refused before the delivery directory is created.

```powershell
node scripts/hosted-github-delivery.mjs prepare --handoff "C:/operator/task.json" --sha256 EXPORT_SHA256 --workspace WORKSPACE_ID --run RUN_UUID --base BASE_SHA --head HEAD_SHA --tree TREE_SHA --source "C:/operator/source.git" --directory "C:/operator/new-delivery" --repository "owner/private-repo"
```

`prepare` validates closed nested schemas and the selected merged candidate's
requirements, verification tree, independent assessment and owner-decision
bindings. It compares canonical changed Git paths/modes/object identities rather
than hosted/native rendered diff text. It verifies SHA-1 objects and complete
graph closure, then stages them into a fresh bare repository. No source Git
configuration, hooks, credentials, working tree or executable checks are imported.
Both encoded and expanded objects are bounded to 64 MiB and 16,384 objects.
Unsupported, missing or unrelated objects fail explicitly; failed directories are
preserved. The recorded checks are not rerun and remain historical.

### Preview and explicitly approve delivery

Authenticate GitHub CLI on your machine to the intended private repository.
Preparation is offline; preview reads GitHub and saves an expiring preview.

```powershell
node scripts/hosted-github-delivery.mjs preview --directory "C:/operator/new-delivery" --repository "owner/private-repo"
```

Inspect the returned source/export hashes, full base/head/tree, private repository
ID, target branch, dedicated new branch, PR title/body and expiry. The generated
PR body contains commit/digest references and boundary text; it does not copy
freeform task notes, outputs, diffs or identities into GitHub.

After inspection, copy that preview's `id` and `approvalSha256`. The approval
digest covers the complete generated preview, including its title, body, expiry,
exact source proof and GitHub destination. Choose a new UUID
for `REQUEST_UUID` and preserve it. Only this explicit command authorizes the
creation-only push and PR creation; repository workflows may run.

```powershell
node scripts/hosted-github-delivery.mjs publish --directory "C:/operator/new-delivery" --repository "owner/private-repo" --preview PREVIEW_UUID --request REQUEST_UUID --approve APPROVAL_SHA256
```

The approval digest covers the full preview and its binding, including source/export
proofs, object-change digest, sealed staging configuration, GitHub repository ID,
base branch and new branch.
An old approval cannot authorize another target or source. Current GitHub main
must equal the original base. Advanced main is an explicit refusal; no automatic
rebase, commit reconstruction or approval transfer happens.

### Observe or recover deliberately

```powershell
node scripts/hosted-github-delivery.mjs status --directory "C:/operator/new-delivery" --repository "owner/private-repo"
node scripts/hosted-github-delivery.mjs refresh --directory "C:/operator/new-delivery" --repository "owner/private-repo" --request REQUEST_UUID
node scripts/hosted-github-delivery.mjs resume --directory "C:/operator/new-delivery" --repository "owner/private-repo" --request REQUEST_UUID --approve APPROVAL_SHA256
```

`status` reads only local state. `refresh` reads GitHub. `resume` may perform only
a remote write that has never started. Repeating `publish` with the same preview,
request and approval returns its saved receipt. Interrupted push/PR reservations
and observations survive restart; an absent remote result never permits blindly
repeating the attempted write. GitHub merge and deployment remain separate.

A synchronous-FULL SQLite journal is the cross-platform durable authority for
preview, approval and remote-write reservations. `delivery.json` is a private
readable projection; rollback or timestamp removal there cannot erase the journal.
Status receipts disclose when that projection was reconstructed from the verified
journal so local rollback is not silently treated as authoritative.
Every provider write begins only after its journal commit. POSIX also fsyncs the
projection directory; Windows relies on SQLite's FULL commit rather than claiming
unsupported directory-fsync semantics. Staged Git configuration and the empty
hooks directory are sealed on open and rechecked immediately before every Git push.
The journal is capped at 512 monotonic states and refuses further changes instead
of dropping prior reservations.

A package lock prevents competing CLI processes. After a process crash, inspect
the lock and release only its exact ID after its PID is confirmed stopped:

```powershell
node scripts/hosted-github-delivery.mjs lock --directory "C:/operator/new-delivery"
node scripts/hosted-github-delivery.mjs release-lock --directory "C:/operator/new-delivery" --lock LOCK_UUID
```

A running or indeterminate PID refuses release. Releasing a dead process's local
lock is not evidence that its remote operation stopped. Read local status, then
refresh its preserved publication receipt before deciding whether to resume.
Do not delete or regenerate delivery state to bypass an uncertain publication.

Receipts exclude source paths, credentials and imported freeform content. They
identify historical hosted evidence and separate local operator approval, remote
PR creation and observed GitHub merge. This path does not reauthenticate the
hosted workspace or establish live Access policy, credential validity or current
hosted acceptance. `--help` prints all supported commands without provider I/O.
