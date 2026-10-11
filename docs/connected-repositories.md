# Project queues and external agents

The local controller owns a Git copy for each project. Connect code once, then
queue tasks. An unassigned task picks up current main when claimed; an assigned
task keeps its base until an explicit update. The starter is an initial task and
code template within this same project flow.

For work directed from an existing coding conversation, use
[Work from an existing coding conversation](agent-workflow.md). The local project's
**Project controls → Connect agent** in the shared project header exposes **Copy agent instructions** with
the actual project ID, origin, absolute CLI path and guide path. The instructions
remain visible for manual copying. Hosted projects use the same CLI's
[private Access connection mode](hosted-agent-client.md).

## Create and queue

Run npm run dev, open its printed loopback URL, choose **New project · connect code**,
and supply a name, absolute local Git path and full commit ID. Only that committed
baseline is copied. Source working files, refs, configuration and untracked files
are not copied or modified. Earlier history is a shallow boundary.

Bounds: 256 regular files, 1 MiB per file, 8 MiB total, portable paths, no symlinks
or submodules. Submissions can add 32 commits and change 100 text paths. Verification
requires an installed Docker image containing the language/runtime you need.

**Stack another task** drafts up to eight briefs. Saving validates all briefs
atomically. Queueing consumes no agent slot and works while agents run or admission
is paused. Four assigned/running external agents share local capacity. This is
functional proof, not a 100/1,000-agent load result.

The CLI reads an agreed JSON task stack. This is an example, not a request to add
these tasks automatically:

```json
{"tasks":[{"title":"Normalize tags","purpose":"Produce canonical tag names","criteria":["Trim whitespace","Discard empty tags"],"owner":"Coordinator"}]}
```

Open PowerShell 7 with `pwsh -NoProfile` and keep the following variables in that
session. This block connects a new project from a shell in the Projects Git
repository. If the connection panel has already supplied a handoff, use its setup
lines and the [agent workflow](agent-workflow.md) instead; do not reconnect it.

```powershell
$cli = (Resolve-Path -LiteralPath "./scripts/repository-work.mjs").Path
$origin = Read-Host "Loopback origin printed by the running local workspace"
node $cli --help
$sourceRepo = Read-Host "Absolute path to the repository the user wants connected"
$base = (git -C $sourceRepo rev-parse HEAD).Trim()
$projectName = Read-Host "Agreed project name"
$briefPath = Read-Host "Absolute path to the approved task stack JSON"
$connectRequest = [guid]::NewGuid().ToString()
$connected = node $cli connect --url $origin --repo $sourceRepo --base $base --project-name $projectName --brief $briefPath --request-id $connectRequest | ConvertFrom-Json
$projectId = $connected.projectId
node $cli status --url $origin --project $projectId
```

For an existing project, use `projects --url $origin` to discover its ID. Queue
another approved stack with a new request ID, leaving the connected code intact:

```powershell
$queueBriefPath = Read-Host "Absolute path to the next approved task stack JSON"
$queueRequest = [guid]::NewGuid().ToString()
node $cli queue --url $origin --project $projectId --brief $queueBriefPath --request-id $queueRequest
```

Generate UUIDs with `[guid]::NewGuid()` in PowerShell 7. Reuse an ID only to retry the same
action. Completed retries return the original task IDs. Invalid imports unlock
editing. An unknown network outcome offers **Check saved request and unlock editing**:
it returns the original saved result, waits for an active import, or retires the
uncompleted request before allowing changes.
The CLI does not silently retry mutations. Preserve the request ID and exact
payload, inspect the outcome and make any retry explicit.

## Agent protocol

```powershell
$claimRequest = [guid]::NewGuid().ToString()
$assignment = node $cli claim --url $origin --project $projectId --label "My coding agent" --request-id $claimRequest | ConvertFrom-Json
if ($assignment.idle) { throw "No unassigned task; return to the conversation." }
if (!$assignment.runId -or !$assignment.checkout) { throw "No ready assignment; inspect the result." }
$taskId = $assignment.taskId
$runId = $assignment.runId
node $cli show --url $origin --task $taskId
node $cli start --url $origin --run $runId
if ($LASTEXITCODE -ne 0) { throw "Start was refused; refresh the task before editing." }
Set-Location -LiteralPath $assignment.checkout
git status --short
```

