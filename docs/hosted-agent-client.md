# Connect a coding agent to the hosted workspace

Use `scripts/repository-work.mjs` with a private connection file. Your coding chat
runs the agent; the client supplies no model and never starts inference. The Worker
authorizes every workspace and assignment.

Coding hosts can also use the [MCP v2 stdio server](mcp.md). It uses this same
connection format, client and private receipts. The CLI remains available for
direct commands and recovery.

## Prepare the connection

The owner must already have allowlisted the builder's Cloudflare Access service
identity. Give independent agents separate identities. The client does not enroll
users, create credentials or change Access policy. Reviewers and the owner keep
their separate interfaces.

Store this JSON outside every Git checkout, in a private directory such as
`%LOCALAPPDATA%/ProjectsGit/connections`. Replace the placeholders with actual values:

```json
{
  "format": "projects-git-hosted-connection/v1",
  "origin": "https://git.example.com",
  "workspaceId": "projects-git-hosted",
  "clientId": "<allowlisted-service-client-id>.access",
  "clientSecret": "<service-secret>"
}
```

Use owner-only permissions (`chmod 600` on Unix). On Windows use a private profile
directory and its user-only ACL; Node's Unix mode flags do not enforce a Windows ACL.
Keep the file and its adjacent `.state` directory out of shared folders, Git, chat
and recordings. Secrets are read from files, never command arguments. HTTPS origins
with credentials, paths or redirects are refused.

The client process can read its own connection secrets. Isolation between separate
local agents is the chat host's responsibility; distinct API identities do not
provide filesystem isolation between processes running as the same OS user.

From a Projects Git source checkout after `npm ci`, use PowerShell 7:

```powershell
$connection = Read-Host "Absolute private connection JSON file"
node scripts/repository-work.mjs projects --connection $connection
$project = Read-Host "Project UUID from projects"
node scripts/repository-work.mjs status --connection $connection --project $project
```

The read verifies the expected workspace and authenticated service identity.
Project settings → Connect agent supplies project-specific instructions.

## Work on an agreed task

Keep each operation's UUID and result. Use a fresh UUID for a new operation; an
explicit retry must retain the original UUID and exact inputs.

```powershell
$claimId = [guid]::NewGuid().ToString()
node scripts/repository-work.mjs claim --connection $connection --project $project --label "Checkout builder" --request-id $claimId
$run = Read-Host "Run UUID from the claim result"
$checkout = Read-Host "Absolute path for a new checkout directory"
node scripts/repository-work.mjs checkout --connection $connection --run $run --directory $checkout --request-id ([guid]::NewGuid().ToString())
node scripts/repository-work.mjs start --connection $connection --run $run --request-id ([guid]::NewGuid().ToString())
```

Edit and commit with your normal Git tools in the returned directory. The client
does not reset existing directories or execute repository hooks. Push and submit
the exact commit separately:

```powershell
$head = git -C $checkout rev-parse HEAD
$pushId = [guid]::NewGuid().ToString()
node scripts/repository-work.mjs push --connection $connection --run $run --directory $checkout --head $head --request-id $pushId
node scripts/repository-work.mjs submit --connection $connection --run $run --head $head --summary "Implemented the agreed task" --request-id ([guid]::NewGuid().ToString())
```

Push is restricted to the assigned fork and branch, compares the observed remote
head, refuses a changed local head and never force-pushes. Submission, independent
checks, review and merge remain separate. Follow the returned browser link. Builders
cannot configure checks, change project policy, review, accept or merge.

## Credentials and recovery

### Continue a resolution assignment

After a conflict, the owner can create resolution work for an existing builder.
Save the owner's issued-once `update-base` response (`mode: "resolve"`) as a private
JSON file outside every Git checkout. This file contains the temporary Git token;
do not paste it into chat, command arguments or logs. The builder uses its own
connection to import that existing assignment during checkout:

```powershell
$assignment = Read-Host "Absolute private resolution response JSON file"
$run = Read-Host "Resolution run UUID from the owner"
$checkout = Read-Host "Absolute path for a new resolution checkout"
node scripts/repository-work.mjs checkout --connection $connection --run $run --directory $checkout --assignment $assignment --request-id ([guid]::NewGuid().ToString())
node scripts/repository-work.mjs start --connection $connection --run $run --request-id ([guid]::NewGuid().ToString())
```

