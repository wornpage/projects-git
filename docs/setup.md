# Set up Projects Git on Cloudflare

Projects Git's primary deployment is a private workspace hosted on Cloudflare.
Fork the MIT-licensed source, configure your own Cloudflare account and resources,
and deploy a workspace protected by Cloudflare Access. Your installation uses
your own repositories, identities and credentials.

Local mode supports development and testing. It provides a separate local Git
workspace.

## Choose a starting point

| Goal | Path | Requirements |
| --- | --- | --- |
| Deploy your own private workspace (recommended) | Follow [independent Cloudflare setup](independent-setup.md) | Your own Cloudflare account, resources, Access owner configuration and distinct builder/reviewer identities |
| Develop or inspect the application locally | `npm run dev` | Node.js 24.19+, npm and Git |
| Run the complete source check | `pwsh -NoProfile -File scripts/ci.ps1` | PowerShell 7, Git and Docker's Linux engine running |
| Explore the optional read-only example | `npm run dev:demo` | Node.js 24.19+, npm and the installed source dependencies |

Already have a hosted workspace? [Choose an Artifacts repository and load its
base commit](hosted-project-setup.md) directly in **New project**.

## Install

From the repository or extracted archive root:

```sh
npm ci
npm run setup:check
```

Use the checked-in lockfile and a separate dependency install. The repository
includes Wrangler as a local development dependency. A global Wrangler or CLI
installation is not required.

`setup:check` checks offline prerequisites without starting the app or contacting
a provider. Add `-- --docker` to query the configured Docker Linux engine, or use the
[independent setup guide](independent-setup.md) for literal hosted configuration
checks. A pass does not establish startup, verification or hosted acceptance.

## Deploy a private Cloudflare workspace

Continue with [independent Cloudflare setup](independent-setup.md). That guide
covers private operator configuration, your account's resources and identities,
offline configuration checks, deployment and private workflow verification.

Keep default and preview endpoints disabled, and establish Access protection
before activating a hostname. Use your operator configuration explicitly for
deployment. An offline pass does not establish resource availability, valid
credentials, protected routes or a successful hosted workflow.

Keep model execution and semantic embeddings disabled until you deliberately
configure their credentials and budgets. The default Access configuration
refuses workspace access until the owner and permitted identities are configured.

## Work with a local project

Use this mode for local development and testing. It does not require a Cloudflare
account.

```sh
npm run dev
```

Open the loopback address printed by the server, normally
`http://127.0.0.1:4178`. Choose **New project** and connect a committed repository
or the trusted checkout starter. Workspace records are stored as JSON files under
`.local/`, alongside owned Git copies. Local attribution is explicitly labeled;
it is separate from the hosted authenticated ownership model. The local server
does not provide the hosted D1 search backend or Cloudflare Access authentication.

Choose **Project settings → Connect agent → Copy agent instructions** and give
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

## Explore the read-only example

This optional example supports local exploration without setting up a hosted
workspace:

```sh
npm run dev:demo
```

Open `http://127.0.0.1:8894` and choose **Explore a completed project**. Open the
project's **Task queue** and select a task for its brief. Browse **Candidates**,
then open a result's **Changes & checks** and **Candidate record**. The example
contains clearly labeled invented records, including passing and failing
alternatives and a queued follow-up. Browsing does not run an agent or contact
the real workspace.

This entry uses local Workerd and static assets. It needs no Cloudflare account,
sign-in, model key or Docker runtime. The source configuration disables public
and preview routes. Stop the local process with Ctrl+C when finished.

## Check the source

Start Docker Desktop's Linux engine, then run from a clean Git checkout. The
complete CI receipt uses commit metadata, so this command needs a clone rather
than an extracted source ZIP:

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
- If a demo port is occupied, choose unused application and inspector ports and
  invoke the installed CLI directly from the source root:

  ```sh
  node node_modules/wrangler/bin/wrangler.js dev --local --config wrangler.demo.jsonc --ip 127.0.0.1 --port 8895 --inspector-port 9295
  ```

  `npm run dev:demo` already supplies both port flags; appending them repeats
  those arguments. For the working server, set the `PORT` environment variable.
- `npm run build` also needs Docker's Linux engine, including its dry-run
  container-image build. Start the engine before building or running the full
  checks. A reduced test population is not the full CI result.
- For an interrupted local workspace, preserve `.local/`. A graceful stop releases
  `.local/server.lock`; a forced stop can leave that lock behind and prevent startup.
  Verify that all servers using this data directory are stopped before deliberately
  removing only the stale `server.lock` file. Preserve every other workspace file
  and restart normally so retained operations can be reconciled.
