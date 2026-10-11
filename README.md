# Projects Git

A Git workspace where coding agents can keep working across tasks and sessions.
Projects holds the queue, isolated candidate branches, checks and review history;
your existing coding host runs the agents. An owner-enabled policy can integrate
eligible changes automatically after current checks and independent review pass.

## How it works

- **Keep agents moving.** Queue tasks with requirements and prerequisites. Agents
  claim isolated work while other assignments continue.
- **Retain context.** Keep alternative commits, failed attempts and earlier
  decisions when requirements or the project base change.
- **Check the exact change.** Checks and independent review bind to the commit
  and requirements they assessed. Changed inputs make that evidence stale.
- **Choose integration policy.** Manual acceptance and merge are separate actions.
  Optional [automatic integration](docs/automatic-merge.md) handles eligible
  changes under an owner-enabled project policy; failed or stale gates stop it.

The current hosted model is one authenticated owner with restricted builder and
reviewer identities. Team administration is planned. The workspace has four
shared execution slots and a separate limit of two verification attempts.

## Try it locally

Requires Node.js 24.19+ and npm:

```sh
git clone https://github.com/wornpage/projects-git-challenge.git
cd projects-git-challenge
npm ci
npm run dev:demo
```

Open **http://127.0.0.1:8894** and choose **Explore a completed project**. The
read-only example uses the real workbench with clearly labeled fictional records.
It needs no account, model key or Docker runtime.

To connect your own committed Git repository:

```sh
npm run dev
```

Open the printed address and choose **New project**. Git is required; independent
checks on ordinary code also require Docker and a selected immutable image.
See [setup and troubleshooting](docs/setup.md).

## Connect your coding agent

Choose **Project controls → Connect agent → Copy agent instructions** and give
those instructions to your coding conversation. Its host runs the agent.

```sh
node scripts/repository-work.mjs --help
```

Use [the local agent workflow](docs/agent-workflow.md),
[a private hosted connection file](docs/hosted-agent-client.md), or
[the MCP setup](docs/mcp.md). Hosted builders can claim, check out, start, push
and submit their assignments. The server enforces identity and permissions;
builders cannot accept or merge candidates.

## Built on Cloudflare

| Component | Responsibility |
| --- | --- |
| Workers + Access | Authenticated API and separate owner, builder and reviewer permissions |
| Durable Objects + SQLite | Workspace state, reservations, decisions and recovery |
| Artifacts | Project repositories, isolated agent forks and Git commits |
| Containers | Independent command checks on submitted code |
| Queues | Artifacts push notifications and reconciliation with repository refs |
| D1 | Searchable retained project history |

The local adapter uses owned Git copies and Docker. Both adapters share workflow
rules and the browser workbench. Hosted operation requires your own Cloudflare
resources and identity configuration. Public and preview routes are disabled in
the supplied configuration; configure Access before exposing a workspace.

| Guide | Purpose |
| --- | --- |
| [Source map](docs/source-map.md) | Find implementation modules |
| [App model](docs/app-model.md) | Understand tasks, retained work and counters |
| [Independent review](docs/independent-review.md) | Review and decision boundaries |
| [Authenticated ownership](docs/authenticated-workspace.md) | Owner, builder and reviewer permissions |
| [Cloudflare guide](docs/cloudflare.md) | Hosted architecture and API |
| [Operator setup](docs/qualification-setup.md) | Configure your own hosted workspace |

## Check the source

With PowerShell 7, Git and Docker's Linux engine running:

```sh
pwsh -NoProfile -File scripts/ci.ps1
```

This installs locked dependencies, audits them, runs tests and type checks, and
builds the Workers without deploying them. See [source CI](docs/private-ci.md).
Local results are written to ignored `qa/ci/`; they are not part of this source
repository. GitHub Actions is disabled on this challenge repository.

## Source and license

This repository starts a fresh history from the reviewed `c045d30` source
snapshot. Publication changes remove private operational records, media and
deployment identifiers, remove the demo's private qualification display, and
adapt setup documentation and examples for this standalone repository. The
workspace authorization, review, integration and policy-propagation logic is
unchanged. The generated verifier identity is refreshed when its source inputs
change.

[MIT](LICENSE). This is an independent Cloudflare competition prototype in the
Projects family. Third-party assets retain their included license notices.
