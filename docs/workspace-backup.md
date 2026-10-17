# Workspace backup and offline recovery

This draft backs up complete retained workflow history and operation receipts,
then packages the Git objects needed by that history. Recovery writes isolated
bare repositories and historical records into a new local directory. It does
not reconnect a Cloudflare resource, resume a job, replay an operation or carry
forward authority. The owner can separately retain the complete archive in an
empty destination app as immutable, readable history. This is historical recovery;
active workflow and provider recovery remain separate.

## Capture metadata in the private Cloudflare app

The owner opens **Installation readiness → Workspace backup → Download backup
metadata**. The owner-only `GET /api/workspace/backup` reads a complete revision;
a concurrent history change refuses the export. It never treats a loaded page
as the whole workspace and does not call Artifacts, models or checks.

The file includes task/candidate handoffs, historical reports, workspace events,
safe operation receipt fields and their sole retained verifier reports, timing
observations, job status observations,
resource-name mappings, historical check definitions and required commit roots.
The same point-in-time SQLite read includes secret-safe Artifacts subscription,
subscription-attempt, event, event-attempt and delivery ledgers. Their repository
name, phase/status, stable identities, timestamps and sanitized error codes retain
uncertain create/enable/read boundaries. Subscription plan JSON, owner keys,
account/queue configuration and raw provider replies are excluded.
Access grants, authentication configuration, credentials, raw provider replies
and runnable job inputs are excluded. Receipts for pending effects remain
pending history even when their lease has expired.

The preview uploads the selected file to this private app for integrity and
schema validation only. It does not save or apply the archive. A digest detects
corruption; it does not authenticate the author or authorize an action. Backup
files contain private source and history; keep them private.

## Restore readable history into an empty app

Use the current authenticated owner of an empty destination workspace.
Open **Installation readiness → Workspace backup**, preview the archive, then
choose **Read destination and recovery history**. Verify the destination workspace
and its exact revision. Enter the expected source workspace and the independently
recorded archive SHA-256, then type **RESTORE HISTORY ONLY** before confirming.
Existing projects, tasks, candidates, repository/fork mappings, check policies,
jobs or other operation receipts cause refusal; restoration never overwrites them.
Earlier historical imports may remain alongside the new archive.

The app stores the entire validated original archive and current-owner import
provenance under its digest. It atomically records one complete `workspace-restore`
receipt. Source authentication, grants, approval and provider ledgers do not become
live state. Imported project/task/candidate IDs remain historical; no assignments,
verification, integration, provider retries or code fetching run during restoration.
The current destination identity and permissions remain authoritative.

Owner history lists distinguish current workflow from historical imports and mark
code unavailable in the app. **Read historical import**, **Read all original
historical records** and **Download original archive** expose preserved records
without making old decisions current. Re-export includes prior imports and their
Git roots/counts. Git objects must be independently recovered with the capsule CLI.

If the response is lost, read recovery history by archive digest before explicitly
retrying the saved request. The UI retains the original DTO and idempotency key;
it never automatically repeats the mutation. Replays return their existing receipt
even though its original expected revision is now stale. Changing input under the
same key conflicts. Archives and import provenance cannot later be modified or
removed through ordinary snapshot writes.

All original project, fork, unattached-operation and ledger repository names stay
quarantined, including names inside earlier imports. New project connection,
creation, assignment and base-update paths refuse those names before provider I/O.
Connect independently restored code only under explicit fresh resource names using
the existing **New project** flow. An elapsed lease or stopped process never proves
an earlier external effect stopped; restoration does not reconcile that history.

| Owner endpoint | Effect |
| --- | --- |
| `POST /api/workspace/restore` | Validate and retain history; requires `Idempotency-Key`, archive, expected digest/source/destination/revision and exact confirmation |
| `GET /api/workspace/recovery-imports` | Current destination revision/workflow counts, historical imports and quarantined names |
| `GET /api/workspace/recovery-imports/<sha256>` | Historical import provenance and complete count preview |
| `GET /api/workspace/recovery-imports/<sha256>/archive` | Exact original archive, including unresolved effects |

The confirmation DTO is `{archive, expectedSha256, expectedSourceWorkspaceId,
expectedWorkspaceId, expectedRevision, confirmation: "RESTORE HISTORY ONLY"}`.
All routes are owner-only. Current source/local SQLite and HTTP/UI fixtures prove
metadata retention and replay behavior; they are not hosted disaster-recovery or
provider resource qualification.

