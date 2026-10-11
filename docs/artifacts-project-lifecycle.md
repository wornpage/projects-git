# Artifacts project lifecycle and recovery

Projects owns task requirements, agent assignments, checks and owner decisions.
Artifacts holds Git objects and repository capabilities. This workflow does not
require GitHub publication or GitHub review identity.

## Export and restore contract

The owner pauses admission and reconciles active assignments and pending writes.
`GET /api/projects/:id/export` then returns a `projects-git-project/v1` archive.
It includes current task handoffs, earlier imported handoffs, recorded check
definitions and the exact commits referenced by retained candidates and evidence.
The export refuses concurrent workspace changes and a changed default branch head.

The archive is bounded to 1 MiB, 64 task records and 128 referenced commits. Limits
refuse the operation rather than dropping records. Git credentials, service
secrets and active coordinator operations are not selected. Freeform notes and
source remain untrusted data. A checksum detects corruption against its expected
digest; it is not a signature or proof of an author's identity. The archive also
validates the shapes and commit references of retained history records; a valid
checksum does not make malformed history acceptable.

The operator obtains read-only clones of the project and retained candidate
repositories. A local JSON map binds each referenced commit to its absolute
source repository path. Export uses the existing bounded Git-object reader and
creates a new directory; it never replaces an earlier attempt.

```text
node scripts/project-bundle.mjs export project.json EXPECTED_ARCHIVE_SHA256 local-sources.json NEW_EXPORT_DIRECTORY
node scripts/project-bundle.mjs restore EXPORT_DIRECTORY EXPECTED_MANIFEST_SHA256 NEW_BARE_REPOSITORY
```

Save the returned manifest digest separately from the package. The package
contains `project.json`, `project.bundle` and `manifest.json`. Restoration validates
both digests, Git references and objects, and writes an independent bare Git
repository plus `project-history.json`. It performs no network request, installs
no checks and configures no remote or credentials. Main and referenced candidate
commits retain their identities and ancestry. This bounded project archive does
not promise preservation of unrelated repository references, server hooks or
provider settings. The existing object reader allows 32 ancestors per captured
commit, portable regular files and 8 MiB source trees. Across all referenced
commits, staging allows at most 16,384 unique Git objects and 64 MiB of object data,
charging the larger of each object's compressed and uncompressed representation.
Shared objects count once. Filesystem metadata is additional to that data limit.
Git bundle output is limited to 64 MiB while it is produced, before writing the
package. Retained refs use a namespace that cannot replace or conflict with the
project's default branch; existing valid version-1 reference layouts stay readable.

After pushing that recovered Git repository to a new, empty Artifacts repository,
the owner calls `POST /api/projects/restore` with an idempotency key and exactly:

```json
{
  "archive": {"format": "projects-git-project/v1", "sha256": "...", "payload": {}},
  "expectedSha256": "THE_SAVED_ARCHIVE_DIGEST",
  "repo": "NEW_ARTIFACTS_REPOSITORY_NAME",
  "projectName": "Restored project"
}
```

The server reads every referenced commit and the actual default branch from
Artifacts before recording a new project. Existing projects cannot be replaced.
The restored project starts with admission paused. Original identities, failed
attempts, reviews and checks remain read-only historical records at
`GET /api/projects/:id/history`; they are never promoted into active assignments,
verification policy or acceptance. The current configured owner controls new work.
Enable admission explicitly, create a fresh task and obtain fresh checks and
independent review before another guarded merge.
