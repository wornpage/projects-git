# Install your own Projects Git workspace

This is the ordinary operator path for a source fork. It does not require the
maintainer's machine, private qualification files, Cloudflare account or service
identities. The source is MIT-licensed; retain its license and third-party notices.
The application is open source. The hosted adapter uses managed Cloudflare
services; the local Git adapter is a separate operating mode.

## 1. Install the source

Use a clean clone of your fork, or an extracted source archive. Keep the supplied
lockfile. Use Node.js at the minimum version in `package.json` or newer, npm and
Git. Docker's Linux engine is needed later for independent ordinary-project checks.

```sh
npm ci
npm run setup:check
```

The checker reads this checkout, compares direct dependency metadata with its
lockfile and asks Git for its version. It does not start the application, run
tests, invoke Wrangler, log in, create resources or contact Cloudflare or a model.
It does not install or repair anything. A blocked check prints its next action
and returns a nonzero exit code. Fix the input and rerun deliberately.

For a read-only probe of Docker's configured engine, add `--docker`. It neither
builds an image nor runs a container. It uses the current Docker context:

```sh
npm run setup:check -- --docker
npm run --silent setup:check -- --json
```

The report identifies its profile, requested probes and passed/blocked/not-checked/total
counts. It checks direct package metadata, not every transitive file or executable.
An offline pass establishes prerequisites only; startup and workflow behavior
remain unverified. See [local setup](setup.md) to start your local Git workspace.
Local names provide attribution, not hosted authentication or team permissions.

## 2. Prepare an independent hosted configuration

Hosted setup is a separate operator action using your own account and credentials.
Do not point a fork at the maintainer's namespace, database, identities or queues.
Keep API tokens, JWTs and service secrets outside the source tree. Do not copy the
maintainer's ignored `qa/` or private qualification directory.

From a clone, copy the safe source configuration to the ignored operator filename
at the same directory level. This keeps its source-relative paths correct:

```powershell
if (Test-Path -LiteralPath "wrangler.operator.jsonc") { throw "Preserve the existing operator configuration." }
Copy-Item -LiteralPath "wrangler.jsonc" -Destination "wrangler.operator.jsonc"
```

Run that copy command only when the destination does not exist. Preserve an
existing operator configuration rather than overwriting it. For an external
configuration file, resolve `main`, assets, container Dockerfile and migration
paths to your checkout; the checker refuses another checkout's source paths.

Edit the operator copy. The following inventory separates configuration inputs
from provider operations; supplying a value does not prove its resource exists.

| Input | Operator responsibility |
| --- | --- |
| `account_id`, Worker `name` | Select your account and a dedicated application name. |
| `WORKSPACE_ID` | Choose a stable workspace ID. Changing it selects another durable workspace. |
| Access issuer, audience and owner subject | Configure your Access application and pin the owner from a verified session. An email, a decoded unsigned JWT or first caller is not proof. Follow [authenticated ownership](authenticated-workspace.md). |
| Builder and reviewer lists | Configure at least one builder and a distinct reviewer service or human reviewer. Keep their edge admission, permissions and credentials separate. |
| Artifacts namespace | Create or deliberately select a namespace in your account. Namespace configuration alone does not create it. |
| Durable Objects, migrations, loader and verifier container | Preserve the source declarations and image path. Qualify container access and an immutable check runtime separately. |
| Search database | Supply your D1 database name and ID and retain `migrations/search`. Applying migrations is a separate provider operation. |
| Search and Artifacts event queues | Use your queue names consistently in producers, consumers, dead-letter queues and event variables. Subscription registration is separate. |
| Vectorize and Workers AI bindings | Supply your index configuration. Keep semantic embeddings disabled until explicitly configured and budgeted. |
| `CURRENT_POLICY` service | Target the application Worker name with entrypoint `WorkspacePolicy`. |
| `EVENT_SUBSCRIPTIONS` service | Configure your subscription-service deployment if retaining this binding. Its source configuration is `wrangler.subscriptions.jsonc`; its account, namespace, queue and workspace must match your app. See [event registration](artifacts-events.md). |
| Public ingress | Keep `workers_dev` and `preview_urls` false and `assets.run_worker_first` true. Confirm whole-host Access protection before activating a custom hostname. |
| Optional model execution | Keep the model empty unless you deliberately configure a provider and budget. Store API keys as secrets, not plaintext `vars`. |

The public template intentionally has missing owner/account/resource inputs and
cannot pass the hosted configuration check unchanged. Its optional automation
defaults are not a request to enable provider activity.

```sh
npm run --silent setup:check -- --config wrangler.operator.jsonc --json
```

This inspects literal root JSON/JSONC configuration only; it does not execute a
TypeScript config, expand environment variables or inspect named environments.
Use an explicit, flattened operator configuration. An in-checkout config must be
untracked and ignored by Git; an external config is also supported.

The checker reuses the application's Access-policy validator. It checks source
paths, disabled default/preview endpoints, core bindings and selected resource
identifiers. It is not full Wrangler schema validation, credential verification,
an Access-policy audit or hosted acceptance. Its output omits configuration values
and credentials. Inspect the explicit `notVerified` list even when every offline
check passes.

## 3. Stop at the hosted boundary

An offline pass does not authorize deployment or paid activity. Before continuing,
the operator must deliberately arrange the account, resource provisioning, Access
policies, migration/deployment steps and a bounded qualification of the private
workspace. Do not expose default or preview endpoints to work around sign-in.

Use [Cloudflare architecture and account preflight](cloudflare.md),
[repository checks](hosted-repository-checks.md) and
[hosted project setup](hosted-project-setup.md) for those boundaries. Account
reachability, a healthy Worker, a successful source build and a complete private
workflow are separate results. Use the operator configuration explicitly for any
later deployment; the source `wrangler.jsonc` remains the safe build template.

The hosted model currently has one human owner and separately restricted builders
and reviewers. Multi-user membership is not enabled by this setup work.

## Record an independent installation

For an independent operator's later attempt, retain the source commit, supported
environment, checker profile/counts, actual steps completed, blockers, assistance
requests and active operator time separately from waiting time. Keep credentials
and identifying provider payloads private. Do not claim a successful hosted
installation from an offline receipt.

[Qualification setup](qualification-setup.md) is for the separate bounded test
fixtures, their credential populations and evidence. It is not a prerequisite for
an ordinary source installation.
