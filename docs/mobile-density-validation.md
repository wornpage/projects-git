# Mobile content density

The phone layout removes repeated utility and project-header rows, compacts routine
status guidance, collapses filter/sort options, and uses a single review-tab row.
Single-file diffs go directly to their selected file; multi-file diffs retain an
expandable file list with matching/total counts.

## Measured result

Positions are pixels from the top of the initial viewport, using the same isolated
sample workspace before and after the change. Phone viewport height: 844 px.

| Width | First content | Before | After | Earlier by |
| --- | --- | ---: | ---: | ---: |
| 390 px | Task row | 527 | 262 | 265 |
| 390 px | Candidate card | 678 | 310 | 368 |
| 390 px | Diff code block | 969 | 410 | 559 |
| 320 px | Task row | 527 | 262 | 265 |
| 320 px | Candidate card | 700 | 310 | 390 |
| 320 px | Diff code block | 1037 | 435 | 602 |

At 1440 px the corresponding desktop positions remain 384, 477 and 653 px.
No horizontal page overflow or JavaScript errors were observed in these checks.

## Interaction and information checks

- Find work, connection status and identity remain reachable in Navigate. Opening
  Find work closes the navigation drawer; Escape returns focus to Navigate.
- New task remains available on Task queue; branch/commit information is available
  in Project settings.
- Collapsed filter options retain selected values, show an active marker and do
  not change the displayed original denominator.
- Review links retain their full accessible labels and move focus to the chosen
  section. Only routine duplicate summaries are compacted.
- A two-file read-only fixture verified selection of the second file and collapse
  of the file list afterward. Paused-admission warning visibility was checked in
  the same fixture. No workspace policy or source data was changed by that fixture.
- 98 focused tests passed, including navigation/dialog lifecycles, collection
  totals, diff paging, task views, and asset/document contracts. Design-token and
  asset-graph checks also pass.

These are local Chromium mobile-emulation results, not hosted acceptance or
physical-device coverage. Validation was local; no deployment was performed.

## Current previews

- [Task queue, 390 px](assets/modernization/mobile-density-after-queue-390.png)
- [Candidates, 390 px](assets/modernization/mobile-density-after-work-390.png)
- [Changes, 390 px](assets/modernization/mobile-density-after-review-390.png)
- [Changes, 320 px](assets/modernization/mobile-density-after-review-320.png)
- [Multi-file selection and paused state, 320 px](assets/modernization/mobile-density-multiple-files-paused-320.png)
