# Private hosted qualification setup

For an ordinary source installation, use [independent operator setup](independent-setup.md).
This guide configures bounded qualification fixtures and their dedicated identities.

The local suite and hosted qualification have separate results. Hosted runs need
your own Cloudflare account, Access application, service credentials, Artifacts
and container entitlement, and an explicit run budget. Scripted actors and model
fixtures do not establish human acceptance or live model quality.

## Local source checks

Install Node.js 24.19 or later, Git and PowerShell 7. In the extracted source root:

```powershell
npm ci
npm test
npm run typecheck
npm run build
```

## Record operator inputs

Use a separate disposable Access application and qualification resources. Record
your account, issuer, application audience, hostname, workspace and one approved
owner email before provisioning. The included preflight validates an explicit
eight-hour owner session and 24-hour service-token lifetime for its fixture.
Use an owner Allow policy and a service-only Service Auth policy. Agents still
receive restricted permissions at the Worker and controller boundaries.

The hosted review fixture requires two separately approved reviewer service
credentials in `reviewers.json` in the external credential directory. Each record
has the provider-issued token `id`, `client_id`, `client_secret`, and
`duration: "24h"`. Neither may appear in the
builder list. The configuration generator refuses missing, duplicate, or
overlapping reviewers. Include both in the Access Service Auth policy, then
capture each verified application JWT as `reviewer-jwt-0` and `reviewer-jwt-1`
outside source before qualification. The review fixtures are explicitly scripted;
they qualify role separation and retained workflow behavior, not model review
quality. Do not provision or broaden access without operator authorization.

`reviewerSubjects` in the external setup is an optional list of verified human
Access subjects. It defaults to empty. Record each subject from a verified session,
configure a corresponding Access edge policy, and pin it in the Worker before a
real team-review qualification. The source fixture tests a signed human reviewer
claim but cannot stand in for a real member or edge policy.

```powershell
New-Item -ItemType Directory -Force qa/identity-concurrency | Out-Null
Copy-Item tests/qualification/setup.example.json qa/identity-concurrency/access-setup.json
$qualPrivate = Join-Path ([Environment]::GetFolderPath("LocalApplicationData")) "ProjectsGitQualification/qualification"
New-Item -ItemType Directory -Force $qualPrivate | Out-Null
$env:PROJECTS_QUALIFICATION_CREDENTIAL_DIR = $qualPrivate
```

Fill the required fields in `access-setup.json`. The Worker name may contain at
most 50 lowercase letters, digits or hyphens, starting with a letter or digit;
this leaves room for the separate driver name. Leave `ownerSubject` and
`ownerVerifiedAt` blank until a verified session pins them. The credential
directory must be an absolute path outside the source checkout.

Store provider-issued service credentials in `agents.json` in that directory:
an array of eight records containing the token `id`, `name`, `client_id`, `client_secret`
and `duration` set to `24h`. Keep these secrets out of source, logs and chat.
The configuration generator copies client IDs only. It creates no credentials
or Access policies. `agentPolicyId` is an optional operator inventory field.
Cloudflare's [service-token API](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
accepts an explicit `24h` duration and requires `Access: Service Tokens Write`;
creating the application or policy requires `Access: Apps and Policies Write`.
Use an account-scoped temporary administrator credential for those setup actions,
retain it outside source, and verify the returned token expiration before using
the credentials. A self-reported `duration` field in these local JSON files is
not expiration proof.

After creating the isolated application, record its provider-issued
`accessApplicationId` in `access-setup.json`. After pinning the verified owner
and before configuring or deploying the Worker, run the read-only Access
preflight with the temporary account-scoped administrator token in
`CLOUDFLARE_API_TOKEN`.

It checks the live application audience, hostname and eight-hour session; only
the owner's email Allow policy and an exact ten-token Service Auth policy; and
each token's provider ID, client ID, enabled state, 24-hour duration and current
expiry. An extra or broad policy, missing token, expired token or denied API read
fails closed. The sanitized source-bound receipt is saved in ignored
`qa/identity-concurrency/access-preflight.json`; it contains no service secrets.
Re-run the preflight after any Access policy or credential change and before
private qualification. Every hosted scenario refuses a dirty checkout, a stale
preflight, or a changed source and credential cohort before its first request.
Edge denials and direct Worker denials still require
separate hosted tests.

Install Cloudflare's `cloudflared` CLI. With your own Access-protected sign-in
endpoint available, complete the owner login and pin the verified session:

```powershell
cloudflared access login --quiet https://YOUR_QUALIFICATION_HOSTNAME
node tests/qualification/pin-owner.mjs qa/identity-concurrency/access-setup.json
node tests/qualification/check-access.mjs
node tests/qualification/configure.mjs
```

The pinning tool verifies the JWT signature, issuer, audience and times, then
checks the approved email and any previously pinned subject. It is an explicit
operator setup tool; no HTTP caller can enroll the owner automatically.

The generator writes `hosted.wrangler.jsonc`, `driver.wrangler.jsonc` and the
loopback harness key in `qa/identity-concurrency/.dev.vars`. Both configurations
disable public endpoints. Missing inputs fail instead of selecting the original
operator's account. A rerun retains the existing harness key.

## Run only with explicit operator authorization

Deploying, provisioning and paid checks are separate operator steps. The seed
helper creates the explicitly configured Artifacts repository when invoked;
its private creation receipt prevents blind duplicate creation. An uncertain
creation or Git write requires reconciliation, not an automatic retry. Retire
issued seed and assignment credentials after testing.

The qualification Worker exposes fault controls through a private binding only.
Public application, API and asset requests return 404. During an explicitly
enabled sign-in-only window, its CLI callback returns inert HTML. Disable that
hostname before private tests. The ordinary Worker entrypoint contains no
qualification fault controls.

Start the driver on loopback; **never deploy it**:

```powershell
node node_modules/wrangler/bin/wrangler.js dev --config qa/identity-concurrency/driver.wrangler.jsonc --ip 127.0.0.1 --port 8819
```

Remote service bindings need remote mode; do not add `--local`. Hosted scenarios
require a real, unexpired owner session in cloudflared's application cache and
`requalification-agent-sessions.json` in the private credential directory. That
file is an array of `{ "clientId": "...", "token": "..." }` records in the same
order as `agents.json`. Obtain and verify these sessions through your own Access
application; the public harness does not automate this setup. Sessions must be
newer than the workspace's revocation cutoff. Fixture JWTs cannot supply hosted
identity proof.

`configure-isolation.mjs` creates the second workspace configuration and adds its
private bindings to the driver. It permits the owner and has no agent allowlist.
Run each applicable scenario script deliberately, retaining failed attempts,
source/configuration hashes, request identities and peak occupancy. Release
barriers, close test assignments, revoke issued Git credentials, disable routes
and stop the driver after the run. Do not silently repeat model inference or an
uncertain Git operation.

For the hosted review fixture, run `prepare-candidates.mjs` and
`containers.mjs` before `review-workflow.mjs`. The latter uses the second
verified candidate, both real reviewer service sessions, a personal then team
assignment, scripted finding and owner decision history, and a durable inference
reservation/reconciliation. It retains a source tree and configuration SHA-256,
request identities, scenario results and peak occupancy. It performs **zero**
model-provider requests. Run `merge.mjs` afterward for the separate owner merge
gate on the first candidate. The three real reviewer-model evaluation cases
must be separately authorized and reported; a scripted assessment is not a
quality result.

The separate live reviewer runner also requires an explicit `--provider`
(`workers-ai` or `openai`), model, candidate run ID and limits. Its Workers AI
endpoint must match this qualification account; the OpenAI choice accepts only
the official OpenAI Chat Completions endpoint. The provider selection chooses
the correct bounded output-token field and refuses a mismatched host before
inference. Do not start it without its own bounded authorization.

For an explicitly bounded Workers AI evaluation, use its
[OpenAI-compatible Chat Completions endpoint](https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/)
with a model that supports [JSON mode](https://developers.cloudflare.com/workers-ai/features/json-mode/).
The evaluator requires `--provider workers-ai`, an exact account endpoint,
model, case IDs and count, input bytes, output tokens and timeout. It sends at
most one request per case, stops on the first failure, retains each attempt
before inference, and never posts those synthetic assessments to a workspace.
For untouched cases after a failure, supply the earlier `--prior-report` and
only those IDs with `--case-ids`; `--dry-run` checks the plan without a provider
call. The evaluator rejects any previously attempted ID and retains the prior
failure in the full-suite denominator. It commits a per-case reservation to the
report before provider I/O, so a process crash cannot make that case look
untouched; recovery requires an explicit new decision, never automatic replay.
Bounded raw provider responses are saved
privately to allow semantic adjudication. Use a
temporary account-scoped AI credential in the process environment; do not put
it in source or command output. The evaluation report records completed,
failed and unrun cases separately. Line overlap is only a location match;
someone must inspect the reported claim before calling it a true positive.
