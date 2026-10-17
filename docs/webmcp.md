# Private read-only browser tools

Projects Git registers four native WebMCP tools only while this page has a
current authenticated Cloudflare Access session for a hosted workspace. The
tools use the browser's `document.modelContext.registerTool()` API and an
`AbortController`; aborting that generation unregisters every tool owned by the
page. There is no navigator API, legacy fallback or polyfill.

The implementation follows the current [Chrome imperative API](https://developer.chrome.com/docs/ai/webmcp/imperative-api)
and the [WebMCP Community Group report](https://webmachinelearning.github.io/webmcp/).
Registration uses the default same-origin exposure. No `exposedTo` origins are
supplied.

| Tool | Read | Complete denominator |
| --- | --- | --- |
| `projects_git_list_repositories` | `GET /api/projects/catalog` | Accessible repository total, matched total, offsets, limit and source revision |
| `projects_git_list_project_tasks` | `GET /api/workspace?limit=1&project=UUID` | Every task and candidate in the selected accessible repository, plus workspace totals and page revision |
| `projects_git_get_task_status` | `GET /api/workspace?limit=1&task=UUID` | The exact selected task and all of its candidate summaries from the complete project page |
| `projects_git_get_operational_metrics` | `GET /api/projects/UUID/metrics` | Validated repository-history phase, usage and missing-data denominators |

Each schema rejects unknown properties, invalid UUIDs and unbounded paging before
network access. Implementations construct only these fixed same-origin GET paths.
They accept no URL, remote reference, command, request body or mutation key.
Backend repository permissions remain authoritative; a denied read stays denied.

Results are closed JSON strings marked with `readOnlyHint: true`,
`untrustedContentHint: true` and `consequentialHint: false`. They contain bounded
status metadata, counts and revisions. They exclude credentials, authentication
configuration, raw events, diffs, logs, exports and identity details. A result
over 256 KiB fails explicitly instead of truncating a collection or relabeling a
loaded page as a workspace total.

Every callback checks the registration generation, workspace, principal, session
and caller abort signal before and after its asynchronous read. A session or
principal change, authentication or connection failure, unsupported browser, or
`pagehide` aborts all four registrations. Registration is asynchronous and
serialized across generations. If any registration fails, the whole generation
is aborted and the workspace help reports that browser tools are unavailable;
other tools registered by the document are never touched.

These browser tools are a private read surface. They do not establish hosted
qualification, perform provider work, approve a candidate, publish a repository,
merge code or deploy the application.
