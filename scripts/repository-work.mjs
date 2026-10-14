import { requiredOptions, readBounded, parseJson } from '../src/local/cli-input.mjs';
import { taskBriefs } from '../src/core/project-work.mjs';
import { browserLink, projectSummary, projectStatus, taskDetail, candidateSummary } from '../src/local/repository-cli-view.mjs';

const commands = {
  projects: { keys: ['url'], description: 'Discover project IDs, admission and policy versions.' },
  status: { keys: ['url', 'project'], description: 'Inspect project queues, retained candidates, decisions and explicit denominators.' },
  connect: { keys: ['url', 'repo', 'base', 'project-name', 'brief', 'request-id'], description: 'Connect a committed repository and queue a JSON task stack.' },
  queue: { keys: ['url', 'project', 'brief', 'request-id'], description: 'Queue a JSON task stack in a connected project.' },
  claim: { keys: ['url', 'project', 'label', 'request-id'], description: 'Claim the oldest eligible queued task; skip prerequisites awaiting integration, or return idle.' },
  assign: { keys: ['url', 'task', 'label', 'request-id'], description: 'Prepare an alternative agent checkout for a task.' },
  show: { keys: ['url', 'task'], description: 'Read the task, requirements digest and candidate outcomes.' },
  revise: { keys: ['url', 'task', 'expected-revision', 'brief'], description: 'Revise requirements using a JSON file containing purpose, criteria and reason.' },
  admission: { keys: ['url', 'project', 'expected-version', 'state'], description: 'Set admission on or off using the current policyVersion.' },
  start: { keys: ['url', 'run'], description: 'Report that the assigned agent has started.' },
  submit: { keys: ['url', 'run', 'head', 'summary'], description: 'Submit the full commit ID on the assigned branch.' },
  fail: { keys: ['url', 'run', 'message'], description: 'Retain the execution failure and release the agent slot.' },
  check: { keys: ['url', 'run', 'checks', 'checks-sha256', 'image'], description: 'Pin and run independent checks for a submitted candidate.' },
  recheck: { keys: ['url', 'run', 'head', 'revision'], description: 'Rerun retained checks against this exact head and task revision.' },
  'update-base': { keys: ['url', 'run', 'head', 'revision', 'mode'], description: 'Reapply changes or prepare a resolution checkout on current project main.' },
};

const hostedCommands = {
  projects: ['connection'], status: ['connection', 'project'], show: ['connection', 'task'],
  claim: ['connection', 'project', 'label', 'request-id'],
  start: ['connection', 'run', 'request-id'], submit: ['connection', 'run', 'head', 'summary', 'request-id'],
  fail: ['connection', 'run', 'message', 'request-id'],
  checkout: ['connection', 'run', 'directory', 'request-id'],
  push: ['connection', 'run', 'directory', 'head', 'request-id'], receipt: ['connection', 'request-id'],
};
const hostedOptional = {projects:['offset','revision'],checkout:['assignment'],submit:['directory']};
let hostedClient;

