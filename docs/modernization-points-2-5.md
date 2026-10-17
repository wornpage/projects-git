# Modernization points 2–5

This pass finishes the four specific commitments that the earlier visual pass
only partially addressed. This records local validation before source commit;
it does not record deployment.

## Completion checks

| Point | Delivered | Evidence |
| --- | --- | --- |
| 2. Tokens | Shared type sizes, weights, line heights, tracking, spacing, control size and radii in `public/theme.css`. Six app stylesheets consume the scales. | `npm run check:design` passes and parses all six stylesheets without warnings. |
| 3. Borders | One outer surface per list or panel; nested panels, prerequisite groups, draft editors and record facts use spacing, separators or subtle backgrounds. | Desktop/mobile comparison and decision views checked, including expanded content. Input borders, warnings, selection and code boundaries remain meaningful. |
| 4. Actions | Existing workflow selectors provide stage-specific guidance. Collections emphasize one next task; candidate card actions are secondary. Review shows one section at a time and emphasizes that state's next action. | Seven owner screens at four widths; eight candidate states at desktop and phone widths; reviewer inbox/form state checks. |
| 5. Copy | Shortened creation, scope, project settings, continuation and decision guidance. Onboarding, project tools and candidate tools use labeled disclosures. Repeated decision guidance is hidden when the decision panel supplies it. | Main screen and dialog inspection; regression checks retain warnings, sample labels, revisions, counts and recovery explanations. |

## Shared scale

The tokens live in `public/theme.css`; `scripts/check-design-tokens.mjs` prevents
raw repeated typography, spacing and radius values returning to `styles.css`,
`workbench.css`, `reviewer.css`, `action-feedback.css`, `syntax.css`, and
`demo/demo.css`. Both pixel and relative-unit declarations are checked.

Layout widths, viewport breakpoints, hairlines and one-pixel accessibility
clipping remain local structural values. The pinned vendor button bundle is not
edited; application controls use the shared 44 px control-size token.

## Action-state checks

| Candidate state | Emphasized action |
| --- | --- |
| Passing checks, no decision | Inspect changes, then Review decision |
| Failed checks | Continue repair in your agent |
| Checks pending | Refresh check status |
| Missing check report with preserved checks | Run preserved checks |
| Accepted candidate | Merge accepted candidate, subject to existing guards |
| Merged candidate | View merged record |
| Advanced project base | Update candidate base |
| Independent review pending | Refresh review status |

The reviewer inbox emphasizes inspection. Its assessment form emphasizes
submission, or Add finding when Changes requested has no finding yet. Required
inputs and existing permission, evidence, comparison and version checks still
control availability. Choosing a section never runs checks or records a decision.

History emphasizes the first result in the current ordering and filter, keeping
every other exact-candidate link available. Setup dialogs retain their own
primary action. States requiring unavailable authority or missing inputs remain
blocked rather than inventing a successful action.

## Validation

- 238 focused regression tests passed, including recovery, publication guards,
  reviewer lifecycle, acceptance/merge separation, task creation and collections.
- Seven owner screens checked at 320, 390, 768 and 1440 px. No horizontal page
  overflow or runtime errors observed in those flows.
- Eight review-state fixtures checked at 390 and 1440 px, each with one enabled
  emphasized action in the tested eligible state.
- Reviewer inbox, submission and finding-required states checked at 320, 390 and
  1440 px with one emphasized action each.
- Review section focus, primary navigation, modal Escape dismissal, opener focus
  restoration, filtering and unchanged total denominators checked on desktop and
  phones. Task creation, Find work and settings dialogs inspected at these widths.
- Design-token validation, CSS parsing, asset graph and `git diff --check` passed.

Browser checks used Chromium viewport emulation and isolated local data. Accepted,
merged, pending-review and other state variations were read-only browser fixtures;
no assessment, acceptance, merge, deployment or publication was submitted by those
checks. These results do not claim physical-device or hosted acceptance coverage.

## Previews

- [Queue, desktop](assets/modernization/points-2-5-queue-1440.png)
- [Candidates, desktop](assets/modernization/points-2-5-work-1440.png)
- [Review, phone](assets/modernization/points-2-5-review-390.png)
- [Failed-check action, phone](assets/modernization/points-2-5-state-failed-390.png)
- [Accepted-candidate action, desktop](assets/modernization/points-2-5-state-accepted-1440.png)
- [Reviewer finding-required state, phone](assets/modernization/points-2-5-reviewer-form-390.png)
