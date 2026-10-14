# Create or connect an Artifacts repository

## Create a private repository

In **New project**, choose **New project · Create repository**. Enter a repository
name and, optionally, a description, then choose **Create repository**. The name
also becomes the project name. The app creates a private repository in the
workspace's configured Artifacts namespace, commits `README.md` on `main`, and
opens the new project's first-task form. Creating a repository does not queue a
task, start an agent, make model calls, or deploy code.

Names use 1–100 letters, digits, dots, underscores or hyphens and start with a
letter or digit. Descriptions are limited to 500 characters and are included in
the README. An existing name is refused without changing that repository; choose
another name or use the existing **connect code** option.

If the result is interrupted, choose **Retry this repository**. The browser
keeps the original name, description and request ID through reload in the same
tab and owner session. Retrying resumes the retained attempt; it does not choose
a new repository name. A still-running attempt may need up to one minute before
retrying after a server restart. Sign in again if the session expired. A changed
repository identity, ownership marker or initial commit requires operator review;
the app preserves the partial result and does not overwrite or delete code.

## Connect existing code

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

`POST /api/repositories` requires the authenticated owner, a valid
`Idempotency-Key`, and `{ "name": "customer-portal", "description": "Optional" }`.
Only these fields are accepted; no account, namespace, remote or visibility is
caller-selected. A successful response contains `workspaceId`, `projectId`,
`name`, `defaultBranch`, `baseCommit` and `replayed`. It returns no Git token or
credential-bearing URL. Reusing an ID with different normalized input is refused.

The coordinator reserves the repository name and project ID before provider I/O.
The existing Artifacts binding creates the repository. A server-owned marker in
its description binds recovery to the saved operation; the optional description
is retained alongside it. The existing bounded Git transport pushes a deterministic
README root commit only while `main` is absent. The binding verifies the exact
commit and branch before the coordinator connects the project. Creation-issued
tokens are revoked, including credentials recovered after a lost provider response;
the temporary seed token has a 180-second lifetime. Cleanup must be confirmed
before success. Interrupted operations retain their cleanup responsibility and
resume only on an explicit retry. Connecting code cannot bypass a pending creation.

This uses Cloudflare's documented [Workers binding](https://developers.cloudflare.com/artifacts/api/workers-binding/)
for repository and token lifecycle, and [Git protocol](https://developers.cloudflare.com/artifacts/api/git-protocol/)
for the initial commit. It adds no binding, secret, migration or Access policy.
Existing automatic Artifacts event registration runs after project connection;
if registration fails, the same request resumes it without repeating creation.
The normal verifier fingerprint must be regenerated for the changed server source.

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

These flows keep code private. They do not alter Access, configure agents, grant
repository permissions, enable model execution or publish anything.
