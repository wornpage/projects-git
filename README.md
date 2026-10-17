# Projects Git

A private Cloudflare workspace for coordinating coding agents and keeping their
Git candidates, checks and review history together. Your existing coding host
runs the agents. Projects Git holds the queue, isolates their work and guards
decisions and integration.

## Start on Cloudflare

Deploy your own workspace using your Cloudflare account, resources and verified
identities. Begin with [independent setup](docs/independent-setup.md) and the
[setup guide](docs/setup.md).

```sh
git clone https://github.com/wornpage/projects-git.git
cd projects-git
npm ci
npm run setup:check
```

The checker reads offline prerequisites; it does not provision resources or prove
a hosted installation. Keep operator configuration and secrets outside source
control. Configure Cloudflare Access before exposing a workspace; the supplied
configuration disables default and preview endpoints.

## Cloudflare components

| Component | Responsibility |
| --- | --- |
| Workers and Access | Private app, authenticated API and verified identities |
| Durable Objects and SQLite | Workspace records, decisions and recovery journals |
| Artifacts | Repositories, isolated candidate forks and Git objects |
| Containers | Independent command checks |
| Queues and D1 | Push notifications, reconciliation and retained-history search |

See the [hosted architecture and API](docs/cloudflare.md).

## Included tools

| Addition | What it provides |
| --- | --- |
| [Installation readiness](docs/independent-setup.md) | Offline setup reports and an owner view that separates prerequisites, configuration and hosted verification. |
| [CLI recovery](docs/hosted-agent-client.md) | Explicit request receipts and local ownership locks for interrupted agent operations; uncertain effects are preserved rather than blindly retried. The [MCP interface](docs/mcp.md) uses the same hosted client. |
| [Repository permissions](docs/repository-access.md) | Owner-managed grants for verified members, builders and independent reviewers. Repository access and owner decision powers stay separate. |
| [Operational metrics](docs/operational-metrics.md) | Queue, execution, verification, review and recovery observations with complete denominators and visible missing data. Unknown usage or cost stays unknown. |
| [Backup and historical recovery](docs/workspace-backup.md) | Bounded complete metadata archives, separately packaged Git objects and immutable history restoration into a workspace with no active work or provider ledgers. Prior jobs, grants and approval do not become active; original resource names remain quarantined. |
| [Optional GitHub delivery](docs/github-publication.md#deliver-a-hosted-merged-candidate-from-your-machine) | Deliver an exact hosted merged candidate to a private GitHub PR from the operator's machine. Approval binds the source and destination; GitHub credentials stay local. |

Browser agents can inspect connected repositories, task status and operational
metrics through the [WebMCP tools](docs/webmcp.md) in a supporting browser. The
tools use the signed-in user's repository permissions and return explicit page
totals. Repository text remains untrusted data.

## Work through the queue

Use **New project → Create repository** for a private Artifacts repository with
an initial commit, or **Connect code** for an existing repository. Queue a task,
then choose **Project settings → Connect agent → Copy agent instructions** and
give them to your coding host. Agents submit isolated commits. Current checks
and independent review precede owner acceptance and guarded integration.

[Automatic integration](docs/automatic-merge.md) starts off. An owner-enabled
policy can handle eligible candidates after the required checks and review;
alternatives and exceptions need an owner choice. Changed code, requirements or
bases require renewed evidence. Checks, review, acceptance, merge and deployment
remain separate facts; merging does not deploy.

The [repository catalog](docs/collection-navigation.md) puts work needing attention
first within the loaded page. Filters show their scope and denominators;
**Find work** searches project names across accessible repositories.

## Local development and verification

Use `npm run dev` for the separate local Git adapter. The optional
`npm run dev:demo` opens a read-only example with clearly labeled fictional
records; it needs no Cloudflare account or model key. See [setup](docs/setup.md)
for Git, Node.js and Docker requirements.

[Explore the public read-only sample](https://git-demo.projectsdemo.org/?view=projects).
It uses fictional records and is separate from private workspaces.

Source tests include disposable Git, SQLite restart, permission, replay and
mock-provider fixtures. They establish the behavior tested locally; they do not
establish an independent account's hosted installation. See
[source checks](docs/private-ci.md) for the complete local check procedure.

**Maintainer hosted check — 2026-10-17 UTC:** Source `b0155c85f596b9339273d2ff06ff98a6787ba69b`
was deployed privately as Worker version `8bfc8530-cf58-4908-a6bb-fd5617aeb165`.
Owner UI/API checks covered the catalog, installation, permissions, metrics and
complete metadata export/preview. All four native WebMCP reads passed (4/4);
anonymous private-route checks passed (6/6). Workspace records stayed unchanged.

This is an existing-account read/UI smoke check. Independent-account setup, live
agent workflows, historical restoration and external GitHub delivery remain
unqualified.

## License and provenance

[MIT](LICENSE). Third-party assets retain their included notices. See the
[source provenance](docs/source-map.md#source-provenance). The
[preserved challenge source and README](https://github.com/wornpage/projects-git/blob/7196e7495dcec32a59f4c88e3d021987ffc29fe9/README.md)
are historical provenance; subsequent product work is recorded in Git.
