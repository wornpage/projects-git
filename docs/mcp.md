# Connect a coding host through MCP

Projects Git includes a local **stdio MCP server using the TypeScript SDK v2**.
Your coding host launches it, and it connects to the hosted workspace through the
same `HostedAgentClient` used by the CLI. Both interfaces share command handling,
private credentials, request receipts and the Worker's builder permissions.

The MCP server supplies tools, not a model. The existing CLI remains supported.

## Configure the host

1. From a Projects Git source checkout, install locked dependencies with `npm ci`.
   Node.js 24.19+ is required; Git is used by your coding host to make commits.
2. Prepare the existing [private hosted connection file](hosted-agent-client.md).
   It must identify an allowlisted builder service identity. Store it outside Git,
   with owner-only filesystem permissions. Give independent builders separate
   identities and files.
3. Configure your coding host to launch **Node directly** with these arguments:

```sh
node /absolute/projects-agent-git/scripts/agent-mcp.mjs --connection /absolute/private/builder.json
```

For hosts that use an `mcpServers` JSON configuration, the equivalent is:

```json
{
  "mcpServers": {
    "projects-git": {
      "command": "node",
      "args": [
        "C:/absolute/projects-agent-git/scripts/agent-mcp.mjs",
        "--connection",
        "C:/absolute/private/builder.json"
      ]
    }
  }
}
```

Replace the example paths. Use the full Node executable path if your host cannot
find `node`. Any working directory is supported. Keep secrets in the connection
file; do not put them in tool arguments, chat, recordings or host configuration.
Launch Node directly because npm banners would interfere with the stdio protocol.

Restart or reconnect the host and inspect its tool list. Start with
`projects_git_list_projects`, then `projects_git_project_status` for a returned
project ID. A workspace read verifies the configured identity and workspace;
listing tool definitions alone does not establish authenticated access.

The SDK serves both the `2026-07-28` protocol and older clients from the same
entry point. “v2” refers to the SDK, not a new app API. This adapter has no listening
HTTP port, public `/mcp` route, browser WebMCP registration or OAuth enrollment.

## Available tools

Every name has the `projects_git_` prefix.

| Tool | What it does |
| --- | --- |
| `list_projects` | Discover project IDs, admission state and browser links |
| `project_status` | Read the queue, prerequisites, candidates, counters and capacity |
| `get_task` | Read requirements, commit details and evidence for a task |
| `claim` | Reserve eligible work for this builder, or report idle |
| `checkout` | Clone its assigned fork into a new absolute directory; optional `assignment` imports a private owner-issued resolution file |
| `start` | Report that this builder has started its assignment |
| `push` | Push the exact committed head to the assigned fork and branch |
| `submit` | Submit an exact commit for independent checks and review; optional `directory` performs the guarded push first and retains its child receipt |
| `fail` | Retain an assignment's failure and release its execution reservation |
| `receipt` | Read this connection's retained operation attempts without network I/O |
| `locks` | Inspect local operation ownership and process state without network I/O |
| `release_lock` | Explicitly release an exact stopped owner's local locks; requires its original request UUID and lock UUID; no provider action |

The coding host edits and commits using its own tools between `start` and `push`.
The connection fixes the origin, workspace and builder identity at startup; tools
cannot replace them. Unknown arguments are rejected. The server exposes no tools
for project creation, policy changes, verification, independent review, acceptance
or merge. Those keep their existing authenticated interfaces and rules.

## Requests, interruptions and retries

Every mutation requires an explicit `requestId` UUID. Keep it with the returned
result. A new operation needs a new UUID; an explicit retry reuses the original
UUID and exact inputs. A transport's JSON-RPC request ID is separate from this
durable operation ID.

The client records mutation intent before I/O. Errors and lost responses retain
attempt receipts; no mutation is retried automatically. Read `receipt` and current
status before deciding what to do next. MCP and CLI use the same private state
directory, so either can inspect an operation begun by the other.

The same connection's request and run locks coordinate CLI and MCP processes. A
push also holds its physical checkout lock across connection profiles. Different
runs may proceed across clients, except while a claim is retaining its issued-once
credential. These cooperative local locks do not replace hosted authorization or
protect against ordinary Git commands, old clients or other machines.

Only one mutation runs at a time in each MCP process. A competing mutation returns
an error before starting; reads remain available. Cancellation or a disconnected
host does not prove an admitted API/Git operation stopped. An admitted operation
keeps its reservation in the MCP process until it finishes; after a process exit,
inspect the durable receipts and remote state. Workspace-wide execution limits
remain enforced by the hosted controller across all builders.

An interrupted process can leave local locks. Read `locks` and `receipt`; their
counts describe local history, not current remote success. Unknown attempts stay
visible even after a later reconciliation succeeds. Only an explicit `release_lock`
with the original request UUID and exact lock UUID may release a confirmed stopped
owner. Active, unknown or reused process IDs block release. It does not retry work,
restore credentials or change remote state. Incomplete or altered lock metadata can
require manual inspection. See [CLI recovery](hosted-agent-client.md#overlapping-commands-and-stopped-processes)
for the shared recovery sequence and limitations.

Git credentials retain the client's existing 15-minute lifetime and issued-once
behavior. MCP never returns them. A lost claim response cannot recreate a missing
credential. A lost push response can be reconciled by an explicit same-ID retry:
the client first reads the remote head and does not push an already-present commit.
Successful submission and failure retire the local assignment credential.

Results are redacted before JSON encoding and returned as both text and structured
data. Results above 2 MiB return an explicit display-limit error; inspect the CLI
or the retained receipt rather than repeating a mutation. Request messages are
bounded to 128 KiB. Diagnostics go to stderr; stdout carries only MCP messages.

## Validation

```sh
node --test tests/hosted-mcp.test.mjs tests/hosted-agent-client.test.mjs tests/hosted-client-locks.test.mjs tests/repository-cli.test.mjs tests/git-transport.test.mjs
```

These tests use the real SDK and stdio process, controlled API fixtures and native
local Git repositories. They cover discovery, strict arguments, identity and
assignment refusal, redaction, CLI parity, receipts, competing requests, cancellation,
restarts and a lost Git push response. They do not establish a fresh Cloudflare
qualification or connect the adapter to a live workspace.

The implementation follows the official [SDK v2 stdio guidance](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio).
## Project pagination

`projects_git_list_projects` returns ten projects and `page.totalProjects`,
`page.nextOffset` and `page.revision`. Continue with `offset` and `revision` from
that result. If the revision changed, start a fresh listing rather than mixing
pages. Status and task reads load one complete project; execution capacity stays
workspace-wide. Mutation replies contain the affected project.
