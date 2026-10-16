import {SETUP_CHECKS, installationReadiness} from '../public/installation-readiness.js';
// Read-only prerequisites and literal configuration checks. Never starts the app,
// invokes Wrangler, authenticates, or contacts a provider.
import {readFile, realpath, stat} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {dirname, isAbsolute, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const runFile = promisify(execFile);
const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const inside = (root, file) => {
  const path = relative(root, file);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep));
};
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const requireThat = value => { if (!value) throw new Error('Setup prerequisite not met.'); };
const versionParts = value => value.match(/^(\d+)\.(\d+)\.(\d+)$/)?.slice(1).map(Number);

async function probe(command, args, root) {
  try {
    const result = await runFile(command, args, {cwd: root, timeout: 5000, maxBuffer: 16384, windowsHide: true});
    return {code: 0, stdout: result.stdout};
  } catch (error) {
    // Error text and subprocess output can contain local paths or credentials.
    return {code: typeof error.code === 'number' ? error.code : 1, stdout: ''};
  }
}

export async function inspectSetup({root = sourceRoot, configPath, docker = false,
  nodeVersion = process.versions.node, run = probe} = {}) {
  root = await realpath(root);
  const checks = [];
  const check = async (id, inspect, prerequisite = true) => {
    const {label, action} = SETUP_CHECKS[id];
    if (!prerequisite) { checks.push({id, label, status: 'not_checked', action: 'Resolve the blocked configuration prerequisite, then repeat this check.'}); return false; }
    try { const detail = await inspect(); checks.push({id, label, status: 'passed', ...(detail ? {detail} : {})}); return true; }
    catch { checks.push({id, label, status: 'blocked', action}); return false; }
  };
  let manifest, lock;
  await check('source', async () => {
    manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
    lock = JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf8'));
    requireThat(object(manifest) && object(lock.packages) && manifest.name === lock.packages['']?.name);
  });
  await check('node', () => {
    const minimum = manifest?.engines?.node?.match(/^>=(\d+\.\d+\.\d+)$/)?.[1];
    const wanted = minimum && versionParts(minimum), actual = versionParts(nodeVersion);
    requireThat(wanted && actual);
    const difference = actual.map((part, index) => part - wanted[index]).find(part => part !== 0) ?? 0;
    requireThat(difference >= 0);
    return `Node.js ${nodeVersion}; required >=${minimum}`;
  });
  await check('git', async () => {
    const result = await run('git', ['--version'], root);
    requireThat(result.code === 0 && /^git version \d+\.\d+/.test(result.stdout));
  });
  await check('dependencies', async () => {
    requireThat(manifest && lock);
    const names = Object.keys({...manifest.dependencies, ...manifest.devDependencies});
    let matched = 0;
    for (const name of names) {
      const installed = JSON.parse(await readFile(resolve(root, 'node_modules', name, 'package.json'), 'utf8'));
      const locked = lock.packages['node_modules/' + name]?.version;
      if (typeof locked === 'string' && installed.name === name && installed.version === locked) matched++;
    }
    requireThat(matched === names.length);
    return `${matched}/${names.length} direct packages match; transitive files and executable behavior are not checked`;
  });
  if (docker) await check('docker', async () => {
    const result = await run('docker', ['info', '--format', '{{.OSType}}'], root);
    requireThat(result.code === 0 && result.stdout.trim() === 'linux');
    return 'Engine responds; verification image selection and command checks remain unverified';
  });

  if (configPath) {
    const file = resolve(root, configPath);
    await check('private-config', async () => {
      const actual = await realpath(file);
      if (!inside(root, actual)) return;
      const path = relative(root, actual);
      const tracked = await run('git', ['ls-files', '--error-unmatch', '--', path], root);
      const ignored = await run('git', ['check-ignore', '-q', '--', path], root);
      requireThat(tracked.code === 1 && ignored.code === 0);
    });
    let config;
    const parsed = await check('config', async () => {
      requireThat(/\.jsonc?$/.test(file) && (await stat(file)).size <= 1024 * 1024);
      const {parse} = await import('jsonc-parser');
      const errors = [], value = parse(await readFile(file, 'utf8'), errors, {allowTrailingComma: true});
      requireThat(errors.length === 0 && object(value));
      // Only the root configuration is inspected; do not imply named environments were checked.
      requireThat(!Object.hasOwn(value, 'env'));
      config = value;
    });
    {
      await check('target', () => {
        requireThat(/^[a-f0-9]{32}$/.test(config.account_id) && /^[a-z0-9][a-z0-9-]{0,62}$/.test(config.name));
      }, parsed);
      await check('source-paths', async () => {
        const from = dirname(file);
        const same = async (value, expected) => {
          requireThat(typeof value === 'string');
          requireThat(relative(await realpath(resolve(root, expected)), await realpath(resolve(from, value))) === '');
        };
        await same(config.main, 'src/cloudflare/index.ts');
        await same(config.assets?.directory, 'public');
        await same(config.containers?.find(item => item.class_name === 'RepositoryCheckContainer')?.images?.verifier?.dockerfile, 'containers/verification/Dockerfile');
        await same(config.d1_databases?.find(item => item.binding === 'SEARCH_DB')?.migrations_dir, 'migrations/search');
      }, parsed);
      await check('private-ingress', () => {
        requireThat(config.workers_dev === false && config.preview_urls === false && config.assets?.run_worker_first === true);
      }, parsed);
      let policy;
      const policyValid = await check('access-policy', async () => {
        const {accessPolicy} = await import('../src/cloudflare/access.ts');
        policy = accessPolicy(config.vars ?? {});
      }, parsed);
      await check('agent-identities', () => {
        requireThat(policy?.agentClientIds.length > 0 && (policy.reviewerClientIds.length + policy.reviewerSubjects.length) > 0);
      }, policyValid);
      await check('current-policy', () => {
        const service = config.services?.find(item => item.binding === 'CURRENT_POLICY');
        requireThat(service?.service === config.name && service.entrypoint === 'WorkspacePolicy');
      }, parsed);
      await check('bindings', () => {
        for (const [name, className] of [['WORKSPACES', 'WorkspaceCoordinator'], ['REPOSITORY_CHECKS', 'RepositoryCheckContainer']]) {
          requireThat(config.durable_objects?.bindings?.some(item => item.name === name && item.class_name === className));
        }
        requireThat(config.worker_loaders?.some(item => item.binding === 'LOADER') && config.ai?.binding === 'SEARCH_AI');
      }, parsed);
      await check('resources', () => {
        requireThat(config.artifacts?.some(item => item.binding === 'ARTIFACTS' && typeof item.namespace === 'string' && item.namespace.length));
        requireThat(config.d1_databases?.some(item => item.binding === 'SEARCH_DB' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(item.database_id)));
        requireThat(config.vectorize?.some(item => item.binding === 'SEARCH_VECTORS' && typeof item.index_name === 'string' && item.index_name.length));
        const search = config.queues?.producers?.find(item => item.binding === 'SEARCH_JOBS');
        requireThat(typeof search?.queue === 'string' && search.queue.length && config.queues.consumers?.some(item => item.queue === search.queue));
        const events = config.vars?.ARTIFACTS_EVENTS_QUEUE;
        requireThat(typeof events === 'string' && events.trim().length > 0 && config.queues.consumers?.some(item => item.queue === events));
      }, parsed);
      await check('event-policy', async () => {
        requireThat(['ARTIFACTS_EVENTS_ACCOUNT_ID', 'ARTIFACTS_EVENTS_NAMESPACE', 'ARTIFACTS_EVENTS_QUEUE',
          'ARTIFACTS_EVENTS_SUBSCRIPTIONS', 'WORKSPACE_ID'].every(key => typeof config.vars?.[key] === 'string'));
        requireThat(!Object.hasOwn(config.vars, 'ARTIFACTS_EVENTS_AUTOMATIC') || ['true', 'false'].includes(config.vars.ARTIFACTS_EVENTS_AUTOMATIC));
        const {artifactEventPolicy} = await import('../src/cloudflare/artifact-events.ts');
        const events = artifactEventPolicy(config.vars ?? {});
        requireThat(events.accountId === config.account_id && events.namespace === config.artifacts?.find(item => item.binding === 'ARTIFACTS')?.namespace
          && config.queues?.consumers?.some(item => item.queue === events.queue));
        if (events.automatic) {
          const registrations = config.services?.filter(item => item.binding === 'EVENT_SUBSCRIPTIONS');
          const service = registrations?.[0];
          requireThat(/^[a-f0-9]{32}$/.test(config.vars.ARTIFACTS_EVENTS_QUEUE_ID) && registrations?.length === 1
            && service.entrypoint === 'ArtifactSubscriptionService' && typeof service.service === 'string'
            && /^[a-z0-9][a-z0-9-]{0,62}$/.test(service.service) && service.service !== config.name);
        }
      }, parsed);
      await check('secrets', () => {
        requireThat(!Object.entries(config.vars ?? {}).some(([key, value]) => /(?:API_KEY|CLIENT_SECRET|PASSWORD|TOKEN)$/.test(key) && value !== ''));
      }, parsed);
    }
  }
  const passed = checks.filter(check => check.status === 'passed').length;
  const blocked = checks.filter(check => check.status === 'blocked').length;
  const report = {schemaVersion: 2, generatedAt: new Date().toISOString(), scope: 'offline-setup-prerequisites', profile: configPath ? 'hosted-config' : 'local', requested: {docker, hostedConfig: Boolean(configPath)},
    status: passed === checks.length ? 'passed' : 'blocked', summary: {passed, blocked, notChecked: checks.length - passed - blocked, total: checks.length},
    providerRequests: 0, hostedAcceptance: false, applicationStarted: false, checks,
    notVerified: [...(docker ? [] : ['Docker engine availability']), 'Verification images, full Wrangler schema and binding/migration compatibility',
      'Application startup and workflow behavior', 'Access sessions, edge policies and credential expiry',
      'Cloudflare resource existence, account entitlement and protected routes', 'Registration-service account, namespace, queue, workspace, owner settings and credentials',
      'Repository operations, independent checks, review and integration']};
  return {...report, installation: installationReadiness(report)};
}

