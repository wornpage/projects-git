# Collections and individual work

Projects is a directory. Open a project to see its **Task queue**, then open a
task to read its **Task details** or browse its **Candidates**. Open a candidate
for its changes, checks, review and separate integration controls. **Project
history** retains candidates across that project; **Candidate record** holds one
candidate's reports and decisions.

On narrow screens, **Navigate** opens these same project, task and candidate links,
plus **New project** and **Installation** when available, in the existing side panel. The original nodes,
counters and handlers move into the panel and return to the sidebar on close.
Desktop keeps its sidebar; the phone header stays compact while the full scoped
navigation and counts remain available.

On phones, Navigate also contains Find work, connection status and identity.
The page title shares a row with project controls; repeated project metadata is
available in Project settings. New task stays on the Task queue. Filter/sort
options expand beside search and remain marked when active. Review uses a single
tab row, and multi-file diffs expand their file list only when needed. Paused
admission, prerequisites, failed/stale checks and mapping warnings stay visible.

All owner screens and shared dialogs use the presentation in `public/workbench.css`;
the owner and reviewer applications share `public/theme.css` design tokens.
This provides warm surfaces, teal primary actions,
consistent controls and compact project context. Queue rows separate task identity,
status and candidate links. Candidate cards emphasize inspection; agent summaries
and checkout details are expandable while failed checks, revision warnings and
execution limits remain visible. The four review stages retain their distinct
states and controls. Filters and pagination continue to show matching and total
counts; the styling does not change acceptance, verification or merge rules.

The header keeps Find work on one line and groups connection state above the
signed-in identity. Long identities truncate visually while retaining their full
text and title. Breadcrumbs have their own space on desktop; smaller layouts use
the selected project and navigation below. The decorative initial badge is removed.

A project picker stays visible in the sidebar on desktop and the compact header
on phones and tablets. It lists recent and pinned projects, **All projects** with
the full workspace count, and **New project** for owners. All projects opens the
paginated directory, including projects not loaded into the picker. Creation also
remains available on the Projects page and in Navigate. Pinning lives in Project
settings. Navigation totals remain available in Navigate and collection views.
Task details uses the task title and status; tasks are chosen from the queue,
without repeating a task dropdown above the detail pane.

Each collection emphasizes its next task; other tools use labeled disclosures.
Review displays one of its four sections at a time on desktop and phones. Passing
candidates open on Changes, with a next step into the guarded decision form.
Missing, failed or pending checks and pending independent review open their own
stage. Acceptance and merge controls retain all existing guards. Shared type,
spacing and control tokens are checked with `npm run check:design`.

Vertical sidebars use compact, consistent gaps between navigation rows and scroll
when the available height cannot hold every task and candidate link. Side panels
separate major sections from their heading and paragraph groups, so project
capacity, repository observations, task progress and activity remain easy to scan.

## Starting a project and an agent

New project separates code selection from the first task brief. In the local
app, enter the repository path and choose **Read current commit**; confirm the
selected committed HEAD before continuing. Inspection reads code metadata and
does not change the source checkout or queue tasks. Hosted owners choose from a
paginated Artifacts repository list; selection loads the current default branch
and full base commit. Credentials remain behind the server binding, and creation
rechecks the selected head. Local inspection remains a separate local capability.
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

**Projects** opens the connected repository catalog. **Needs attention** comes
first, with repair and recovery ahead of review or manual integration. Each row
uses the existing task outcome and its exact task/candidate link. Passing checks
do not imply independent review, acceptance or merge. Active work and an
intentional admission pause can remain under **Other repositories**.

The catalog uses the ten complete projects loaded by the workspace page. Its
name filter, status filters and ordering apply only to that page, with loaded and
workspace totals shown separately. **Find across workspace** opens the existing
**Find work** dialog to search every project name. This catalog lists connected
projects; it does not enumerate unrelated repositories in the Cloudflare account.
Row counts use all tasks in that project, including integrated tasks. Queue
counts appear when there is queued work; empty repositories show **0 tasks**.
The read-only projection does not change permissions, admission or workflow state.

The picker contains at most eight recent/pinned project shortcuts, including
the current project. Up to four projects can be pinned. Browser storage contains
only their IDs, scoped to workspace and identity; labels and counts are read
from the server. **Projects** and **Find work** remain available for the complete
directory. Expired sessions, stale pages and unreadable shortcut preferences
show explicit errors rather than claiming an empty workspace.

## Lists, totals and reading

| Collection | Visible page | Retained information |
| --- | --- | --- |
| Connected repositories | 10 complete projects; page-scoped name/status/order controls | Full task denominators per project, separate workspace project total, and existing global name discovery |
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

Everyday screens lead with results, next actions and short count labels. Routine
definitions use **About catalog counts**, **About task counts**, **About these records** and **About these
reports** disclosures. Check setup puts runtime detail under **How checks run**.
These use the existing disclosure state and keyboard behavior. Sample labels,
blocking warnings, current status, report numerators/denominators and workflow
actions remain visible; stored evidence and decisions are unchanged.

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
