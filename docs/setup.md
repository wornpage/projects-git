# Start Projects Git locally

Use a source checkout or a source archive from this repository. The application
source uses the MIT license. Hosted operation requires your own Cloudflare
resources and identity configuration.

## Choose a starting point

| Goal | Command | Requirements |
| --- | --- | --- |
| Explore a completed project | `npm run dev:demo` | Node.js 24.19+, npm and the installed source dependencies |
| Create local projects and queue work | `npm run dev` | Node.js 24.19+, npm and Git |
| Run the complete source check | `pwsh -NoProfile -File scripts/ci.ps1` | PowerShell 7, Git and Docker's Linux engine running |
| Configure a private hosted workspace | Follow [operator setup](qualification-setup.md) | Your own Cloudflare account, Access owner configuration and bounded agent/reviewer credentials |

## Install

From the repository or extracted archive root:

```sh
npm ci
```

Use the checked-in lockfile and a separate dependency install. The repository
includes Wrangler as a local development dependency. A global Wrangler or CLI
installation is not required.

## Explore the read-only example

```sh
npm run dev:demo
```

Open `http://127.0.0.1:8894` and choose **Explore a completed project**. Follow
Queue → Agent work → Review → Evidence. The example contains clearly labeled
invented records, including passing and failing alternatives and a queued
follow-up. Browsing does not run an agent or contact the real workspace.

This entry uses local Workerd and static assets. It needs no Cloudflare account,
sign-in, model key or Docker runtime. The source configuration disables public
and preview routes. Stop the local process with Ctrl+C when finished.

## Work with a local project

```sh
npm run dev
```

Open the loopback address printed by the server, normally
`http://127.0.0.1:4178`. Choose **New project** and connect a committed repository
or the trusted checkout starter. Project records and owned Git copies are stored
in `.local/`. Local attribution is explicitly labeled; it is separate from the
hosted authenticated ownership model.

Choose **Project controls → Connect agent → Copy agent instructions** and give
those instructions to your existing coding conversation. The host runs the
agent; the project holds its queue, commits, checks and review record. To inspect
the source CLI directly:

```sh
node scripts/repository-work.mjs --help
```

Read [connected repositories](connected-repositories.md) for ordinary code,
[agent workflow](agent-workflow.md) for claims and submissions, and
[repository verification](repository-verification.md) for exact-commit checks.
Independent checks on ordinary code require Docker and an explicitly selected
immutable runtime image. The trusted starter's scripted proof has its own scope.

## Check the source

Start Docker Desktop's Linux engine, then run from a clean source checkout:

```sh
pwsh -NoProfile -File scripts/ci.ps1
```

This installs locked dependencies, audits them, builds the pinned Node/Python
verification image, runs every discovered test with Docker cases enabled,
checks Worker and qualification types, and performs the main/demo/subscription
Worker dry-run builds. A skipped or failed phase does not count as a passed check.
It writes commit-specific results under `qa/ci/`, including the actual discovered
test denominator. `qa/` is excluded from the source archive.

See [source CI](private-ci.md) for exact image pins, receipt fields and retained
failure handling. These are local source/runtime checks, separate from real
Cloudflare Access, Artifacts, container qualification, deployment and submission.

## Startup troubleshooting

- If Node reports an unsupported engine, install Node.js 24.19 or later, then
  run the locked install again.
- If a port is occupied, stop the other instance or select a free one. For the
  demo, `npm run dev:demo -- --port 8895 --inspector-port 9295` supplies alternate
  local ports. For the working server, set the `PORT` environment variable.
- If Docker-dependent checks cannot reach the engine, start its Linux engine
  and rerun the full check. A reduced test population is not the full CI result.
- For an interrupted local workspace, preserve `.local/`. A graceful stop releases
  `.local/server.lock`; a forced stop can leave that lock behind and prevent startup.
  Verify that all servers using this data directory are stopped before deliberately
  removing only the stale `server.lock` file. Preserve every other workspace file
  and restart normally so retained operations can be reconciled.

Hosted configuration is an operator step. Keep model execution and semantic
embeddings disabled unless their credentials and explicit budgets are supplied.
The default hosted Access configuration refuses workspace access until the owner
and permitted agent/reviewer identities are configured.