function help(command) {
  const selected = command ? (commands[command] ? [command] : []) : Object.keys(commands);
  console.log('Projects repository workflow\n\n' + selected.map(name =>
    `node scripts/repository-work.mjs ${name} ${commands[name].keys.map(key => `--${key} <${key}>`).join(' ')}\n  ${commands[name].description}`).join('\n\n'));
  console.log('\nLocal commands use --url with an HTTP loopback origin, for example http://127.0.0.1:4178.\nHosted agent commands use --connection with an absolute private connection JSON file.\nSuccess output is JSON. --help (global or after a command) needs no --url.\nAcceptance and merge are controlled by the owner in the app. No mutation is retried automatically.');
  const remote = command ? (hostedCommands[command] ? [command] : []) : Object.keys(hostedCommands);
  if (remote.length) console.log('\nHosted agent mode:\n' + remote.map(name => `node scripts/repository-work.mjs ${name} ${hostedCommands[name].map(key => `--${key} <${key}>`).join(' ')}`).join('\n')
    + '\nSee docs/hosted-agent-client.md. The client cannot change policy, create projects, verify, review, accept or merge.\nPrivate request receipts retain outcomes; receipt only reads them. Never print credentials or commit connection files or private client state.');
  if (!command || command==='projects') console.log('\nHosted projects returns ten projects. Continue with optional --offset <nextOffset> --revision <revision> from its page result; restart after a revision conflict.');
  if (!command || command==='checkout') console.log('\nHosted checkout accepts optional --assignment <absolute-private-response.json> for owner-issued resolution work. It verifies the live assignment before retaining its credential and cloning; it does not create or renew an assignment.');
  if (!command || command==='submit') console.log('\nHosted submit accepts optional --directory <absolute-assigned-checkout> to push and confirm the exact head before submission. The Git step has a retained child request ID. No failed or uncertain operation is automatically retried.');
  if (!command || ['connect', 'queue', 'claim', 'assign'].includes(command)) console.log('\n--request-id is an explicit UUID. Reuse it only for the same action, label and input.\nTask stack --brief: {"tasks":[{"title":"Change","purpose":"Result","criteria":["Check"],"owner":"Coordinator"}]}');
  if (!command || command === 'revise') console.log('\nRevision --brief: {"purpose":"Updated result","criteria":["Current criterion"],"reason":"Why it changed"}\n--expected-revision is the current task revision from show. Old reports and decisions remain recorded.');
  if (!command || command === 'admission') console.log('\n--state must be on or off; --expected-version is policyVersion from projects or status.\nOff blocks new assignments and starts. Existing runs continue under their chat host. Queueing, existing submissions and checks remain available.');
  if (!command || ['check', 'recheck'].includes(command)) console.log('\nIndependent verification does not mean all checks pass. Failed check/recheck results are JSON with a nonzero exit.\ncheck requires a bounded UTF-8 JSON definition, its SHA-256 and an installed immutable sha256: image ID.\nrecheck never rewrites stored checks: after requirements change, use check to explicitly pin a current definition first.');
  if (!command || command === 'update-base') console.log('\n--mode must be reapply or resolve. --head is the full retained commit; --revision is the current task revision.\nreapply carries the check definition, but needs fresh verification and review. resolve returns a new checkout and branch.');
  if (!command || ['revise', 'admission', 'recheck', 'update-base'].includes(command)) console.log('\nRevision and version flags must be safe positive decimal integers. Stale guards fail; read current state before trying again.');
}

function positiveInteger(value, key) {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`--${key} must be a safe positive integer.`);
  return Number(value);
}

function nextAfterError(code, options) {
  if (code === 'stale_project_policy' || code === 'project_paused') return `Run status --url ${options.url} --project ${options.project ?? '<project-id>'}; admission requires its current policyVersion as --expected-version.`;
  if (code === 'stale_requirements') return `Run show --url ${options.url} --task ${options.task ?? '<task-id>'} and read the current revision before revising or assigning work.`;
  if (['stale_candidate', 'stale_verification', 'stale_base'].includes(code)) return 'Read the current task with show; use its candidate headCommit and task revision. Update the base only when project main has advanced.';
  if (code === 'check_definition_invalid') return 'Read the task with show, then explicitly configure check with the current head, taskRevision and requirementsSha256. recheck does not rewrite retained definitions.';
  if (code === 'base_update_conflict') return 'Inspect the retained changes, then use update-base --mode resolve with the same current head and revision to prepare a resolution checkout.';
  if (code === 'repository_busy' || code === 'assignment_preparing') return 'Wait for the current repository operation. Retry explicitly with the same --request-id and inputs when supplied.';
  return 'Inspect current state with projects, status or show before repeating the action.';
}