The preview separates current and historical task, candidate, event and policy
records, with explicit totals. It also counts operation reports, jobs and Git
mappings. Historical records participate in the same global limits. Required
Git resources include existing projects and known commits from interrupted
operations whose project has not yet been attached; these are separate resources,
not fabricated projects. Every nested archive schema is closed. Recomputing
digests cannot admit excluded structured fields.

The workflow snapshot and these coordinator ledgers are read in one synchronous
SQLite transaction before hashing. The archive labels this as a coherent
point-in-time capture. The workspace revision still detects later workflow
changes before the HTTP response, while ledger changes after the transaction do
not rewrite or invalidate the captured point in time. Missing canonical ledger
tables fail the export; capture never creates them or assumes they were empty.
Ledger resource references consistently use `repositoryName`; recovery tooling
can quarantine those names without parsing excluded subscription plans.

## Package every referenced commit locally

Use the metadata file's exact `sha256`. Supply one explicit absolute local
repository path for each commit in each recovery resource's `commits` list. Use
the resource's exact `id` as the mapping key. The source
repositories must already contain those objects. No URL fetch or credential
lookup is performed. Example `local-sources.json` structure:

```json
{
  "RESOURCE_ID": {
    "40_CHARACTER_COMMIT_SHA": "C:/my-private-checkouts/project"
  }
}
```

From the source checkout:

```sh
node scripts/workspace-bundle.mjs export workspace.json EXPECTED_ARCHIVE_SHA256 local-sources.json NEW_PACKAGE_DIRECTORY
```

Record the returned manifest SHA-256 separately. Packaging copies the full
ancestry of every referenced commit with a dedicated object-only walker. It has
no submission-only ancestry, file-count or tree-size caps. SHA-1 object identities,
types and graph closure are checked. Binary blobs and symlink entries are retained
as Git objects without a checkout. Missing objects fail explicitly. Submodule
repositories, unreferenced branches, Git notes and provider-only objects absent
from the supplied local repositories are not silently treated as backed up.

## Recover offline to a new directory

```sh
node scripts/workspace-bundle.mjs restore PACKAGE_DIRECTORY EXPECTED_MANIFEST_SHA256 EXPECTED_SOURCE_WORKSPACE_ID NEW_RECOVERY_DIRECTORY
```

The command validates the expected source workspace, metadata digest, complete
resource inventory and every object-capsule digest before creating the destination.
It independently checks every object count, expanded size, SHA-1 identity and
required graph before creating any recovery directory. A digest-consistent
oversized archive is still refused. It rejects existing destinations and
reconstructs bare repositories from validated objects, then checks every root;
an invalid Git object/ref fails without a success receipt. Failed attempts stay
on disk for inspection and are never overwritten automatically.

Each resource is restored to a generated `resource-NNN.git` directory with a
`recovered-main` branch for projects or `recovered-anchor` for unattached operations,
plus explicit retained commit refs. A recovery anchor is not a claimed remote
main head. The original recorded
default branch remains metadata. No remote, source Git config or hooks are
copied. `workspace.json` preserves validated history; `recovery.json` records the
inventory and unresolved effects. Neither file is a runnable coordinator snapshot.

Current owners must separately reconcile external effects, revoke old credentials,
provision/connect destination resources and obtain fresh checks, reviews and
permissions before live work. This draft provides no bypass for those decisions.

## Limits and qualification

Metadata and each CLI JSON input are limited to 4 MiB. The archive supports
32 current projects, 80 current and historical projects in total, 64 recovery resources, 256 task records, 512 candidate records,
2,000 operation receipts, 10,000 event records, 512 check policies, 1,024 Git
mappings and 512 job records. Record limits include current and imported history.
Artifacts ledgers are additionally limited to 128 subscriptions, 4,096
subscription attempts, 4,096 events, 16,384 event attempts and 4,096 delivery
identities. The 4 MiB metadata limit applies to their combined serialized data,
so large histories can reach the byte limit before these row-count ceilings.
Each project supports 128 required commit roots. The aggregate encoded-object
and expanded-object budgets are each 64 MiB, with at most 16,384 stored objects
across all resources. Duplicate objects stored in different resources are charged
again. Export and restore enforce these budgets independently. Each local Git
command also has a finite timeout. A refusal never returns a truncated backup.

Local fixtures cover cold recovery after removing original source access,
multiple projects, retained pending effects, missing objects, corrupt bytes,
wrong workspace identity and replay into an existing destination. These are
source/local checks. No hosted disaster-recovery installation, account migration,
provider object export or production backup schedule has been proved.
