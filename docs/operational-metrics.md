# Repository operational metrics

Open a repository's settings and choose **Operational metrics**. The private
Cloudflare app reads complete retained repository history on request. It does
not use the currently loaded task page or start any agent, checks or recovery.
Refresh explicitly for a newer observation. The endpoint is
`GET /api/projects/:projectId/metrics`; repository read permission is required.
Independent reviewers retain their separate, assigned-candidate boundary.

## Timing definitions

| Phase | Start | End | Denominator |
| --- | --- | --- | --- |
| Task queue wait | Task-created event | First assigned-run event | All retained repository tasks |
| Assignment to start | Assigned-run event | Reported start | All retained candidates |
| Reported execution window | Reported start | Submission or failure | All retained candidates |
| Verification to review assignment | Last trusted verification timestamp | Latest review assignment | All retained candidates |
| Assigned review turnaround | Latest assignment | Assessment for that assignment | All retained candidates |
| Recorded verification windows | Explicit attempt start | Recorded attempt end | Retained timing windows, plus operation coverage |
| Recorded recovery windows | Explicit resume/reconcile start | Recorded attempt end | Retained timing windows, plus operation coverage |

Execution includes coding, tests and waiting. It is not CPU time or a measurement
of coding effort. Review turnaround includes waiting too. These phases can
overlap; do not add their medians into a total duration.

Each phase partitions its denominator into measured, open, missing, invalid,
not started and not applicable. Medians and minimum/maximum values use measured
windows only, including failed and unconfirmed outcomes. The status breakdown
shows those outcomes separately. Open windows have separate elapsed time; they
do not prove that a process is alive. Remaining time is unknown. Imported Git work
without an execution interval is not applicable. Bad clock order is invalid.

New verification, merge-verification, base-update and explicit interrupted-work
reconciliation paths retain attempt-bound observations. An interrupted attempt's
unfinished timing stays missing when a newer attempt owns the operation. The
ledger preserves earlier records rather than rewriting them. It is capped at 200
records per operation; further admissions fail explicitly rather than discarding
history. Historical operations may have no records, and earlier retries may be
unrecorded even when an operation now has one. Coverage makes this visible.

## Models, usage and cost

Model attribution uses a retained model selection, never an agent's display name.
External-agent model and usage are unknown unless explicitly retained. Different
recorded models are shown; the view does not claim their times are comparable.

Token totals cover observed usage in retained coding-agent request receipts.
The view shows request count, measured usage count, unknown usage and cache-usage
coverage separately. Missing observations do not become zeroes. Unsafe token
sums return unknown with an overflow flag. Candidates lacking a receipt are
reported separately; they are not treated as a count of billable requests.

Dollar spend is **not recorded**. No verified billing measurements are retained,
so this view supplies neither an actual dollar amount nor a price estimate.
External-agent charges and other Cloudflare services are outside these figures.

## Source and qualification

`src/core/operation-timing.mjs` owns strict timing records;
`src/core/operational-metrics.mjs` owns definitions and projections;
`public/ui/project-metrics.js` owns the guarded read-only view. The controller
records observations at existing lifecycle boundaries. Timing does not authorize
work, relax evidence criteria, repeat provider execution or enable automatic
recovery. Repository grants still apply before a metrics read.

Local event, controller, signed-HTTP, SQLite and UI fixtures establish source
behavior only. They do not establish hosted accuracy, performance improvement,
production scale, billing completeness or enterprise readiness.
