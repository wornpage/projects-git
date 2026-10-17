# Workbench modernization validation

This records the initial visual pass. The specific points 2–5 are completed and
validated separately in [Modernization points 2–5](modernization-points-2-5.md).

## Delivered scope

The project directory, task queue and brief, candidate list, Changes & checks,
project history, candidate record, shared dialogs, and independent reviewer
interface now use a consistent warm-and-teal visual language.

`public/theme.css` owns shared design tokens. `public/workbench.css` owns owner
screen and dialog presentation; `public/styles.css` retains layout primitives.
`public/reviewer.css` owns the separate reviewer layout using the shared tokens.
The earlier workflow-only stylesheet and obsolete project-list sidebar rules
were removed. The demo welcome page also loads the extracted theme.

Counts retain their scope and denominators. Execution, checks, independent review,
owner acceptance, integration and deployment remain distinct. No changes were made
to their authority or permission rules. The pinned button bundle is unchanged.

## Local validation

| Check | Result |
| --- | --- |
| Focused UI, recovery, review, scaling, asset and document tests | 200 passed, 0 failed |
| Seven owner screens | Checked at 320, 390, 768, 900 and 1440 px |
| Seven shared dialogs | Checked at 320, 390 and 1440 px; no horizontal overflow |
| Reviewer inbox and assessment form | Checked at 320, 390 and 1440 px using intercepted fixture data |
| Browser runtime | No JavaScript errors observed in the checked flows |
| Accessibility automation | No axe WCAG A/AA violations in checked states |
| Keyboard checks | Escape dismissal, opener focus restoration, review-section focus, and modal background exclusion checked |
| Asset packaging | Closed demo asset graph includes the new stylesheets |

The owner axe pass covered the seven screens plus task creation, project settings,
and Find work at desktop and phone widths. Manual-review items were inspected:
popup references resolve to the existing dialog; native select arrows account for
the gradient contrast uncertainty; brand and picker text contrast is approximately
13.25:1. The reviewer recheck reported no automatic violations or incomplete items.
Semantic roles were corrected for filters, draft/report groups, disabled-action
explanations, and the scrollable diff. Native modal focus can leave the document
for browser chrome, but cannot reach background application controls.

These checks used Chromium viewport emulation and local fixtures. They are not a
claim of exhaustive accessibility conformance, physical-device coverage, hosted
acceptance, or independent code review. No reviewer assessment was submitted.

## Previews

- [Project directory, desktop](assets/modernization/modernization-projects-1440.png)
- [Project directory, phone](assets/modernization/modernization-projects-390.png)
- [Project history, desktop](assets/modernization/modernization-history-1440.png)
- [Project history, phone](assets/modernization/modernization-history-390.png)
- [Task composer, phone](assets/modernization/modernization-new-task-320.png)
- [Project settings, phone](assets/modernization/modernization-project-settings-390.png)
- [Reviewer inbox, desktop](assets/modernization/modernization-reviewer-inbox-1440.png)
- [Reviewer assessment, phone](assets/modernization/modernization-reviewer-form-320.png)

Source baseline: `f8f0eb001a5e3f1d69512b64587f4ef374678533` plus the local
working-tree changes in this chat. This report was recorded before source commit;
no deployment was performed.
