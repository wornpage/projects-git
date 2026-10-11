# Work from an existing coding conversation

For selected-candidate continuation, project briefs, task prerequisites and quick
navigation, see [the agent control loop](agent-control-loop.md).

The user's chat host directs and executes agreed work. Projects records the task
queue, isolated Git candidates, evidence and human decisions. Connecting a chat or
queueing a task does not launch a model. Use the host's existing agent capabilities;
this CLI neither supplies a model nor authorizes a provider call.

In the shared project header, choose **Project controls → Connect agent**, then **Copy agent
instructions**. Paste the text into the existing coding conversation. It includes
the actual project ID, loopback origin, absolute CLI path and this guide's absolute
path. The same text stays visible for manual copying.

## Discover and agree the scope

Start ordinary work with one task and one agent checkout. Follow its committed
change through checks, independent review and your decision; acceptance and merge
remain separate. Prepare an additional candidate only when another approach is
useful. Existing alternatives and failed attempts stay in the task history, and
overlapping changes still need explicit comparison before acceptance.

Repository work is language independent. The command verifier has JavaScript and
Python integration coverage; another language needs a prepared runtime image and
appropriate independent checks. This does not claim qualification of every
language. The checkout starter is a labeled scripted demonstration, while the
optional configured-model form defaults to one candidate.

Use PowerShell 7 on the computer running the local workspace. Open a session with
`pwsh -NoProfile`, run the copied setup lines for `$cli`, `$origin` and `$projectId`,
then keep that session for the blocks below. The handoff has already supplied the
actual context; do not reset it to a default port or ask the user for these IDs again.

```powershell
if (!$cli -or !$origin -or !$projectId) { throw "Run the setup lines from Copy agent instructions first." }
node $cli --help
$projects = node $cli projects --url $origin | ConvertFrom-Json
$projects.projects | Format-Table id, name, admission, mainCommit
$status = node $cli status --url $origin --project $projectId | ConvertFrom-Json
$status
```

These examples use the CLI's local HTTP loopback mode. For a hosted project, use
the same CLI with a [private connection file](hosted-agent-client.md).

Read the queue and existing candidates before proposing work. Resolve the user's
intent into a purpose, observable criteria, file ownership and a bounded execution
plan. Discussion, a question, or a vague improvement idea is not permission to add
tasks. Reuse an agreed task when it already represents the work. Do not silently
queue extra work, repeat mutations, retry provider calls or regenerate code.

### Optional: discover context without a copied handoff

Skip this block when the connection panel supplied setup. For a fresh session
without it, start in the Projects Git repository, use the origin printed by the
running local server, and select the intended project from discovery:

```powershell
$cli = (Resolve-Path -LiteralPath "./scripts/repository-work.mjs").Path
$origin = Read-Host "Loopback origin printed by the running local workspace"
$projects = node $cli projects --url $origin | ConvertFrom-Json
$projects.projects | Format-Table id, name, admission, mainCommit
$projectId = Read-Host "Project ID agreed with the user, from the project list"
node $cli status --url $origin --project $projectId
```

## Queue only the agreed work

Prepare a JSON task stack and review its scope in the conversation. Replace these
named placeholders with the user's actual intent; do not submit the template:

```json
{
  "tasks": [{
    "title": "<AGREED_TASK_TITLE>",
    "purpose": "<AGREED_PURPOSE>",
    "criteria": ["<OBSERVABLE_REQUIREMENT_AND_FILE_SCOPE>"],
    "owner": "<RESPONSIBLE_REVIEWER>"
  }]
}
```

```powershell
$briefPath = Read-Host "Absolute path to the approved task stack JSON"
$queueRequest = [guid]::NewGuid().ToString()
$queued = node $cli queue --url $origin --project $projectId --brief $briefPath --request-id $queueRequest | ConvertFrom-Json
$queued
```

Queueing consumes no agent slot. It remains available while admission is off.
Retain the request ID and exact inputs. After an uncertain result, inspect status
and report the uncertainty before explicitly retrying the same action with the
same ID. A new ID represents a new action. Never silently loop on mutations or
change the payload under a saved request ID.