async function request(url, endpoint, body, options) {
  let response;
  try {
    response = await fetch(new URL(endpoint, url), { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' },
      redirect: 'error', body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(120000) });
  } catch (error) {
    throw new Error(`Workspace request failed: ${error.message}.${body ? ' The mutation outcome is unknown.' : ''} No automatic retry was attempted. Inspect status before repeating a mutation; reuse its --request-id and inputs when supplied.`);
  }
  let result;
  try { result = await response.json(); }
  catch { throw new Error(`Workspace returned a non-JSON response (HTTP ${response.status}).${body ? ' The mutation outcome is unknown.' : ''} No automatic retry was attempted. Inspect status before repeating the action; reuse its --request-id and inputs when supplied.`); }
  if (!response.ok) throw new Error(`Workspace refused the request (${result.error?.code ?? response.status}): ${result.error?.message ?? response.statusText}\n${nextAfterError(result.error?.code, options)} No automatic retry was attempted.`);
  return result;
}

try {
  const command = process.argv[2], args = process.argv.slice(3);
  if (command === '--help' || command === 'help' || !command) help();
  else if (!commands[command] && !hostedCommands[command]) throw new Error('Unknown command. Run node scripts/repository-work.mjs --help. Acceptance and merge are browser operations.');
  else if (args.includes('--help')) help(command);
  else if (args.includes('--connection') || !commands[command]) {
    if (!hostedCommands[command]) throw new Error('That command is not available to hosted agents. Use the authenticated owner app for policy, tasks, verification and decisions.');
    const options = requiredOptions(args, hostedCommands[command],hostedOptional[command]??[]);
    const {HostedAgentClient,loadHostedConnection} = await import('../src/local/hosted-agent-client.mjs');
    const connection = await loadHostedConnection(options.connection);
    hostedClient = new HostedAgentClient(connection);
    const output = await hostedClient.execute(command, { ...options, requestId: options['request-id'] });
    console.log(hostedClient.serialize(output));
  }
  else {
    const options = requiredOptions(args, commands[command].keys);
    const url = new URL(options.url);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Use the loopback workspace origin, without credentials or a path.');
    for (const key of ['expected-revision', 'expected-version', 'revision']) if (key in options) options[key] = positiveInteger(options[key], key);
    const call = (endpoint, body) => request(url, endpoint, body, options);
    let endpoint, body;
    if (['projects', 'status', 'show'].includes(command)) endpoint = '/api/workspace';
    else if (command === 'connect' || command === 'queue') {
      const brief = parseJson(await readBounded(options.brief, 128 * 1024, 'Task stack'), 'Task stack');
      endpoint = '/api/tasks'; body = { tasks: taskBriefs({ tasks: brief?.tasks }), requestId: options['request-id'], ...(command === 'connect'
        ? { source: 'repository', projectName: options['project-name'], repo: options.repo, baseCommit: options.base }
        : { source: 'project', projectId: options.project }) };
    } else if (command === 'revise') {
      const brief = parseJson(await readBounded(options.brief, 128 * 1024, 'Revision brief'), 'Revision brief');
      if (!brief || typeof brief !== 'object' || Array.isArray(brief)) throw new Error('Revision brief must contain purpose, criteria and reason.');
      endpoint = `/api/tasks/${encodeURIComponent(options.task)}/revise`;
      body = { purpose: brief.purpose, criteria: brief.criteria, reason: brief.reason, expectedRevision: options['expected-revision'] };
    } else if (command === 'admission') {
      if (!['on', 'off'].includes(options.state)) throw new Error('--state must be on or off.');
      endpoint = `/api/projects/${encodeURIComponent(options.project)}/policy`;
      body = { acceptingWork: options.state === 'on', expectedVersion: options['expected-version'] };
    } else if (command === 'claim') { endpoint = `/api/projects/${encodeURIComponent(options.project)}/claim`; body = { label: options.label, requestId: options['request-id'] }; }
    else if (command === 'assign') { endpoint = `/api/tasks/${encodeURIComponent(options.task)}/agents`; body = { label: options.label, requestId: options['request-id'] }; }
    else {
      endpoint = `/api/runs/${encodeURIComponent(options.run)}/${command === 'check' ? 'checks' : command === 'recheck' ? 'verify' : command}`;
      body = command === 'submit' ? { headCommit: options.head, summary: options.summary }
        : command === 'fail' ? { message: options.message } : {};
      if (command === 'check') {
        const bytes = await readBounded(options.checks, 65536, 'Checks');
        parseJson(bytes, 'Checks');
        body = { definition: new TextDecoder('utf-8', { fatal: true }).decode(bytes), definitionSha256: options['checks-sha256'], image: options.image };
      }
      if (['recheck', 'update-base'].includes(command)) body = { headCommit: options.head, taskRevision: options.revision };
      if (command === 'update-base') {
        if (!['reapply', 'resolve'].includes(options.mode)) throw new Error('--mode must be reapply or resolve.');
        body.mode = options.mode;
      }
    }
    if (['connect', 'queue'].includes(command) && body.tasks.some(task => task.dependsOn?.length)) {
      const current = await call('/api/workspace');
      if (!current.capabilities?.dependencies) throw new Error('This server cannot enforce task prerequisites. Restart it with the updated Projects Git source before queueing dependent work. No mutation was sent.');
    }
    const result = await call(endpoint, body);
    let output;
    if (command === 'projects') output = { projects: Object.keys(result.projects ?? {}).map(id => projectSummary(result, id, url)), workspaceVersion: result.version, browserUrl: browserLink(url, 'overview') };
    else if (command === 'status' || command === 'admission') {
      output = projectStatus(result, options.project, url);
      if (command === 'admission') output.admissionEffect = (options.state === 'off'
        ? 'New assignments and starts are paused.' : 'New assignments and starts are enabled.')
        + ' Existing runs continue under their chat host. Queueing, existing submissions, checks and review remain available.';
    }
    else if (command === 'show' || command === 'revise') output = taskDetail(result, options.task, url);
    else if (result.runs) {
      output = candidateSummary(result, options.run, url);
      if (['check', 'recheck'].includes(command) && !output.verification.currentChecksPassing) process.exitCode = 1;
    } else {
      // A successful mutation is never repeated if its readback fails.
      let workspace;
      try { workspace = await call('/api/workspace'); }
      catch (error) { throw new Error(`The ${command} request succeeded (${JSON.stringify(result)}), but its status readback failed. ${error.message}`); }
      output = { ...result };
      if (result.runId) {
        output.candidate = candidateSummary(workspace, result.runId, url);
        output.browserUrl = output.candidate.browserUrl;
        if (command === 'update-base') {
          const replacement = output.candidate;
          Object.assign(output, { checkout: replacement.checkout, branch: replacement.branch, baseCommit: replacement.baseCommit, revision: replacement.revision,
            previousCandidate: candidateSummary(workspace, options.run, url), instructions: options.mode === 'resolve'
              ? [`Read show --url ${url.origin} --task ${result.taskId} for revision ${replacement.revision}.`,
                `Work in ${replacement.checkout} on branch ${replacement.branch}. Report start for run ${replacement.runId}.`,
                `Reconcile the retained candidate ${options.run} at ${options.head} onto base ${replacement.baseCommit}; inspect its changes in previousCandidate.browserUrl.`,
                'Commit on the replacement branch, submit its full head, then explicitly configure and run independent checks. Review and merge in the browser.']
              : ['Run recheck for the replacement runId, headCommit and revision, then review and merge separately in the browser.'] });
        }
      } else if (result.projectId || options.project) output.project = projectStatus(workspace, result.projectId ?? options.project, url);
    }
    console.log(JSON.stringify(output, null, 2));
  }
} catch (error) {
  const message = error instanceof Error ? `${error.code ? `[${error.code}] ` : ''}${error.message}` : 'Repository workflow failed.';
  console.error(hostedClient ? hostedClient.sanitize(message) : message);
  process.exitCode = 1;
}
