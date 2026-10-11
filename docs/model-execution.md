# Bounded model execution

## Local setup

Install the locked dependencies with `npm ci`. Docker must be running. Pull `node:24-bookworm-slim`, then use `docker image inspect node:24-bookworm-slim --format "{{.Id}}"` to obtain its immutable image ID.

Copy `.env.example` to `.env`. Set the exact Chat Completions endpoint, API key, model and immutable sandbox image ID. The provider must support `max_completion_tokens`, one JSON completion and prompt/output usage reporting. There is no endpoint or model fallback. Run `npm run dev:model` and open the loopback URL printed by the server. Use a free port if another workbench is running; never remove its lock to start a second owner of its data.

Choose the checkout starter in the project form and select configured model agents. Inspect the allowance before starting. This bounded model adapter edits checkout.mjs; arbitrary connected project work uses the external-agent protocol. The scripted starter is labeled separately from model inference within the same project views.

## Limits and receipts

Each candidate has explicit maximum requests, input bytes per request, output tokens per request and elapsed model-work time. Full conversation history is retained; an oversized conversation stops rather than being silently shortened. Provider errors and missing usage stop the attempt without an automatic retry. Unknown usage remains unknown. Cached input is a subset of input, not an extra charge or a dollar estimate.

The time allowance covers generation, application of edits and development checks. Git operations and independent final verification have their own bounded process timeouts. A deadline aborts the client request; provider work already accepted may still be billable. These controls do not reconcile provider invoices or impose a dollar cap.

`.local/attempts/<run-id>.json` retains the reservation before each request, provider usage, returned edits, development checks and terminal outcome. Failed runs remain visible and count in the candidate denominator. Restart marks interrupted work failed and never restarts inference. Provider credentials stay in the controller and are not passed to candidate containers.

## Independent checks and merge

The model may change only assigned source files. Generated code executes in a pinned Docker image with no network, no writable host mount, no provider secret, no Docker socket, a read-only filesystem and resource limits. The container receives frozen test inputs; expected outcomes and scoring remain outside it. Printed pass claims do not establish evidence, and valid totals cannot conceal input mutation.

Final checks run against a detached checkout of the exact committed candidate. Review and merge remain separate actions. Merge repeats independent checks and verifies both base and candidate heads. A model candidate still requires the sandbox after restart; it never falls back to host execution.

## Durable registry migration

Version 1 registries could record only trusted scripted candidates. They are validated against the original harness and loaded as scripted work; subsequent persistence writes version 2, which explicitly records the execution kind and the combined verifier hash. Invalid or redirected records still fail before use.

Compatibility retained:
- Consumer: existing local scripted-demo registries written by version 0.1.0.
- Owner: Projects Git local GitRunner.
- Removal condition: a future explicit data-format cutover after retained version 1 workspaces are migrated.
- Test coverage: version 1 preservation and version 2 restart/refusal tests; model candidates require the sandbox after restart.
- Why hard cutover is unsafe now: it would prevent inspection and review of the owner's retained demonstration work.

## Verification commands

Run `npm test` for core, controller and provider-transport tests. Docker integration cases are separately enabled by `PROJECTS_SANDBOX_TEST_IMAGE=<immutable image ID> node --test tests/sandbox.test.mjs`. They use a deterministic provider response and real Git/container execution, not a paid model or comparative benchmark. Live provider qualification must be recorded separately.
