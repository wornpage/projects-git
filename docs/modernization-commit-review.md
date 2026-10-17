# Modernization regression review

Reviewed the modernization and mobile-density changes against source baseline
`f8f0eb001a5e3f1d69512b64587f4ef374678533`. The reviewed source is committed as
`10ff7fd8df2b59c95baa35b0dc3b001381c02ad7`.
This is a local source review, not independent review or hosted acceptance.

## Findings resolved

- The sample creation note described every agent as scripted even when model
  execution was selected. It now describes the sample task and leaves execution
  mode to the explicit choice below it; the existing model-mode tests check this.
- The design-token guard was included in `npm run check` but omitted from the
  actual PowerShell CI entrypoint. CI now runs it before the build in the existing
  build phase and preserves its failure exit code.
- The package-script change invalidated the generated verifier fingerprint. The
  generated identity was refreshed and the fingerprint check passes.
- Cold-start test doubles lacked the native DOM `dataset` property, and the syntax
  contrast test read colors from the old stylesheet location. Fixtures now match
  the DOM and shared theme; contrast still must meet the original 4.5 ratio.

The first full test attempt also exposed a missing installed `jsonc-parser`
dependency. It was already declared in both manifests. Restoring dependencies
with `npm ci --ignore-scripts --no-audit --no-fund` resolved all 19 setup tests
without changing package versions, the lockfile, or setup validation.

## Validation

| Check | Result |
| --- | --- |
| Full test rerun (`npm test`) | 1,138 passed, 0 failed, 13 skipped; 1,151 total |
| Application and qualification TypeScript checks | Passed |
| Design tokens, CSS parsing, entrance asset graph, verifier fingerprint | Passed |
| Main, demo, subscriptions and entrance builds | Passed; all four used dry-run mode |
| PowerShell CI syntax and staged whitespace checks | Passed |
| Preview links | All 19 local image links resolve |

The 13 skipped tests require Docker and pinned verification images. They are not
counted as passing. The final full rerun completed in 674.3 seconds after the
fixture corrections and dependency restoration; no additional failures remained.

Desktop and mobile browser evidence is recorded in
[the initial validation](modernization-validation.md),
[points 2–5](modernization-points-2-5.md), and
[mobile density validation](mobile-density-validation.md). Checks cover 320,
390, 768 and 1440 px, including navigation, keyboard focus, filtering, count
denominators, review states and diff-file selection. The final density pass puts
the first task, candidate and diff content at 262, 310 and 410 px respectively
on a 390 px phone viewport, with desktop positions unchanged.

Browser results use local Chromium emulation and isolated sample data; they do
not establish physical-device or hosted coverage. Selected screenshots are
included under `docs/assets/modernization`; scratch captures and logs are excluded.
No deployment or remote publication was performed.
