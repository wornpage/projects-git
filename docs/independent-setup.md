# Deploy your own Projects Git workspace on Cloudflare

This is the primary setup path for an independent Projects Git installation:
fork the source, configure your own Cloudflare account and resources, and deploy
a private hosted workspace. It does not require the maintainer's machine,
account, private qualification files or service identities. The source is
MIT-licensed; retain its license and third-party notices.

Workers runs the application, Artifacts stores Git repositories, and a
SQLite-backed Durable Object coordinates workflow records. D1 provides the
derived search index. Cloudflare Access protects the workspace.

The separate local Git server supports development and testing. See
[local development](setup.md#work-with-a-local-project) for that path.

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
remain unverified.

## 2. Prepare your operator configuration

Hosted setup is a separate operator action using your own account and credentials.
Do not point a fork at the maintainer's namespace, database, identities or queues.
Keep API tokens, JWTs and service secrets outside the source tree. Do not copy the
maintainer's ignored `qa/` or private qualification directory.

From a clone, copy the safe source configuration to the ignored operator
filename at the same directory level. This keeps its source-relative paths
correct. Use your editor or file manager, or run the following in PowerShell 7:

```powershell
if (Test-Path -LiteralPath "wrangler.operator.jsonc") { throw "Preserve the existing operator configuration." }
Copy-Item -LiteralPath "wrangler.jsonc" -Destination "wrangler.operator.jsonc"
```

Run that copy command only when the destination does not exist. Preserve an
existing operator configuration rather than overwriting it. For an external
configuration file, resolve `main`, assets, container Dockerfile and migration
paths to your checkout; the checker refuses another checkout's source paths.

## 3. Configure your Cloudflare installation

Edit the operator copy using your account's resources and identities. Select or
create resources as needed to obtain their real identifiers; do not invent IDs
to satisfy the offline checker. Resource provisioning is a deliberate account
operation, separate from the checker. Supplying a value does not prove its
resource exists or is accessible.

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

## 4. Check configuration offline

The owner app's **Installation** panel can read this checker's JSON output
without uploading it. It separates local configuration checks from unverified
resources, deployment and private installation. See
[installation readiness](installation-readiness.md) for report scope and counts.

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

## 5. Provision and deploy deliberately

After resolving offline blockers, finish resource provisioning, arrange Access
policies, and follow the migration and deployment instructions for your account.
Some provisioning may already have been needed in step 3 to obtain resource IDs.
Keep default and preview endpoints disabled, and establish Access protection
before activating a hostname. Do not expose endpoints to work around sign-in.

Use [Cloudflare architecture and account preflight](cloudflare.md),
[deployment preparation](hosted-execution.md),
[repository checks](hosted-repository-checks.md) and
[hosted project setup](hosted-project-setup.md) for the detailed instructions.
Select your operator configuration explicitly when following app-specific
Wrangler commands in those guides, including deployment; the source
`wrangler.jsonc` remains the safe build template. An offline pass does not
provision resources or establish hosted acceptance. Keep model execution and
semantic embeddings disabled until their credentials and budgets are deliberately
configured.

## 6. Verify the private installation

Before calling the installation complete, confirm Access authentication and role
boundaries, repository access, and the intended workflow through verification,
independent review and integration. Use a small repository you control and an
explicit run budget. Account reachability, a healthy Worker, a successful source
build and a complete private workflow are separate results.

The hosted model currently has one human owner and separately restricted builders
and reviewers. Multi-user membership is not enabled by this setup work.

Local development uses JSON workspace records and owned Git copies under
`.local/`. It does not provide the hosted D1 search backend or Cloudflare Access
authentication. Local names provide attribution, not hosted team permissions.

## Record an independent installation

For an independent operator's later attempt, retain the source commit, supported
environment, checker profile/counts, actual steps completed, blockers, assistance
requests and active operator time separately from waiting time. Keep credentials
and identifying provider payloads private. Do not claim a successful hosted
installation from an offline receipt.

[Qualification setup](qualification-setup.md) is for the separate bounded test
fixtures, their credential populations and evidence. It is not a prerequisite for
an ordinary source installation.