## Claim, read and execute in the assigned checkout

Each existing agent claims once when ready. Give concurrent agents distinct file
ownership and one checkout each; never have them edit the connected source or each
other's checkout. Four assigned or running agents share local capacity.

```powershell
$agentLabel = Read-Host "Name of the agent or approach authorized for this task"
$claimRequest = [guid]::NewGuid().ToString()
$assignment = node $cli claim --url $origin --project $projectId --label $agentLabel --request-id $claimRequest | ConvertFrom-Json
$assignment
```

An idle result means there is no unassigned task. Stop there; do not invent work or
poll in a busy loop. Otherwise, inspect the returned task and checkout:

```powershell
if ($assignment.idle) { throw "No unassigned task; return to the conversation." }
if (!$assignment.runId -or !$assignment.checkout) { throw "No ready assignment; inspect the result." }
$taskId = $assignment.taskId
$runId = $assignment.runId
$brief = node $cli show --url $origin --task $taskId | ConvertFrom-Json
$brief.task
node $cli start --url $origin --run $runId
if ($LASTEXITCODE -ne 0) { throw "Start was refused; refresh the task before editing." }
Set-Location -LiteralPath $assignment.checkout
git status --short
```

Read that checkout's `AGENTS.md` and the latest brief before editing. `start`
records that the host's agent has begun; it does not create or launch an agent.
Edit only the agreed files, preserve others' work and run relevant local checks.
An explicit `assign` creates an alternative for a chosen task; it uses the task ID,
an agent label and a new request ID instead of pulling from the queue. Use
`node $cli assign --help` before preparing one.

Commit only the intended changes on the assigned branch. Supply the actual file
paths and a meaningful message from the completed work; avoid `git add .` when
other changes are present. Then read and submit the full commit ID:

```powershell
$head = (git rev-parse HEAD).Trim()
$summary = Read-Host "Factual summary of the committed change and local checks"
node $cli submit --url $origin --run $runId --head $head --summary $summary
```

Submission captures code; it grants neither verification nor acceptance. If
execution cannot finish, preserve files and commits, explain the failure and use
`fail --url $origin --run $runId --message $failureReason`, where `$failureReason`
contains the observed problem. Do not report a partial change as completed.

## Run explicit independent checks

Choose trusted observable checks for the current requirements. Review their
commands and exact expected exit/stdout separately from the candidate's claims.
The [verification contract](repository-verification.md) defines the JSON format,
Docker isolation and limits. The image must already be installed and referenced
by immutable ID or digest; verification does not install dependencies or pull it.

```powershell
$brief = node $cli show --url $origin --task $taskId | ConvertFrom-Json
$candidate = $brief.candidates | Where-Object id -EQ $runId
$checksPath = Read-Host "Absolute path to the reviewed command-check definition"
$definition = Get-Content -LiteralPath $checksPath -Raw | ConvertFrom-Json
if ($definition.commit -ne $candidate.headCommit -or $definition.taskRevision -ne $brief.task.revision -or $definition.requirementsSha256 -ne $brief.requirementsSha256) {
  throw "Review and bind the definition to this exact candidate and current requirements."
}
$checksDigest = (Get-FileHash -LiteralPath $checksPath -Algorithm SHA256).Hash.ToLowerInvariant()
$image = Read-Host "Reviewed, installed immutable Docker image ID or digest"
node $cli check --url $origin --run $runId --checks $checksPath --checks-sha256 $checksDigest --image $image
```

`check` explicitly registers and runs the supplied trusted definition. `recheck`
runs the saved definition again against a stated current head and revision; it
does not revise the definition or generate code:

```powershell
$brief = node $cli show --url $origin --task $taskId | ConvertFrom-Json
$candidate = $brief.candidates | Where-Object id -EQ $runId
node $cli recheck --url $origin --run $runId --head $candidate.headCommit --revision $brief.task.revision
```

A missing runtime, failed check or stale definition remains a blocker. Keep failed
and interrupted attempts in the record. A passing command proves its declared
observation; written requirements still need review. Report passed checks over the
total declared checks, and name skips or unrun checks rather than hiding them.

## Change intent without discarding useful code

