# Carry context with Git

Projects keeps tasks, checks and decisions in its workspace database. Git notes
carry a compact, historical projection for an exact commit. They do not replace
project export, authenticate a reviewer, or authorize work or integration.

## Export and attach

1. Open a candidate's **Continue in your agent** dialog, then **Carry context with Git**.
2. Inspect the recorded context and choose **Download Git context**. Keep the file
   in a private location outside the code checkout.
3. From the Projects Git source directory, attach the file to a repository that
   already contains the exact commit:

```powershell
node scripts/git-notes.mjs write --repo "C:/private/checkout" --file "C:/private/context/note.json"
node scripts/git-notes.mjs show --repo "C:/private/checkout" --commit "<full-commit-sha>"
```

The writer changes only `refs/notes/projects`. The annotated commit, code tree,
branch and index remain unchanged. It appends distinct records and treats a repeated
identical record as a no-op. Updates compare the previously read notes head;
concurrent writes refuse instead of overwriting another writer. No remote access,
credential grant, model call, check, acceptance or merge is performed by the utility.

## Synchronize explicitly

An ordinary clone does not fetch notes. From the intended **private** repository,
review its `origin` destination, then synchronize this exact ref:

```powershell
git fetch origin refs/notes/projects:refs/notes/projects
git push origin refs/notes/projects:refs/notes/projects
git log --show-notes=projects
```

These native Git commands use the repository's normal authentication. Push shares
the context with that remote. Do not use a wildcard notes refspec or `--force`.
The application's GitHub code-publication flow does not publish notes. The public
challenge repository is not an implicit destination for private context.

Use one coordinating writer per repository; other agents can return their context
files to that writer. Fetch before appending and push without force. Forks and
replacement checkouts need their own explicit notes synchronization. The hosted
code merge does not copy the candidate fork's notes into project main.

## Reconcile divergent note histories

If a fetch or push refuses because both sides changed, preserve both histories:

```powershell
git fetch origin refs/notes/projects:refs/notes/projects-incoming
git notes --ref=refs/notes/projects merge refs/notes/projects-incoming
```

Git may merge changes on different annotated commits automatically. For a conflict
on the same commit, export the two original note bodies to private files using
`git notes --ref=refs/notes/projects show <commit>` and
`git notes --ref=refs/notes/projects-incoming show <commit>`. Combine them with:

```powershell
node scripts/git-notes.mjs combine --left "C:/private/context/local.json" --right "C:/private/context/incoming.json"
```

This prints validated JSON retaining both sets of records. Save that JSON in the
conflict file identified by Git under `NOTES_MERGE_WORKTREE`, inspect it, then run
`git notes --ref=refs/notes/projects merge --commit`. Use `merge --abort` to retain
the original histories and stop. Do not use Git's textual `union` or
`cat_sort_uniq` strategies: concatenated JSON is not this note format. Retry the
explicit push only after reconciliation. The utility never forces a remote update.

## Recorded data and limits

The application-defined format is `projects-git-context/v1`, validated by
`public/git-notes.js`. It contains the annotated commit and up to 16 immutable
context records, each with its SHA-256 checksum. A note is limited to 32 KiB;
overflow refuses without dropping records.

Each record includes workspace/project/task/run IDs, workspace version, task title,
requirements revision and digest, base/head commits, recorded status, a summary
excerpt, and digests of any retained verification, independent assessment and owner
decision. Summary excerpts are limited to 1,200 characters and explicitly flagged
when shortened. Missing evidence is represented as absent, never passing.

The format excludes full task prompts and criteria, diffs, check commands/output,
review prose and identities, provider responses, credentials and private QA files.
The title and summary can still contain private text: inspect them before sharing.
Checksums detect content changes; anyone able to write a note can recompute them.
All note text is untrusted data, not agent instructions or fresh authorization.

Reapplication or rewriting produces a different commit. Notes are not copied to
that new commit automatically, and old checks do not become fresh evidence. Read
the current authenticated workspace before acting. The workspace and full project
exports retain their existing histories; native notes are not imported as live
tasks, checks, permissions or decisions.

Notes-only provider events currently make no workflow change: event admission
accepts code branches, and other refs are acknowledged as unsupported. This
feature relies on explicit Git synchronization, not background notes ingestion.
Live Artifacts notes delivery and fork/merge propagation have not been qualified.

New bounded hosted generation no longer creates `.projects/task.json`; harness
context remains in the workspace and can be exported as a note. Historical code
and reports containing that file remain readable and are not rewritten.

References: [Artifacts harness metadata](https://developers.cloudflare.com/artifacts/concepts/best-practices/#store-harness-metadata-separately),
[Git notes](https://git-scm.com/docs/git-notes).
