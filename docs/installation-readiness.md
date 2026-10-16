# Installation readiness

In the owner workspace, choose **Installation** to inspect an offline setup
report. The panel uses the existing inspector; opening it makes no API or provider
request. It is unavailable to builders, reviewers, personal trials and the public
sample. Local mode retains its existing trusted loopback-operator boundary.

## Read a local report

In your own source checkout, use the existing checker with your actual config:

```text
npm run --silent setup:check -- --config wrangler.operator.jsonc --json > setup-report.json
```

Choose that JSON file in the panel. It is read in the tab, never uploaded or
persisted. Closing the panel discards it. Only known check names, results, counts
and the reported timestamp are retained for display. Imported prose, config
values and any claimed hosted-readiness fields are ignored. Invalid reports,
inconsistent counts, invalid UTF-8 and files over 64 KiB are refused. A newer
selection or Clear report supersedes an earlier pending read.

The supplied file is not independently authenticated or bound to the current
workspace, account or deployed source. A reported time is not a freshness check.
It cannot authorize provisioning, spending, jobs, acceptance or merge.

## Five separate stages

| Stage | Local evidence | What remains separate |
| --- | --- | --- |
| Local prerequisites | Source/lock metadata, Node.js, Git and direct dependency metadata | Application execution and complete dependency integrity |
| Hosted configuration | Literal configuration checks, including the application Access/event contracts | Resource existence, credential validity and provider acceptance |
| Cloudflare resources | Not verified by this report | Isolated resource IDs, bindings, migrations, subscriptions and account access |
| Deployment | Not verified by this report | Exact deployed source/version and protected hostname |
| Private installation verification | Not verified by this report | Sign-in, role refusals, checked/reviewed workflow, persistence and cleanup |

The local profile has **4 checks**, or **5** when Docker is requested. The
hosted-config profile has **16 checks**, or **17** with Docker: the local checks
plus **12 configuration checks**. This adds one event-policy check to the earlier
15-check hosted profile. Every requested check remains in the denominator,
including blocked prerequisites and checks that could not run. A configuration
stage omitted from a local-profile report is shown as not requested, with its
12 available checks; those are not added to that report's requested total.

An empty manual subscription list cannot pass event configuration while automatic
registration is off. The event account/namespace/queue must match the app's
configuration. Automatic registration additionally needs a Queue ID and exactly
one valid `EVENT_SUBSCRIPTIONS` target with the `ArtifactSubscriptionService`
entrypoint. That target must differ from the application Worker, whose source
does not export the registration entrypoint. These are application-config
declaration checks. The companion Worker's actual account, namespace, queue,
workspace, owner settings and credentials are not inspected or matched by this
check; their verification remains separate, along with subscription existence.

The CLI emits the same stage projection in its JSON report and text output. The
current report schema is **2**. Older schema-1 reports remain historical files;
generate a new report with this checkout instead of importing or relabeling them.
The added event check and required report timestamp are part of this cutover.
The panel reconstructs that projection from the validated raw check results; it never
trusts a supplied stage verdict. Passing all local checks leaves all three hosted
stages **Not verified**. This first version has no manual “mark verified” control
or hosted-receipt importer. Later hosted evidence needs its own reviewed design.

Follow [independent setup](independent-setup.md) for the Cloudflare-first path.
Provisioning, Access changes, deployment and hosted workflows remain deliberate,
separately authorized actions. Installation readiness does not establish a
provider-enforced spending ceiling.
