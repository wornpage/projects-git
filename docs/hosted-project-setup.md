# Connect an existing Artifacts repository

In the hosted app, choose **New project**, give it a display name and choose an
**Artifacts repository**. The app loads that repository’s current default branch
and full commit. Confirm the displayed base with **Use this commit · continue to
task**, then describe the first task. No terminal lookup or browser-held Artifacts
token is required.

| Form field | Value to use |
| --- | --- |
| Project name | Your display name for this project |
| Artifacts repository | Select an existing repository from the workspace’s configured namespace |
| Base commit · full Git ID | Loaded read-only from that repository’s default-branch head |

**Previous**, **Next** and **Refresh list** browse at most 20 names per page, with
the full namespace total visible. **Refresh current base** reads the latest head.
An empty branch, a provider error or an unfinished lookup cannot advance to task
creation. Switching selections ignores earlier responses. The server checks the
head again when creating the project, so a changed base must be refreshed.

Discovery is available only to the configured owner. Agents and reviewers cannot
enumerate the namespace. Reads use the existing server-side `ARTIFACTS` binding,
return only repository names, totals, branch and commit, and create no Git tokens,
forks or task records. Repositories already connected to this workspace should be
opened through their existing project to queue more work.

## Operator verification (optional)

The commands below independently check the metadata used by the picker. They are
not required for ordinary browser setup.

Use the namespace configured on the deployed workspace Worker’s `ARTIFACTS`
binding. If someone else operates the workspace, ask them for that namespace.
Repository names are unique within a namespace; a repository with the same name
in another namespace is a different repository.

With Wrangler installed and signed in to the correct Cloudflare account, replace
the placeholders below. From a Projects Git source checkout, `npm ci` installs
the pinned Wrangler dependency; `npx` uses that local installation.

```sh
npx wrangler artifacts repos list --namespace "<namespace>" --json
npx wrangler artifacts repos get "<repository>" --namespace "<namespace>" --json
```

The selected repository’s metadata supplies `name`,
`default_branch` and the exact `remote` URL. These are read-only commands; they
do not create a repository, mint credentials or push code. See Cloudflare’s
[repository commands](https://developers.cloudflare.com/artifacts/api/wrangler/)
and [repository identity](https://developers.cloudflare.com/artifacts/concepts/repositories/).

## Read the current default-branch commit

Use Git with your existing access to that repository and the exact `remote`
returned above:

```sh
git ls-remote --symref "<remote>" HEAD
```

For example, output might look like this. Your branch and commit will differ:

```text
ref: refs/heads/main HEAD
0123456789abcdef0123456789abcdef01234567 HEAD
```

Compare the full hexadecimal ID from the line ending in `HEAD` with **Base commit**.
The `ref:` line identifies the actual default branch; it need not be `main`.
This reads the remote without switching branches, fetching files or changing
your checkout. A local `git rev-parse HEAD` can name an unpushed or different
branch, so it is not a substitute for checking this remote head.

An empty repository or missing default-branch head needs a committed default
branch before it can be connected. If the command is denied, use the repository
access arranged by your operator. A Projects Access session or Wrangler sign-in
does not itself authenticate your Git client. Artifacts uses separate repo-scoped
Git credentials; follow [Cloudflare’s Git authentication guide](https://developers.cloudflare.com/artifacts/guides/authentication/).
Keep tokens and authenticated URLs out of the project form.

## API boundary

`GET /api/repositories` accepts only an optional `cursor` and returns
`workspaceId`, `repositories: [{name}]`, `total` and `nextCursor`.
`GET /api/repositories/head?name=REPOSITORY` returns `workspaceId`, `name`,
`defaultBranch` and `baseCommit` (null when the default branch has no commit).
Both routes require the owner at the Worker and controller boundaries. They
accept no caller-selected namespace, account, remote or credential. Provider
reads are bounded to ten seconds and recheck the current workspace/session
binding after I/O. Provider errors are sanitized; responses are not cached.

Local Git setup retains its repository-path field and **Read current commit**
action. The repository picker is a hosted feature. A missing discovery capability
is shown explicitly rather than treating an unavailable provider as an empty list.

This guide connects existing private code. It does not alter Access, configure
agents, grant repository permissions, enable model execution or publish anything.
