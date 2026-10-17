# Workspace backup and offline recovery

This draft backs up complete retained workflow history and operation receipts,
then packages the Git objects needed by that history. Recovery writes isolated
bare repositories and historical records into a new local directory. It does
not install an active database, reconnect a Cloudflare resource, resume a job,
replay an operation or carry forward authority. Live installation recovery is
not yet implemented or qualified.

## Capture metadata in the private Cloudflare app

The owner opens **Installation readiness → Workspace backup → Download backup
metadata**. The owner-only `GET /api/workspace/backup` reads a complete revision;
a concurrent history change refuses the export. It never treats a loaded page
as the whole workspace and does not call Artifacts, models or checks.

The file includes task/candidate handoffs, historical reports, workspace events,
safe operation receipt fields, timing observations, job status observations,
resource-name mappings, historical check definitions and required commit roots.
Access grants, authentication configuration, credentials, raw provider replies
and runnable job inputs are excluded. Receipts for pending effects remain
pending history even when their lease has expired.

The preview uploads the selected file to this private app for integrity and
schema validation only. It does not save or apply the archive. A digest detects
corruption; it does not authenticate the author or authorize an action. Backup
files contain private source and history; keep them private.

## Package every referenced commit locally

Use the metadata file's exact `sha256`. Supply one explicit absolute local
repository path for each commit in each project's `commits` list. The source
repositories must already contain those objects. No URL fetch or credential
lookup is performed. Example `local-sources.json` structure:

```json
{
  "PROJECT_ID": {
    "40_CHARACTER_COMMIT_SHA": "C:/my-private-checkouts/project"
  }
}
```

From the source checkout:

```sh
node scripts/workspace-bundle.mjs export workspace.json EXPECTED_ARCHIVE_SHA256 local-sources.json NEW_PACKAGE_DIRECTORY
```

Record the returned manifest SHA-256 separately. Packaging copies the full
ancestry of every referenced commit through the guarded local Git path and
checks the resulting repositories. It includes retained alternatives and known
uncertain commits. A missing object fails explicitly. Unreferenced branches,
Git notes and provider-only objects absent from the supplied local repositories
are not silently treated as backed up.

## Recover offline to a new directory

```sh
node scripts/workspace-bundle.mjs restore PACKAGE_DIRECTORY EXPECTED_MANIFEST_SHA256 EXPECTED_SOURCE_WORKSPACE_ID NEW_RECOVERY_DIRECTORY
```

The command validates the expected source workspace, metadata digest, complete
project inventory and every Git bundle digest before creating the destination.
It rejects existing destinations. It unbundles and checks every required root;
an invalid Git object/ref fails without a success receipt. Failed attempts stay
on disk for inspection and are never overwritten automatically.

Each project is restored to a generated `project-NNN.git` directory with a
`recovered-main` branch and explicit retained commit refs. The original recorded
default branch remains metadata. No remote, source Git config or hooks are
copied. `workspace.json` preserves validated history; `recovery.json` records the
inventory and unresolved effects. Neither file is a runnable coordinator snapshot.

Current owners must separately reconcile external effects, revoke old credentials,
provision/connect destination resources and obtain fresh checks, reviews and
permissions before live work. This draft provides no bypass for those decisions.

## Limits and qualification

Metadata is limited to 1 MiB, 16 projects, 256 tasks, 512 candidates, 2,000
operation receipts and 10,000 events. Each project supports 128 required commit
roots. Git packaging has an aggregate 64 MiB object/bundle budget and 16,384
staged objects. A limit refusal preserves the complete denominator; it never
returns a truncated backup.

Local fixtures cover cold recovery after removing original source access,
multiple projects, retained pending effects, missing objects, corrupt bytes,
wrong workspace identity and replay into an existing destination. These are
source/local checks. No hosted disaster-recovery installation, account migration,
provider object export or production backup schedule has been proved.