export function setupArguments(args) {
  const result = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--json' || arg === '--docker' || arg === '--help') {
      const key = arg.slice(2); if (result[key]) throw new Error('Supply each setup option once.'); result[key] = true;
    } else if (arg === '--config' && result.configPath === undefined && args[index + 1] && !args[index + 1].startsWith('--')) result.configPath = args[++index];
    else throw new Error('Use setup-check.mjs [--config file.jsonc] [--docker] [--json] [--help].');
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = setupArguments(process.argv.slice(2));
    if (args.help) console.log('Usage: npm run setup:check -- [--config file.jsonc] [--docker] [--json]\nRead-only local prerequisites and literal hosted config checks. --docker only queries the configured engine.\nNo app, tests, Wrangler, deployment, provider authentication or model calls are started.\nA pass is not hosted acceptance. See docs/independent-setup.md.');
    else {
      const report = await inspectSetup(args);
      if (args.json) console.log(JSON.stringify(report, null, 2));
      else {
        console.log(`Offline ${report.profile} prerequisites: ${report.summary.passed}/${report.summary.total} passed; ${report.summary.blocked} blocked; ${report.summary.notChecked} not checked.`);
        for (const check of report.checks) console.log(`${check.status === 'passed' ? 'PASS' : check.status === 'blocked' ? 'BLOCKED' : 'NOT CHECKED'} ${check.label}${check.detail ? ': ' + check.detail : ''}${check.action ? '\n  Next: ' + check.action : ''}`);
        console.log('Installation stages:');
        for (const stage of report.installation.stages) console.log('  ' + stage.label + ': ' + stage.status.replaceAll('_', ' ') + (stage.summary ? ' (' + stage.summary.passed + '/' + stage.summary.total + ' local checks passed)' : ''));
        console.log('Not verified: ' + report.notVerified.join('; ') + '.');
        console.log('No application or provider operations ran. A pass is not hosted acceptance.');
      }
      process.exitCode = report.status === 'passed' ? 0 : 1;
    }
  } catch { console.error('Setup check could not finish. Check the source installation and command options; no provider operation was requested.'); process.exitCode = 2; }
}