When the user changes a task, read `show` again. Write a revision brief containing
`purpose`, the complete current `criteria` array, and `reason`. Include retained
criteria explicitly, then submit against the revision just read:

```powershell
$brief = node $cli show --url $origin --task $taskId | ConvertFrom-Json
$revisionPath = Read-Host "Absolute path to the user's approved revision brief JSON"
node $cli revise --url $origin --task $taskId --expected-revision $brief.task.revision --brief $revisionPath
```

This preserves commits, previous reports and review history, while invalidating
current evidence and acceptance. Read the revised task, inspect whether its code
already satisfies the change and communicate new scope to any running agent.
Projects does not send that instruction to the host for you.

For an ordinary connected project, a requirements revision also makes the saved
check definition stale. Review and explicitly update its `taskRevision` and
`requirementsSha256`, and its commands/expectations if the new criteria need them.
Use `check` with the newly reviewed file and its new byte digest. `recheck` alone
must refuse a stale definition. Compatible code can keep the same commit; no new
model generation is needed just to check it again.

## Admission and an advanced project base

```powershell
$status = node $cli status --url $origin --project $projectId | ConvertFrom-Json
node $cli admission --url $origin --project $projectId --expected-version $status.project.policyVersion --state off
```

**Accept new agent work: Off** prevents new claims, assignments and starts. It does
not terminate a running agent or cancel its host process. Pause execution through
the chat host when the user asks to stop work. Existing submissions, checks and
review can continue. To reopen admission when authorized, refresh `status` and use
its latest policy version with `--state on`.

If another accepted change advances project main, inspect the candidate and use
an explicit base update. This is separate from revising the user's intent:

```powershell
$brief = node $cli show --url $origin --task $taskId | ConvertFrom-Json
$candidate = $brief.candidates | Where-Object id -EQ $runId
$updated = node $cli update-base --url $origin --run $runId --head $candidate.headCommit --revision $brief.task.revision --mode reapply | ConvertFrom-Json
$updated
```

A clean reapply creates a new candidate and advances the task revision. It carries
and rebinds the declared check definition, but never its result or acceptance.
Use the returned candidate ID for fresh checks and review. A conflict leaves the
existing state intact; inspect it, then explicitly choose `--mode resolve` with
fresh head/revision values to prepare a new resolution checkout. Give that checkout
to an authorized agent; do not automatically create a replacement or retry a model.

## Return to the user for review

After an owner-authorized local merge, a configured local operator can use the
[private GitHub publication workflow](github-publication.md). The owner inspects
the exact target preview and explicitly publishes. Agent submission, local merge,
PR creation, GitHub merge and deployment remain distinct records and actions.

```powershell
$status = node $cli status --url $origin --project $projectId | ConvertFrom-Json
$status.tasks | Where-Object taskId -EQ $taskId | Select-Object taskId, revision, outcome, browserUrl
```

Report the full commit, changed files, execution result, declared checks and their
denominator, current task revision, remaining concerns and the returned browser
review link. The user reviews the diff, criteria, evidence and overlapping
candidates, records acceptance or rejection, then chooses merge separately. The
agent must not automatically accept or merge its own work.

The browser reuses a reviewer name only after it has been entered in that
workspace tab. This is attribution, not an authenticated identity. Existing
candidate drafts retain their own names and notes. Acceptance notes are optional:
leaving the note blank records only the accepted commit and requirements revision.
Rejection still requires written feedback, and overlapping changes still require
an explicit comparison acknowledgement. None of these conveniences submits a
decision or bypasses current verification.

| Record | What it establishes |
| --- | --- |
| Model-free test | A deterministic test exercised declared behavior; no coding agent was launched |
| Real coding agent run | An existing chat host's agent read a brief, edited its checkout and reported execution |
| Independent check report | Trusted checks observed a particular committed tree and requirements revision |
| Human acceptance | A person reviewed the current candidate and recorded a decision |
| Merge | An explicit action integrated an accepted candidate into the project's managed Git copy |

Preserved evidence, a submitted commit and an agent's completion message are all
useful records. None substitutes for the user's acceptance, source publication or
deployment.
