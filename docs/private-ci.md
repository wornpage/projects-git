# Source CI

The included `.github/workflows/ci.yml` can run the same source checks on
pushes, pull requests and manual dispatch in a repository where Actions is
enabled. It grants read-only source access, pins GitHub actions to full commit
IDs and uses Node.js 24.19.0 on Ubuntu 24.04. It supplies no Cloudflare, Access,
Git-assignment or model-provider secrets and has no deployment step.

Actions is disabled on the public challenge repository. Run the entrypoint
locally, or in your own private CI environment when results must remain private.
Logs and receipts belong under ignored `qa/ci/`, outside the published source.

## Required checks

| Check | Passing condition |
| --- | --- |
| Locked dependencies | `npm ci` succeeds |
| Dependency audit | `npm audit --json --audit-level=high` succeeds, returns valid counts and reports zero high/critical findings |
| Runtime image | Existing verification Dockerfile builds for Linux/amd64; both base images have SHA-256 pins |
| Source and Docker tests | All discovered tests pass, with zero failures, cancellations, skips or todo cases |
| Worker types | `npm run typecheck` succeeds |
| Qualification types | Qualification TypeScript succeeds |
| Worker dry-run build | `npm run build` succeeds without deployment |
| Source identity | Tracked source stays unchanged throughout the run |

The combined runtime contains Node and Python. The runner inspects its immutable
local image ID and supplies that exact ID to `PROJECTS_SANDBOX_TEST_IMAGE`,
`PROJECTS_PYTHON_TEST_IMAGE` and `PROJECTS_HOSTED_TEST_IMAGE`. This enables Docker-dependent cases, including cancellation of a running busy
container. A missing Docker runtime fails the job; it does not produce a reduced
passing denominator.

Each invocation owns a unique temporary image tag. Rebuilding another checkout
cannot replace the reference that keeps this run's immutable image available.
The image ID and build log remain part of the private receipt.

The suite discovers new tests automatically. The receipt records the actual
total, passed, failed, skipped, cancelled and todo counts. No fixed count is
treated as timeless, and newly added tests do not change historical denominators.

The PowerShell entrypoint explicitly selects UTF-8 for native command output.
This keeps Node's summary readable when a Windows parent console uses an OEM
code page. Corrupted or missing count lines fail receipt validation; the runner
does not infer a passing population from an exit code alone.

## Patched development dependency

The current Wrangler release uses Miniflare `5.20261001.0-alpha`, which pins
`sharp` `0.35.4`. A scoped npm override replaces that consumer's dependency with
patched `0.35.5`, including the matching platform binaries and libvips packages.
There is one resolved renderer version. The advisory and patched release are
documented in [GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w).

The Projects Git maintainer owns this override. Remove it when the selected
Miniflare release directly resolves a patched sharp version, then verify a clean
locked install, the audit gate, native image rendering and full CI. The native
smoke test resolves sharp from Miniflare's own module context and checks an SVG
to PNG pixel round trip; its log records the loaded sharp and librsvg versions.

## Receipts and reproduction

With PowerShell 7, Node.js 24.19.0 and Docker's Linux engine running, execute from
a clean checkout:

```powershell
./scripts/ci.ps1
```

Each check writes its output and exit code under `qa/ci/`. `receipt.json` records
the checkout commit and tree, lockfile and Dockerfile hashes, actual runtime image
ID, runner identity and individual check outcomes. Phases are marked running
before execution; an unfinished phase cannot supply passing evidence.
`summary.md` reports the
denominator and scope. Local reruns retain earlier logs and receipts in a history
directory rather than replacing failed attempts.

The workflow uploads these files even after a failed check, using an artifact
name containing the commit, run ID and attempt. Artifacts are retained for 30 days;
their visibility follows the repository and CI settings; they are not indefinite
archival storage. Do not enable artifact uploads in a public repository when
those results must remain private. Runs are
bounded to 30 minutes, with a 25-minute check step that leaves time to upload
failure evidence. New pushes do not cancel an earlier active run on the same ref.

GitHub runner or artifact failures remain hosted CI failures or blocks, even if
local checks pass. These checks exercise source and Docker fixtures. Real Access,
Durable Objects, Artifacts, container qualification, model quality and human
acceptance keep their separate evidence in the qualification record.
