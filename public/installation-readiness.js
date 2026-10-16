// Shared offline check definitions and presentation. No filesystem, network or authority.
export const SETUP_CHECKS = Object.freeze(Object.fromEntries(Object.entries({
  "source": {
    "label": "Source manifest and lockfile",
    "action": "Use a complete source checkout or archive with package.json and package-lock.json.",
    "stage": "prerequisites"
  },
  "node": {
    "label": "Node.js requirement",
    "action": "Install the minimum Node.js version declared in package.json.",
    "stage": "prerequisites"
  },
  "git": {
    "label": "Git executable",
    "action": "Install Git and make it available to this terminal.",
    "stage": "prerequisites"
  },
  "dependencies": {
    "label": "Installed direct dependency metadata matches the lockfile",
    "action": "Run npm ci in this source checkout, then repeat this check.",
    "stage": "prerequisites"
  },
  "docker": {
    "label": "Docker Linux engine responds",
    "action": "Start Docker with its Linux engine. This probe does not build or run a container.",
    "stage": "prerequisites"
  },
  "private-config": {
    "label": "Operator configuration is outside source control",
    "action": "Keep the operator config outside the checkout, or use ignored wrangler.operator.jsonc; never commit credentials.",
    "stage": "configuration"
  },
  "config": {
    "label": "Literal operator JSON/JSONC configuration",
    "action": "Use a JSON/JSONC config of at most 1 MiB without named environments. Install locked dependencies first. TypeScript/TOML configs are not evaluated.",
    "stage": "configuration"
  },
  "target": {
    "label": "Explicit account and Worker",
    "action": "Set account_id to your account ID and name to your Worker name; use a flattened config without named environments.",
    "stage": "configuration"
  },
  "source-paths": {
    "label": "Config targets this checkout",
    "action": "Keep a root operator copy of wrangler.jsonc, or resolve its main, assets, Dockerfile and migration paths to this checkout.",
    "stage": "configuration"
  },
  "private-ingress": {
    "label": "Default and preview endpoints disabled",
    "action": "Set workers_dev and preview_urls to false and assets.run_worker_first to true. Confirm Access protection separately before activating a hostname.",
    "stage": "configuration"
  },
  "access-policy": {
    "label": "Access policy satisfies the application contract",
    "action": "Configure Access issuer, audience, verified owner subject, workspace and disjoint identity lists. See docs/authenticated-workspace.md.",
    "stage": "configuration"
  },
  "agent-identities": {
    "label": "Builder and independent reviewer configured",
    "action": "Configure at least one builder plus a distinct reviewer service or human identity. This check does not verify their credentials, access or expiry.",
    "stage": "configuration"
  },
  "current-policy": {
    "label": "Current-policy binding targets this Worker",
    "action": "Set CURRENT_POLICY to this Worker name and the WorkspacePolicy entrypoint.",
    "stage": "configuration"
  },
  "bindings": {
    "label": "Core execution bindings retained",
    "action": "Preserve WORKSPACES/WorkspaceCoordinator, REPOSITORY_CHECKS/RepositoryCheckContainer, LOADER and SEARCH_AI from wrangler.jsonc.",
    "stage": "configuration"
  },
  "resources": {
    "label": "Core resource identifiers supplied",
    "action": "Configure your Artifacts namespace, SEARCH_DB database ID, search/event queues and Vectorize index. Their existence is checked only during separately authorized hosted setup.",
    "stage": "configuration"
  },
  "event-policy": {
    "label": "Application event policy and registration-service declaration",
    "action": "Pin the application's account, namespace, workspace, queue and exact manual repository subscriptions. Automatic registration needs its Queue ID and one valid service target distinct from the application. Companion-service settings, resource existence and credentials remain separately unverified.",
    "stage": "configuration"
  },
  "secrets": {
    "label": "Known runtime secrets absent from plaintext vars",
    "action": "Use the secret mechanism described in the operator guide, never plaintext vars, for API keys and subscription credentials.",
    "stage": "configuration"
  }
}).map(([id, check]) => [id, Object.freeze(check)])));

