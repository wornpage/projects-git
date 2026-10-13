# Connect an existing Artifacts repository

In the hosted app, choose **New project**. Give it a display name, then supply
the Artifacts repository name and the full commit at its default-branch head.
The form’s **Where do I find these values?** help contains the steps below.

| Form field | Value to use |
| --- | --- |
| Project name | Your display name for this project |
| Artifacts repository name | The repository’s `name`, without its namespace, URL, opaque ID or `.git` suffix |
| Base commit · full Git ID | The full 40-character hexadecimal ID of the remote default-branch head |

## Find the repository

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

Copy the selected repository’s `name` into the form. Its metadata also supplies
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

Copy the full hexadecimal ID from the line ending in `HEAD` into **Base commit**.
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

## Continue in Projects Git

Choose **Use this commit · continue to task**, then describe the first task and
its acceptance requirements. The project is connected only when the creation
request succeeds. Server checks remain authoritative if the remote changes or
the name/commit is invalid.

This guide connects existing private code. It does not alter Access, configure
agents, grant repository permissions, enable model execution or publish anything.