Checkout reads the live workspace to verify the builder identity, current task
revision, run, fork, `updates/...` branch, base commit and credential expiry. It
ignores the file's workspace snapshot. It creates no assignment, sends no remote
mutation and grants no owner permissions. A different retained credential is
refused. Existing directories are preserved; a partial clone requires a new
directory and request ID after inspection. Remove the source response file after
confirmed checkout with `assignmentImported: true`. The earlier separate `adopt`
command is replaced by this checkout option.

After coding and committing, push and submit the exact head with one command:

```powershell
$head = git -C $checkout rev-parse HEAD
node scripts/repository-work.mjs submit --connection $connection --run $run --directory $checkout --head $head --summary "Resolved both changes" --request-id ([guid]::NewGuid().ToString())
```

`submit --directory` validates its complete input before any Git effect. It uses
the existing guarded push path, confirms the exact remote head, then submits.
The push keeps a deterministic child request UUID and its own attempt receipts;
the parent receipt names that UUID. An uncertain push or submission stops. On an
explicit same-key retry, an already-pushed head is observed without another write;
an already-submitted matching result is reconciled without Git access or another
POST. Changed inputs still conflict. The separate `push` command remains available
when an agent intentionally wants to publish a candidate before submitting it.

The original candidate remains retained. Submission
retires the local credential; the updated candidate still needs fresh checks,
independent review and owner acceptance. Checkout does not renew expired tokens
or recover an issued-once token that was not saved.

### Retain and reconcile command outcomes

The server returns a claim's Git credential once, for **15 minutes**. The client
saves it privately before reporting success. It is never printed or saved in Git
URLs/configuration. Confirmed submission/failure removes the client's credential
file. Interrupted work retains private state; expiration does not renew credentials
or create replacement assignments.

Each mutation retains a principal/workspace-bound manifest before I/O and a separate
attempt receipt. Changed inputs under the same UUID conflict. A lost response leaves
an unknown outcome. This command only reads those receipts:

```powershell
node scripts/repository-work.mjs receipt --connection $connection --request-id $pushId
```

Read `status` or `show` before deciding to repeat a command. There is no automatic
mutation retry. An explicit push retry reads the remote first; if the exact commit
is already present it returns without another push. Failed attempts remain recorded.

If a successful submit response was lost, repeating its original command and UUID
reads the authenticated run first. A terminal run with the same head and summary
is reconciled without another POST, and its private credential is removed. A different
terminal outcome remains a conflict; cleanup does not relabel it as your requested
submission. This same explicit reconciliation can finish local cleanup after a file
permission failure. Earlier unknown attempts remain in history. Summaries are limited
to 2,000 characters, matching the hosted API.

If a claim response was lost before its credential was saved, repeating the UUID
recovers the assignment, not its issued-once secret. Inspect and explicitly close
that assignment if needed; agree replacement work separately. Partial checkout
directories are preserved. A new checkout requires a new directory.

```powershell
node scripts/repository-work.mjs fail --connection $connection --run $run --message "Explain the retained failure" --request-id ([guid]::NewGuid().ToString())
```

The existing `--url` mode still serves the local loopback controller and local owner
operations. Hosted mode exposes only builder reads, claim, checkout, start, push,
submit, fail and receipt. Local transport fixtures and real local Git objects do
not establish Cloudflare-hosted acceptance; retain hosted qualification separately.
## Project pagination

Hosted `projects --connection ...` returns ten projects and a `page` object with
the complete project count, next offset and revision. Continue with
`--offset <nextOffset> --revision <revision>` on the same command. A stale revision
is refused; restart the listing. Project status, task reads and assignment reads
load the relevant project. Workspace-wide capacity remains separately labeled.

## Portable commit context

The continuation dialog can export a bounded Git context file for an exact commit.
Use [Git notes](git-notes.md) to attach it locally and explicitly synchronize
`refs/notes/projects` with an intended private remote. This does not extend the
hosted client's permissions or automatically push metadata with code. Workspace
SQLite and project exports remain the authority and complete history.
