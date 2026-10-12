# Collections and individual work

Projects is a directory. Open a project to see its **Task queue**, then open a
task to read its **Task details** or browse its **Candidates**. Open a candidate
for its changes, checks, review and separate integration controls. **Project
history** retains candidates across that project; **Candidate record** holds one
candidate's reports and decisions.

On a phone, **Navigate** opens these same project, task and candidate links in the
existing side panel. The original nodes, counters and handlers move into the
panel and return to the sidebar on close. Desktop keeps its sidebar; the phone
header stays compact while the full scoped navigation and counts remain available.

## Starting a project and an agent

New project separates code selection from the first task brief. In the local
app, enter the repository path and choose **Read current commit**; confirm the
selected committed HEAD before continuing. Inspection reads code metadata and
does not change the source checkout or queue tasks. Hosted Artifacts projects
keep explicit repository-name and commit entry; local inspection is unavailable.
The selected stage and each draft are saved under the existing tab/workspace
scope, including stacked drafts and unresolved request recovery.

After creation, Task details and the empty Candidates view offer **Get agent
instructions**, using the same connection dialog as Project settings. This entry
is absent from read-only examples and isolated trials without agent connections.
Copying instructions does not start an agent; the coding conversation runs it.
The local Projects directory also exposes the explicitly scripted sample starter.

Candidate review leads with compact task/revision identity and the existing four
review sections. Supporting task/candidate context and the agent summary remain
in a disclosure below the content. Prerequisite warnings remain visible when a
task has dependencies; verification, independent review, owner decision and
integration keep their existing authority and distinct records.

## Finding work at scale

**Find work** searches project names across the authenticated workspace, including
projects outside the loaded directory page. Project results are alphabetical,
20 per page, and include complete task and candidate counts. Task and candidate
matches use the loaded projects; the dialog states that scope explicitly.
Search is a read and does not create a project, start an agent or alter code.
The catalog uses the same workspace-reader authorization as the workspace API;
restricted reviewers do not gain project-directory access.

The sidebar contains at most eight recent/pinned project shortcuts, including
the current project. Up to four projects can be pinned. Browser storage contains
only their IDs, scoped to workspace and identity; labels and counts are read
from the server. **Projects** and **Find work** remain available for the complete
directory. Expired sessions, stale pages and unreadable shortcut preferences
show explicit errors rather than claiming an empty workspace.

## Lists, totals and reading

| Collection | Visible page | Retained information |
| --- | --- | --- |
| Task queue | 25 tasks, with search, status and order controls | All task totals, including integrated work and prerequisites |
| Candidates | 25 candidates, with search, status and order controls | Every original candidate, current and earlier reports, stale-assignment warnings, shared files and acceptance blockers |
| Project history | 25 candidates and 25 activity events | Original status, commit, check counts and individual detail links |
| Requirement history | 10 revisions | Every original purpose, criterion and change reason |
| Check-report history | 25 report choices | The exact selected report, original passed/total count and provenance |

Filtered lists state **shown range**, **matching count** and **full total**.
The caption and pagination follow the rows; a compact search/status/order bar
precedes them. Supporting project totals and their definitions live in **Project
activity**, and task-wide progress remains available through **Task progress**.
Changing a query or status starts at the first page. Filtering never removes
records or changes workflow state. Counts and eligibility use the complete
selected project, independent of the visible page. Execution-slot capacity
remains workspace-wide, including work outside the loaded projects.

Task details defines the agreed work and requirements. A compact candidate
summary links to the separate result collection. Candidates keeps brief task
context and links back to the full task brief. Result-specific warnings remain
with each candidate; retained results stay reachable through filtering and
paging. Requirement revisions and handoff exports remain available.

Typography separates reading text, row titles and supporting metadata. Task
purpose and requirements use a larger reading size and a restrained line
length; collection captions keep compact, legible totals. Main text, supporting
text, links, states and focus indicators have explicit contrast tokens. Color
supports visible labels rather than carrying state alone.

## Data boundary

The project catalog reads project-name metadata and counts from SQLite without
assembling every task, diff or report. Catalog pages bind to a workspace revision
and reject stale or unavailable continuations. Selected-project reads still
retain complete project data so coordination, prerequisite and review decisions
never use a partial list. Collection paging bounds rendered rows; it does not
yet bound transfer size for an unusually large individual project. Exports
continue to include full retained records.

The public example uses invented records and the same collection components.
Its compact notice stays visible; **Example guide** opens the guided links in the
existing side panel without moving the trigger or the work content.
It does not expose private workspace data or delegate reads to the live API.
