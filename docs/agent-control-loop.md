# Direct work from your coding conversation

Projects Git keeps work, candidate commits and decisions. Your existing coding
chat directs the agents; none of the controls below launch a model.

## Continue a selected candidate

In Candidates or beside the next step in Review, choose **Continue in your agent**. Inspect the context
before copying it into your conversation. It names the selected full commit,
current requirement revision, reviewer note, and failed or stale checks. Private
checkout locations, diffs, command output and provider responses are excluded.
Source strings are quoted as untrusted JSON. The local prompt supplies actual
project/task IDs in the existing CLI read commands. Hosted prompts use the same
CLI's [private connection mode](hosted-agent-client.md).

Copying grants no new authority. The agent reads current state and continues
work already authorized in the coding conversation, asking only when scope is
unclear or the next action exceeds that authorization. Changed
command-check requirements require a new approved definition; a stale definition
is not presented as a usable recheck command. The retained candidate remains
available when another isolated assignment is agreed.

## Project command brief

The project header names tasks needing a decision, active work, waiting work and
eligible queued work. Every numerator uses all project tasks, including merged
tasks, as the denominator. Active includes assigned/running agents and pending
checks. Waiting means unresolved prerequisites, paused admission or unavailable
code. Eligible queued work still requires free capacity. The next action opens
existing work and never records a decision automatically. CLI `status` returns
the same pure command-brief selector. Among queued tasks, the next action prefers
eligible work over waiting work and keeps saved order within each group. If all
queued work is waiting, the first waiting task remains available for inspection.

## Prerequisites

In the task composer, select **Wait for integration**. You can select tasks in
the same project or other drafts in the current stack. The CLI accepts the same
brief shape:

```json
{"tasks":[
  {"title":"Foundation","purpose":"Add the agreed interface","criteria":["Interface works"],"owner":"Reviewer"},
  {"title":"Client","purpose":"Use that interface","criteria":["Client works"],"owner":"Reviewer","dependsOn":["draft:1"]}
]}
```

Existing prerequisites use their task UUID. `draft:1` through `draft:8` refer to
one-based positions in this batch; stored tasks retain resolved UUIDs only.
Cycles, duplicates, self-references, missing tasks and cross-project references
refuse the entire batch. Requirements and dependencies are retained separately;
dependencies are fixed when tasks are queued.

Claiming skips waiting tasks and chooses the oldest eligible task. Direct
assignments and starts enforce the same rule. Passing checks or accepting a
prerequisite does not unblock dependent work; its commit must be integrated.
After integration, the first dependent claim pins current project main. A waiting
queue is reported separately from an empty queue. Retrying an idle request ID
keeps that result; use a fresh request ID for a new claim after integration.
Admission, ownership, capacity, verification and merge guards still apply.
Existing saved tasks have no prerequisites. An older running server must be
restarted before it can enforce dependencies; the CLI refuses to send dependent
work when that capability is absent.

## Find work

Use **Find work**, or Ctrl/⌘ K, to search projects, task titles, candidate labels
and visible commit prefixes. Arrow keys select a result; Enter opens it; Escape
closes the dialog and returns focus. The result count shows displayed/total
matches when the list is bounded. Search does not inspect hidden requirements,
review notes or execution output, and navigation performs no workflow mutation.

## Preview requirement changes

Revise requirements shows saved and proposed text before saving, alongside the
number of retained commits, reports at the current revision, and accepted
candidates whose decisions will return to review. Reports and decisions remain
in history. Assigned and running work continues; share the new brief with agents.

If another client revises the task while the editor is open, proposed text stays
in place and saving is blocked. Choose **Compare with latest revision**, inspect
the new comparison, and then save. The server still checks the expected revision.
Errors stay beside the editor, and dismissing is disabled only while saving.

All workbench dialogs support Escape and return focus to their opener. The work
palette selects the displayed entry by identity even if background data changes.

## Follow a request

Code preparation, checks, rechecks and base updates show progress or recovery
instructions beside their controls. A recorded check request does not mean the
checks passed. The saved verification report determines the current result;
hosted checks that are still pending are explicitly labeled as running.

If a response is lost, refresh status before trying the action again. Refresh
only reads the workspace and never resubmits work. Existing request IDs still
govern safe retries. Connection status and the last-sync time describe the last
workspace response, so switching views does not hide a disconnected state.

A refused retry does not settle an earlier unconfirmed attempt. Retrying the
unchanged task, assignment or verification request keeps its saved identity until
the result is confirmed. Assignment controls show **Resolve pending assignment**
while that outcome is unknown. A valid recovered assignment closes its old retry
form so another click cannot appear to repeat the same request after completion.