export const MAX_SETUP_REPORT_BYTES = 65536;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const statuses = ['passed', 'blocked', 'not_checked'];
const failure = () => { throw new Error('Choose a complete JSON report from the Projects Git offline setup checker.'); };
const count = checks => ({passed: checks.filter(c => c.status === 'passed').length, blocked: checks.filter(c => c.status === 'blocked').length,
  notChecked: checks.filter(c => c.status === 'not_checked').length, total: checks.length});
const stageIds = stage => Object.keys(SETUP_CHECKS).filter(id => SETUP_CHECKS[id].stage === stage);

// Imported labels, prose, extra fields and claimed readiness never reach the view.
// A supplied file is an operator report, not authenticated installation evidence.
export function readSetupReport(input) {
  if (!plain(input) || input.schemaVersion !== 2 || input.scope !== 'offline-setup-prerequisites'
    || !['local', 'hosted-config'].includes(input.profile) || !plain(input.requested)
    || typeof input.requested.docker !== 'boolean' || typeof input.requested.hostedConfig !== 'boolean'
    || input.requested.hostedConfig !== (input.profile === 'hosted-config')
    || input.providerRequests !== 0 || input.hostedAcceptance !== false || input.applicationStarted !== false
    || !Array.isArray(input.checks)) failure();
  const ids = [...stageIds('prerequisites').filter(id => id !== 'docker' || input.requested.docker),
    ...(input.requested.hostedConfig ? stageIds('configuration') : [])];
  if (input.checks.length !== ids.length || new Set(input.checks.map(c => c?.id)).size !== ids.length) failure();
  const checks = ids.map(id => {
    const check = input.checks.find(c => plain(c) && c.id === id);
    if (!check || !statuses.includes(check.status)) failure();
    return {id, status: check.status};
  });
  const summary = count(checks);
  if (!plain(input.summary) || Object.entries(summary).some(([key, value]) => input.summary[key] !== value)
    || input.status !== (summary.passed === summary.total ? 'passed' : 'blocked')) failure();
  if (typeof input.generatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input.generatedAt)
    || !Number.isFinite(Date.parse(input.generatedAt)) || new Date(input.generatedAt).toISOString() !== input.generatedAt) failure();
  return {profile: input.profile, dockerRequested: input.requested.docker, reportedAt: input.generatedAt, summary, checks};
}

export function installationReadiness(input = null) {
  const report = input === null ? null : readSetupReport(input);
  const offline = (id, label) => {
    const requested = Boolean(report && (id === 'prerequisites' || report.profile === 'hosted-config'));
    const ids = stageIds(id).filter(key => key !== 'docker' || report?.dockerRequested);
    const checks = ids.map(key => ({id: key, ...SETUP_CHECKS[key], status: report?.checks.find(c => c.id === key)?.status ?? 'not_checked'}));
    const summary = count(checks);
    return {id, label, requested, status: !requested ? 'not_checked' : summary.passed === summary.total ? 'checked_locally' : 'blocked', summary, checks};
  };
  return {format: 'projects-git-installation-readiness/v1', report,
    // No offline input can advance these hosted stages or enable an action.
    stages: [offline('prerequisites', 'Local prerequisites'), offline('configuration', 'Hosted configuration'),
      {id: 'resources', label: 'Cloudflare resources', status: 'not_verified', next: 'Separately verify isolated resources, bindings, migrations, subscriptions and account access under an approved setup attempt.'},
      {id: 'deployment', label: 'Deployment', status: 'not_verified', next: 'Separately record the exact deployed source/version and protected hostname. Configuration checks do not deploy anything.'},
      {id: 'private-verification', label: 'Private installation verification', status: 'not_verified', next: 'Separately verify sign-in, role refusals, one checked and reviewed workflow, persistence and cleanup in the isolated installation.'}],
    hostedInstallationVerified: false};
}
