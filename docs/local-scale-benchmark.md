# Local workspace scale benchmark

This benchmark measures the existing workflow controller and SQLite store with
synthetic retained histories. It makes no Artifacts, Git, model-provider or hosted
requests. It does not measure merged changes per day or establish hosted capacity.

Install the locked dependencies, then run from the source checkout:

```sh
node --expose-gc scripts/benchmark-workspace-scale.mjs --out=C:/path/to/new-private-results --groups=10,25,100 --samples=7 --warmup=2 --burst=4
```

The output path must be absolute and new. Each case runs in a separate Node
process against its own SQLite file. Results, partial results, logs and databases
are retained; failed or timed-out cases remain failures in `cases.json`.

## Workload and denominators

Each group contains eight tasks, eight candidate records, report histories and
operation receipts. These are fictional records, not agent execution results.

| Shape | Retained projects | Retained candidates | Candidates in a directory-page response | Candidates in a task-creation/replay response |
| --- | --- | --- | --- | --- |
| `many-projects` | Number of groups | Groups × 8 | Up to 80 from ten projects | 8 from the selected project |
| `one-project` | 1 | Groups × 8 | All retained candidates in that project | All retained candidates in that project |

The single-project fixture has distinct historical bases between groups. It does
not manufacture one enormous set of mutually overlapping changes from one base.
Both shapes retain the same candidate and operation counts; their loaded page
sizes differ. Do not interpret their page-time ratio as an equal-size comparison.

The phases measure a full snapshot read, a one-record write, a directory page,
queueing one task and replaying the same task request. The final burst measures
concurrent local task-creation arrivals, not parallel builders or merges.
Warmup operations are excluded from the reported samples. Response construction
and JSON serialization are included in page/task timings. SQL timing is nested
inside store timing; these values must not be added as independent stages.

Correctness checks retain earlier candidate data and operation receipts and
require exactly one task per successful new request. Existing four-slot execution,
two-attempt verification, authorization and integration policies remain unchanged.

## Comparing a change

Run the identical harness and arguments on pinned baseline and candidate sources,
with separate output directories and fresh databases. Compare within each shape
and size. Preserve warmup counts, sample counts, runtime, source hashes, failures
and raw observations. Repeat the baseline after the candidate to expose machine
load and warmup effects. Do not convert these control-plane timings into Git,
verification, reviewer or daily-integration throughput claims.

Workspace coordination now builds transient task/run and repository/base indexes
once for a bulk response. Single-candidate enforcement builds fresh indexes too;
no index or authorization result survives a snapshot mutation. Same-task
alternatives, cross-task overlaps, original order, independent-review status and
current-base gates remain part of the same calculation. The local and hosted
presenters share it.
