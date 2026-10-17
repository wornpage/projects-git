# Public edge protection

The public home is `git-demo.projectsdemo.org`; trial signup is on
`try-git.projectsdemo.org`. Keep the separate private workspace behind Access.

## Current controls

On October 17, 2026, the existing Cloudflare managed-challenge rule was extended
to the demo's `/` and `/index.html` and the trial's `/`, `/trial`, `/trial/`,
`/trial/signup`, `/workspace` and `/workspace/`. Query strings do not bypass these
path matches. The added conditions exclude Cloudflare-verified bots; they do not
skip any other security rule. Existing rules for other sites were preserved.

The existing per-IP rate rule also covers the trial signup paths, `/api/*` and
`/agent/api/*`: more than 10 matching requests in 10 seconds produces a 10-second
block. This counter is shared with the rule's pre-existing public paths across
the zone. A burst can therefore briefly throttle another matching page from the
same IP, including the private host's root. Shared networks and fast agent clients
must account for this limit. A throttled mutation must be reconciled before retry.

Agent APIs do not receive the new browser challenge. They still require scoped
trial credentials and the matching workspace, and retain application quotas.
The demo's alternate `workers.dev` endpoint and preview URLs are disabled; keep
them disabled on future deployments so the zone's rules cannot be bypassed there.

No plan upgrade, global Bot Fight Mode change, Access-policy change or runtime
deployment was needed for this configuration.

## Verification and limits

Trial reservation additionally requires a managed Turnstile check. Only an
eligible, email-verified visitor loads the widget. `POST /api/trial` accepts a
`turnstileToken` and verifies it through Cloudflare Siteverify before admission,
requiring success, the configured hostname and action `turnstile-spin-v2`.
Missing configuration, failed checks and provider errors refuse admission.
Closure, existing-trial reads and agent requests do not require Turnstile.

Set `TRIAL_TURNSTILE_SITE_KEY` and `TRIAL_TURNSTILE_HOSTNAME` in the dedicated
trial deployment configuration, and install `TRIAL_TURNSTILE_SECRET` with
`wrangler secret put` against that same trial configuration. Never put the secret
in source or browser configuration. The non-public deployment template leaves
these values empty and cannot admit new trials until configured.

Tokens stay in page memory, are discarded on use, expiry, identity changes or
page suspension, and are never retained as workflow data. A lost reservation
response requires a status read; a genuinely missing reservation needs a new
Turnstile token and reuses the admission idempotency key. The widget switches to
its compact size on narrow phones, including after orientation changes.

Automated browser tests use Cloudflare's documented test sitekey and intercepted
Siteverify responses in a labeled local fixture. They prove layout and request
handling, not a real human solve. Production uses a separate real widget.

Live probes observed challenges on both public entry pages, JSON 401 for an
unauthenticated agent request, HTTP 429 for a bounded API burst and HTTP 404 on
the former demo `workers.dev` address. All eight private-route probes still
redirected to Access before the intentional burst; private deployment and
bindings were unchanged.

The automated browser reached Cloudflare security verification. A human's fresh
browser pass-through has not been confirmed after enabling this rule. These
controls reduce automated abuse; they do not guarantee zero bots or a billing cap.
Private operator receipts retain the original and updated expressions for review.