Saved drafts, request IDs and navigation hints belong to the workspace and
signed-in identity, not just the currently loaded project page. Reloading on
another project keeps them. If a saved task's original project is not loaded,
submission is disabled and **Open original project** returns to that project
before retrying. Cached context does not grant access or authorize a new action.

After a successful connection, ordinary background reads keep **Workspace
connected** steady. The footer still updates the last successful sync time.
Initial connection, interruption, authentication failure and reconnection remain
visible; healthy polling does not replace the label with a short-lived spinner
or move the adjacent **Find work** control.

## Follow a merge

Accepted candidates stay distinct from integration. The read-only
`mergeStateByRun` snapshot marks a merge as **running** or
**recovery-required**; an absent entry indicates neither state. A running merge
shows progress and blocks a second merge request. Recovery explicitly requires
exact-head reconciliation before further action. **Refresh merge status** reads
the workspace without submitting another merge or changing the selected task
and candidate.

For an accepted candidate marked **recovery-required**, inspect its retained
reports and choose **Reconcile or retry merge** in Review. This is an explicit
mutation through the existing guarded merge endpoint:

- If the target already contains the accepted commit, record completion without
  running another check or Git update.
- If the target remains at the reviewed base, run fresh checks and retry the merge.
- If the target is at a different commit, refuse the operation and retain recovery.

Current acceptance, requirements, ownership, checks and compared heads are still
required. The browser checks the displayed context again before dispatch and
allows only one in-flight request. An active merge cannot be retried. Refresh,
polling and reload never invoke this action; a failed or uncertain response does
not cause an automatic retry. The CLI points the person to this same Review action.

The workspace notice and CLI `status` retain the original pending merge intent
total, alongside running, recovery-required and unclassified counts. These are
workspace counts, including other projects; their denominator is not narrowed
to the selected project.

Review and Evidence show **Fresh merge verification** from server-written
`operation: "merge"` reports with a nonempty `attemptId` in
`run.evidenceHistory`. Each attempt exposes its full checked commit, requirement
revision, check numerator/denominator, exit code, command, output and retained
verifier/runtime provenance. Failed, stale, malformed or unverified reports are
labeled explicitly. Historical unmarked reports remain earlier check reports.
The original `run.evidence` report that supported acceptance remains separate.
CLI candidate reads include the same tagged report objects and labels.

Operation state and retained reports participate in the render signature even
when the durable workspace version has not changed. Polling follows active
merges; it never retries them.

Completed merged outcomes label **Acceptance-time checks** and **Merge-attempt
checks** separately in Review, Evidence and CLI candidate reads. Each moment has
its own retained verification timestamp and passed/total denominator. The counts
are not combined. If the merged record has no tagged merge report, the views
explicitly state **No tagged merge-time report was retained**. Earlier unmarked
reports remain in history without inferred merge provenance.

The shell identifies the selected project across Queue, Agent work, Review and
Evidence. Project settings uses a persistent button with `aria-haspopup="dialog"`.
Its secondary controls open in a native drawer. Opening it does not move or
replace its trigger; Escape and outside clicks restore focus when an operation
does not prevent dismissal. The project workspace
keeps tasks, agent results, checks and decisions together; the existing coding
chat still owns execution.

The workspace home (`?view=projects`) is a project directory. Each project shows
its actual code and admission state, next action and shared task counters; the
denominator includes every project task. Queue (`view=overview`), Agent work,
Review and Evidence remain project views with existing task/candidate links.
The selected task is the page heading outside Queue. A shared desktop task rail
and direct phone selector keep task switching visible across project views.
Queue exposes current requirements; other views offer the full task brief in a
secondary drawer. Candidate selection stays visible in Review and Evidence.
Phone review links choose Changes, Checks or Decision; desktop shows those
sections together. History search follows the selected evidence record.

New project creation and task queueing use the same native composer. A compact
draft list selects one padded editor; every draft is validated before submission.
Choosing a destination keeps the background view stable, and each source keeps
its own saved draft. Unconfirmed requests retain their exact body and request ID;
opening the composer exposes explicit recovery without resubmitting.
Ordinary reads continue through the existing scoped workspace connection.
No global state observer or new UI framework is required for these projections.
The pinned public Wornpage button remains the shared component import and is
reused for project-directory actions as well as retained-candidate navigation. Additional
source-only Svelte layout/navigation imports were evaluated; they would add a
compilation boundary for interactions already owned by the browser modules.
Their adoption is deferred until an interaction needs that shared runtime.

**Coordinator** is a task responsibility label. It identifies the person or
agent coordinating the work; it does not authenticate them or grant access.
The API retains `owner` and `ownerVersion`. Changing the coordinator preserves
the prior name and reviews in history, invalidates earlier acceptance and
requires a fresh review. Assigned/running and merged work keep their coordinator
fixed. This responsibility label grants no [repository access](repository-access.md).
