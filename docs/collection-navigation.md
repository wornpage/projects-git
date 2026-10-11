# Collections and individual work

Projects is a directory. Open a project to see its **Task queue**, then open a
task to read its **Task details** or browse its **Candidates**. Open a candidate
for its changes, checks, review and separate integration controls. **Project
history** retains candidates across that project; **Candidate record** holds one
candidate's reports and decisions.

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
Its compact notice stays visible; **Example guide** expands the guided links.
It does not expose private workspace data or delegate reads to the live API.