Read the assigned checkout's instructions, edit only the agreed files, run relevant
checks and commit on its branch. Then submit the actual full commit:

```powershell
$head = (git rev-parse HEAD).Trim()
$summary = Read-Host "Factual summary of the committed work"
node $cli submit --url $origin --run $runId --head $head --summary $summary
```

If execution fails instead, retain its work and report the observed reason with
`fail --url $origin --run $runId --message $failureReason`. Submission and failure
are alternative outcomes, not consecutive steps.

Claim returns the oldest unassigned task and checkout, or an explicit idle result.
The agent reads the brief with show before working. After submission or failure it
can claim another task. This supplies work to an existing agent client; it does not
launch a model or provider process. To add an explicitly authorized alternative
for a specific task, inspect `node $cli assign --help`; provide that task's ID,
an agent label and a new request ID.

Claim and assignment are saved together before checkout preparation. Restart
recovers a complete checkout under the same claim; an incomplete one is marked
failed and releases its slot. A new request ID can claim that task again. Failed
work and partial files remain. Running external agents survive coordinator restarts;
inference is never repeated automatically.

## Discovery and control commands

Every command supports `--help`. Read IDs, heads and versions from current results;
do not reuse a stale screen or silently retry a version conflict.

| Command | Meaning |
| --- | --- |
| `projects --url` | Discover projects, admission policy, current main and browser links |
| `status --url --project` | Inspect the queue, candidates, decisions, versions, links and explicit counter definitions |
| `revise --url --task --expected-revision --brief` | Apply agreed `{purpose, criteria, reason}`; preserve code/history and invalidate current evidence/acceptance |
| `admission --url --project --expected-version --state on\|off` | Control new assignments and starts; does not terminate running agents |
| `recheck --url --run --head --revision` | Run the already configured definition for the exact current candidate and revision |
| `update-base --url --run --head --revision --mode reapply\|resolve` | Explicitly reconcile retained work with advanced project main |

The table lists flags, not complete runnable commands. The
[agent workflow](agent-workflow.md) supplies complete examples using the current
CLI results. Pause a running agent through its host when the user asks it to stop.
Admission off still allows queueing, existing submissions, checks and review.

## Checks, decisions and integration

**Review** configures 1–12 command checks, expected exit/stdout, and an installed
immutable Docker image ID. The definition binds the exact head and requirements
digest. Commands run without network, credentials or Git metadata; expected outcomes
stay outside the container. Total check time is at most 60 seconds. A passing command
does not prove every written requirement or an independent reviewer identity.

Use `node $cli check --help` for its required arguments and the
[verification contract](repository-verification.md) for the definition format.
The `check` command requires an explicitly reviewed definition file, its exact
byte SHA-256 and an installed immutable image ID or digest.
Failed checks return a nonzero exit. Reviewer attribution and comparison of current
overlapping heads are recorded separately. Merge reruns checks and advances only
the expected project main; it never updates the connected source checkout or deploys.

Changing requirements preserves commits and old reports, but also makes the saved
command definition stale. Read `show`, review the new criteria, explicitly rebind
the definition's revision/digest and update its commands if needed, then invoke
`check` with its new file digest. `recheck` does not silently rewrite that definition
or generate new code. Return the current browser review link to the user; automated
checks, agent completion and human acceptance are distinct.

When main advances, **Update candidate base** performs a three-way tree merge into
a new candidate. Old commits, reports and decisions remain; the task revision
advances. Only the declared check definition carries forward, never its result or
acceptance. New checks and review are required. Conflicts leave state unchanged;
**Prepare resolution checkout** moves the task to current main and returns an agent
checkout with the original candidate reference. Superseded candidates stay in all
retained-candidate and reported-check denominators.

This loopback controller trusts the computer's user/processes; names are attribution,
not authenticated identities. The Cloudflare adapter exposes the same project queue
through authenticated Artifacts project/fork APIs; see [Cloudflare setup](cloudflare.md).
This local queue does not establish live Artifacts access,
paid inference, deployment or a hosted multi-user security boundary.
