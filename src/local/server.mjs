import http from 'node:http';
import {parseWorkspacePage, projectWorkspace} from '../../public/workspace-page.js';
import {parseProjectCatalog,projectCatalog,ProjectCatalogError} from '../../public/project-catalog.js';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, openSync, closeSync, unlinkSync, lstatSync } from 'node:fs';
import { resolve, dirname, extname, basename, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkspace, createTask, reviseTask, assignRun, startRun, completeRun, verifyRun,
  failRun, reviewRun, mergeRun, setTaskOwner, updateTaskBase, recordGitCandidate, workspaceCoordination, MAX_ACTIVE_RUNS, metrics, WorkflowError, validateCommit } from '../core/workflow.mjs';
import { GitRunner } from './git-runner.mjs';
import { chatProvider, executionLimits, runEditingAgent } from '../core/agent.mjs';
import { DockerChecks } from './sandbox-checks.mjs';
import { buildTaskHandoff } from '../core/handoff.mjs';
import { RepositoryRunner } from './repository-runner.mjs';
import { digest } from '../core/check-definition.mjs';
import { taskBriefs, projectName, queueProjectTasks, eligibleQueuedTasks, queueIdle, bindQueuedBase, setProjectPolicy } from '../core/project-work.mjs';
import { readOnlyGit } from './git-reader.mjs';
import { localMergeStateByRun, mergeEvidence, mergeEvidenceChanged, retainMergeEvidence } from '../core/merge-lifecycle.mjs';
import { GitHubPublication, githubRepository } from './github-publication.mjs';
import { GitHubClient } from './github-client.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MAX_BODY = 16384;
const sampleTask = { title: 'Make checkout totals trustworthy', owner: 'Local coordinator',
  purpose: 'Calculate exact integer-cent totals and reject invalid quantities, prices, and unsafe totals before an order is placed.',
  criteria: ['Add integer-cent prices without rounding errors.', 'Reject zero or negative quantities and invalid prices.',
    'Reject unsafe integer totals and leave valid inputs unchanged.'] };
const mediaTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

async function bodyJson(request, limit = MAX_BODY) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new WorkflowError('body_too_large', `Request exceeds ${limit / 1024} KiB.`, 413);
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Expected an object.');
    return body;
  } catch {
    throw new WorkflowError('invalid_json', 'Send a valid UTF-8 JSON object.', 400);
  }
}

function json(response, value, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

/** A local-only controller. Filesystem state and Git writes never touch the source repo. */
export function createApplication({ dataDir = resolve(projectRoot, '.local'), publicDir = resolve(projectRoot, 'public'), modelProvider = null, modelName = null, sandbox = null, githubProvider = null } = {}) {
  if (modelProvider && (!sandbox || typeof modelName !== 'string' || !modelName.trim())) throw new Error('Model execution needs a named provider and a sandbox.');
  if (githubProvider) githubRepository(githubProvider.repository);
  const dataRoot = resolve(dataDir);
  mkdirSync(dataRoot, { recursive: true });
  const lockFile = resolve(dataRoot, 'server.lock');
  const owner = { pid: process.pid, nonce: crypto.randomUUID() };
  function acquireLock() {
    try { return openSync(lockFile, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (lstatSync(lockFile).isSymbolicLink()) throw new Error('Server lock is redirected. Inspect the data directory.');
      let previous;
      try { previous = JSON.parse(readFileSync(lockFile, 'utf8')); }
      catch { throw new Error('Server lock is invalid. Inspect it before starting this workspace.'); }
      if (!Number.isInteger(previous.pid) || previous.pid < 1) throw new Error('Server lock has an invalid process ID.');
      try { process.kill(previous.pid, 0); }
      catch (processError) {
        if (processError.code !== 'ESRCH') throw new Error('Cannot establish that the workspace owner has stopped.');
        throw new Error('The recorded workspace owner has stopped. Preserve the data, verify all workspace servers are stopped, remove server.lock deliberately, then restart.');
      }
      throw new Error(`Workspace is already owned by process ${previous.pid}. Stop that server before opening it again.`);
    }
  }
  const lockDescriptor = acquireLock();
  writeFileSync(lockDescriptor, JSON.stringify(owner));
  closeSync(lockDescriptor);
  let locked = true;
  function releaseLock() {
    if (!locked) return;
    const current = JSON.parse(readFileSync(lockFile, 'utf8'));
    if (current.nonce !== owner.nonce || current.pid !== owner.pid) throw new Error('Workspace ownership changed unexpectedly.');
    unlinkSync(lockFile);
    locked = false;
  }
  const stateFile = resolve(dataRoot, 'workspace.json');
  const metadataFile = resolve(dataRoot, 'repositories.json');
  const intentsFile = resolve(dataRoot, 'merge-intents.json');
  const runner = new GitRunner({ rootDir: resolve(dataRoot, 'repositories'), sandbox });
  const repositoryRunner = new RepositoryRunner(resolve(dataRoot, 'connected'));
  const receiptsDir = resolve(dataRoot, 'attempts');
  mkdirSync(receiptsDir, { recursive: true });
  let state, repositories, mergeIntents;
  try {
    state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : createWorkspace({ name: 'Projects Git' });
    repositories = existsSync(metadataFile) ? JSON.parse(readFileSync(metadataFile, 'utf8')) : {};
    mergeIntents = existsSync(intentsFile) ? JSON.parse(readFileSync(intentsFile, 'utf8')) : {};
    if (state.schemaVersion !== 1 || state.provider !== 'local-git' || !Array.isArray(state.tasks) || !Array.isArray(state.runs)) {
      throw new Error('Stored workspace has an unsupported schema. Preserve the file and inspect it.');
    }
  } catch (error) {
    releaseLock();
    throw error;
  }
  let preparing = false;
  const running = new Set();
  const merging = new Set();
  const jobs = new Set();
  const requests = new Set();
  const recoveryErrors = [];
  const repositoryOperations = new Set();
  const repositoryImports = new Map();

  state.projects ??= {};
  for (const receipt of Object.values(state.agentClaims ?? {})) {
    if (!receipt.runId && receipt.result?.runId) { receipt.runId = receipt.result.runId; delete receipt.result; }
  }
  let repositoryMigration = false;
  for (const task of state.tasks) {
    if (!task.projectId) {
      task.projectId = task.id;
      state.projects[task.id] = { id: task.id, name: task.repositoryName ?? 'checkout-starter', repositoryName: task.repositoryName ?? 'checkout-starter', kind: task.origin === 'connected-git' ? 'connected' : 'sample',
        mainCommit: task.mergedCommit ?? task.baseCommit, owner: task.owner, acceptingWork: true, policyVersion: 1, sourceKey: task.repositoryKey };
      if (task.origin === 'connected-git') task.repositoryKey = task.id;
      repositoryMigration = true;
    }
  }
  if (repositoryMigration) state.version++;

  const publication = githubProvider ? new GitHubPublication({provider:githubProvider, read:() => state,
    save:change => { const next = structuredClone(state); change(next); next.version++; persist(next); state = next; },
    source:(task, run) => repositoryRunner.publicationSource(task, run)}) : null;

  function operationKey(taskId) { return state.tasks.find(task => task.id === taskId)?.projectId ?? taskId; }

  function requireIdleRepository(taskId) {
    if (repositoryOperations.has(operationKey(taskId))) throw new WorkflowError('repository_busy', 'A repository operation is in progress. Wait for its result.');
  }
  async function repositoryOperation(taskId, action) {
    requireIdleRepository(taskId);
    const key = operationKey(taskId);
    repositoryOperations.add(key);
    try { return await action(); } finally { repositoryOperations.delete(key); }
  }
  function requireAgentAdmission(task) {
    if (state.projects[task.projectId]?.codeConnected === false) throw new WorkflowError('project_code_unavailable', 'Restore this project’s retained code before admitting agent work.', 503);
    if (state.projects[task.projectId]?.acceptingWork === false) throw new WorkflowError('project_paused', 'New agent work is paused for this project. Existing submissions can still finish.');
  }

  function persist(snapshot = state) {
    const temporary = `${stateFile}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, stateFile);
  }
  function persistRepositories() {
    const temporary = `${metadataFile}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(repositories, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, metadataFile);
  }
  function persistIntents() {
    const temporary = `${intentsFile}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(mergeIntents, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, intentsFile);
  }
  function clearRecoveryErrors(runId) {
    for (let index = recoveryErrors.length - 1; index >= 0; index--) if (recoveryErrors[index].runId === runId) recoveryErrors.splice(index, 1);
  }
  for (const run of state.runs) {
    if (run.origin !== 'external-agent' && ['assigned', 'running'].includes(run.status)) {
      failRun(state, run.id, 'Local server stopped before the run completed. Retained Git files remain available for inspection.');
      if (run.execution?.status === 'running') run.execution.status = 'interrupted';
    }
  }
  persist();

  async function targetHead(task, repository) {
    return task.origin === 'connected-git' ? repositoryRunner.main(task) : (await readOnlyGit(repository)(['rev-parse', 'main'])).trim();
  }

  async function completeMerge(run, intent, mergedCommit) {
    const task = state.tasks.find(task => task.id === run.taskId);
    const repository = repositories[run.taskId];
    if (task.origin !== 'connected-git') await repositoryRunner.syncStarter(task, repository, mergedCommit);
    const updated = structuredClone(state);
    mergeRun(updated, run.id, { headCommit: intent.headCommit, baseCommit: intent.baseCommit, mergedCommit });
    if (task.projectId) updated.projects[task.projectId].mainCommit = mergedCommit;
    persist(updated);
    state = updated;
    delete mergeIntents[run.id];
    persistIntents();
    clearRecoveryErrors(run.id);
  }

  async function reconcileMerge(run, intent) {
    const task = state.tasks.find(task => task.id === run.taskId);
    const repository = repositories[run.taskId];
    if (!repository) throw new WorkflowError('repository_missing', 'Task repository is missing. Inspect local state.', 500);
    const head = await targetHead(task, repository);
    if (head === intent.headCommit) {
      await completeMerge(run, intent, head);
      return true;
    }
    if (head !== intent.baseCommit) throw new WorkflowError('merge_recovery_required', 'The target head differs from both the retained base and candidate. Inspect it before changing the locked merge intent.', 409);
    return false;
  }

  async function finishMerge(run, intent) {
    // Check the durable human decision before any external Git mutation.
    mergeRun(structuredClone(state), run.id, { headCommit: intent.headCommit, baseCommit: intent.baseCommit, mergedCommit: intent.headCommit });
    const repository = repositories[run.taskId];
    if (!repository) throw new WorkflowError('repository_missing', 'Task repository is missing. Inspect local state.', 500);
    const task = state.tasks.find(task => task.id === run.taskId);
    try {
      const retainFreshEvidence = async (evidence, changed) => {
        const failed = !evidence.verified || evidence.passed !== evidence.total || evidence.exitCode !== 0;
        const retained = mergeEvidence({ ...evidence, taskRevision: task.revision ?? 1 }, intent.attemptId);
        const updated = structuredClone(state);
        retainMergeEvidence(updated, run.id, retained, { requiresReview: failed || changed });
        persist(updated);
        state = updated;
        if (failed || changed) {
          delete mergeIntents[run.id];
          persistIntents();
          throw new WorkflowError(failed ? 'checks_failed' : 'verifier_changed', failed
            ? 'Fresh independent merge checks failed. The report is retained; inspect it before a new decision.'
            : 'The verification definition, code or runtime changed after acceptance. Fresh proof is retained; review it before merging.');
        }
      };
      const markWriteStarted = async () => {
        intent.writeStartedAt = new Date().toISOString();
        persistIntents();
      };
      let merged;
      if (task.origin === 'connected-git') {
        const checked = await repositoryRunner.verifyMerge(state, task, run);
        await retainFreshEvidence(checked.evidence, checked.changed);
        await markWriteStarted();
        merged = await repositoryRunner.merge(task, run);
      } else {
        merged = await runner.mergeCandidate({ repository, runId: run.id, headCommit: intent.headCommit, baseCommit: intent.baseCommit,
          retainEvidence: evidence => retainFreshEvidence(evidence, mergeEvidenceChanged(run.evidence,
            { ...evidence, taskRevision: task.revision ?? 1 }, task.verificationProfile ?? 'checkout')),
          beforeWrite: markWriteStarted });
      }
      await completeMerge(run, intent, merged.mergedCommit);
    } catch (error) {
      if (!intent.writeStartedAt && mergeIntents[run.id]?.attemptId === intent.attemptId) {
        delete mergeIntents[run.id];
        persistIntents();
      }
      throw error;
    }
  }
  const ready = (async () => {
    await runner.initialize();
    await repositoryRunner.initialize();
    // Upgrade retained starter projects once. Their historical scripted runs keep
    // the trusted fixture runner; subsequent tasks use the shared project code.
    for (const project of Object.values(state.projects)) {
      if (project.kind !== 'sample' || project.codeConnected) continue;
      const task = state.tasks.find(task => task.projectId === project.id);
      try {
        await repositoryRunner.connect({ ...task, baseCommit: project.mainCommit }, repositories[task.id]);
        if (!task.mergedCommit) for (const run of state.runs.filter(run => run.taskId === task.id && run.headCommit)) await repositoryRunner.capture(task, run, repositories[task.id], run.headCommit);
        project.codeConnected = true;
      } catch {
        project.codeConnected = false; project.acceptingWork = false;
        recoveryErrors.push({ projectId: project.id, message: 'Project code is unavailable. Its task and execution records are retained; restore the code before admitting work.' });
      }
      state.version++; persist();
    }
    for (const run of state.runs.filter(run => run.origin === 'external-agent' && run.status === 'assigned' && !run.repository)) {
      const task = state.tasks.find(task => task.id === run.taskId);
      const checkout = await repositoryRunner.recoverAssignment(task, run);
      if (checkout) { run.repository = checkout; run.checkoutState = 'ready'; state.version++; }
      else { run.checkoutState = 'failed'; failRun(state, run.id, 'Checkout preparation was interrupted. The claim is retained; use a new claim ID to retry this queued task.'); }
      persist();
    }
    for (const [runId, intent] of Object.entries(mergeIntents)) {
      try {
        const run = state.runs.find(item => item.id === runId);
        if (!run) throw new Error('Merge intent names an unknown run.');
        if (run.status === 'superseded' || run.status === 'merged' && run.headCommit === intent.headCommit) {
          delete mergeIntents[runId];
          persistIntents();
        } else if (!await reconcileMerge(run, intent)) {
          throw new WorkflowError('merge_recovery_required', 'The retained merge did not reach the target. Start a deliberate retry after inspecting the exact target head.', 409);
        }
      } catch (error) {
        recoveryErrors.push({ runId, message: error.message });
        console.error(JSON.stringify({ type: 'local.merge.recovery.refused', runId, message: error.message }));
      }
    }
  })();

  const snapshot = () => {
    const mergeStateByRun = localMergeStateByRun(mergeIntents, merging);
    const activeMergeIntents = Object.values(mergeStateByRun).filter(value => value === 'running').length;
    const recoveryRequiredMergeIntents = Object.values(mergeStateByRun).filter(value => value === 'recovery-required').length;
    return ({ ...state, metrics: metrics(state),
    coordination: workspaceCoordination(state),
    capacity: { limit: MAX_ACTIVE_RUNS, running: state.runs.filter(run => run.status === 'running').length, queued: state.runs.filter(run => run.status === 'assigned').length,
      reserved: state.runs.filter(run => run.status === 'assigned').length, occupied: state.runs.filter(run => ['assigned', 'running'].includes(run.status)).length },
    capabilities: { demo: true, model: Boolean(modelProvider && sandbox), repository: true, inspectRepository: true, merge: true, verify: true, revise: true, handoff: true, coordination: true, dependencies: true, providerVerified: false, publish: Boolean(publication) },
    githubPublication: publication ? {repository:publication.repository} : null,
    repositoryWorkflow: { cli: resolve(projectRoot, 'scripts/repository-work.mjs'), busyTaskIds: state.tasks.filter(task => repositoryOperations.has(task.projectId)).map(task => task.id), imports: [...repositoryImports.values()] },
    sampleTask,
    mergeStateByRun,
    recovery: { pendingMergeIntents: Object.keys(mergeIntents).length, activeMergeIntents, recoveryRequiredMergeIntents, errors: recoveryErrors },
    execution: { kind: modelProvider ? 'model-and-scripted-agents' : 'scripted-local-agents', label: modelProvider ? `${modelName} · sandboxed model edits available` : 'Scripted agents · local Git', inference: Boolean(modelProvider), model: modelName } });
  };

  async function execute(run, repository, limits) {
    startRun(state, run.id);
    persist();
    running.add(run.id);
    try {
      const result = await runner.runCandidate({ repository, runId: run.id, agent: run.agent, baseCommit: run.baseCommit,
        modelWork: run.agent === 'model' ? context => runEditingAgent({ ...context, limits, provider: modelProvider,
          instructions: 'Implement checkoutTotal(items) in safe integer cents. Each item must be an object with a nonnegative safe integer unitCents and a positive safe integer quantity. Reject invalid input, unsafe products and unsafe totals. Leave valid inputs unchanged. ' + run.label,
          save: async receipt => {
            const file = resolve(receiptsDir, `${run.id}.json`);
            writeFileSync(`${file}.tmp`, JSON.stringify({ model: modelName, ...receipt }, null, 2), { mode: 0o600 });
            renameSync(`${file}.tmp`, file);
            const { requests: attempts, ...summary } = receipt;
            state.runs.find(candidate => candidate.id === run.id).execution = { ...summary, model: modelName,
              requests: attempts.map(({ number, inputBytes, outputTokenLimit, status, usage }) => ({ number, inputBytes, outputTokenLimit, status, usage })) };
            state.version += 1;
            persist();
          },
        }) : undefined });
      await repositoryRunner.capture(state.tasks.find(task => task.id === run.taskId), run, repository, result.headCommit);
      state.runs.find(candidate => candidate.id === run.id).branch = result.branch;
      completeRun(state, run.id, result);
      verifyRun(state, run.id, result.evidence);
      persist();
    } catch (error) {
      failRun(state, run.id, error instanceof Error ? error.message.slice(0, 2000) : 'Runner failed.');
      persist();
    } finally { running.delete(run.id); }
  }

  async function startTask(input = null, requestKey = null) {
    const fingerprint = JSON.stringify(input);
    if (requestKey) {
      const prior = state.modelStarts?.[requestKey];
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new WorkflowError('idempotency_conflict', 'This request key already names a different allowance.');
        return prior.taskId;
      }
    }
    if (preparing || running.size) throw new WorkflowError('work_in_progress', 'Wait for current starter agents to finish. Other project tasks can still be queued.');
    let limits;
    if (input) {
      if (!modelProvider || !sandbox) throw new WorkflowError('model_not_configured', 'Configure a model provider and immutable sandbox image before starting model work.', 503);
      if (!Number.isInteger(input.candidates) || input.candidates < 1 || input.candidates > 4) throw new WorkflowError('invalid_candidates', 'Choose 1 to 4 independent candidates.', 422);
      try { limits = executionLimits(input.limits); }
      catch (error) { throw new WorkflowError('invalid_budget', error.message, 422); }
    }
    if (state.runs.filter(run => ['assigned', 'running'].includes(run.status)).length + (input?.candidates ?? 2) > MAX_ACTIVE_RUNS) throw new WorkflowError('capacity_full', 'Not enough free agent slots for this starter. Queue work in an existing project or wait for a slot.');
    preparing = true;
    try {
      if (input) await sandbox.ready(); // Refuse before creating a task or making a provider request.
      const repositoryKey = crypto.randomUUID();
      const repository = await runner.createDemoRepository(repositoryKey);
      const taskId = crypto.randomUUID();
      await repositoryRunner.connect({ id: taskId, projectId: taskId, baseCommit: repository.baseCommit }, repository.repository);
      if (state.runs.filter(run => ['assigned', 'running'].includes(run.status)).length + (input?.candidates ?? 2) > MAX_ACTIVE_RUNS) throw new WorkflowError('capacity_full', 'Agent slots filled while preparing the starter. No model request was sent.');
      const task = createTask(state, { ...sampleTask, id: taskId, repositoryKey, baseCommit: repository.baseCommit });
      task.repositoryName = 'checkout-starter'; task.resultBranch = 'main';
      task.projectId = task.id;
      state.projects[task.id] = { id: task.id, name: 'Checkout starter', repositoryName: 'checkout-starter', kind: 'sample', mainCommit: task.baseCommit, owner: task.owner, acceptingWork: true, policyVersion: 1 };
      state.projects[task.id].codeConnected = true; task.repositoryKey = task.id;
      repositories[task.id] = repository.repository;
      persistRepositories();
      const agents = input ? Array.from({ length: input.candidates }, (_, index) => ({ agent: 'model', label: `Model ${index + 1} · ${modelName}`, branch: `newwork/model-${index + 1}` })) : [
        { agent: 'careful', label: 'Delta · correctness first', branch: 'newwork/delta' },
        { agent: 'fast', label: 'Echo · minimal change', branch: 'newwork/echo' },
      ];
      const runs = agents.map(agent => assignRun(state, task.id, { ...agent, repository: repository.repository }));
      if (requestKey) {
        state.modelStarts ??= {};
        state.modelStarts[requestKey] = { taskId: task.id, fingerprint };
      }
      persist();
      const job = Promise.all(runs.map(run => execute(run, repository.repository, limits)));
      jobs.add(job);
      job.finally(() => jobs.delete(job)).catch(error => console.error(JSON.stringify({ type: 'local.persistence.failure', message: error.message })));
      return task.id;
    } finally { preparing = false; }
  }

  function claimResult(receipt, label) {
    if (receipt.label !== label) throw new WorkflowError('idempotency_conflict', 'This claim ID belongs to another agent label.');
    if (receipt.idle) return { ...receipt.idle, replayed: true };
    const run = state.runs.find(run => run.id === receipt.runId);
    if (run.checkoutState === 'failed') throw new WorkflowError('assignment_failed', 'Claim ' + run.id + ' failed during checkout preparation. Its record is retained. Use a new request ID to retry.');
    if (!run.repository) throw new WorkflowError('assignment_preparing', 'This same claim is still preparing its checkout. Retry its request ID.');
    return { taskId: run.taskId, runId: run.id, checkout: run.repository, branch: run.branch, baseCommit: run.baseCommit, replayed: true };
  }
  async function finishAssignment(task, run) {
    try {
      const checkout = await repositoryRunner.assign(task, run);
      const next = structuredClone(state), saved = next.runs.find(item => item.id === run.id);
      saved.repository = checkout.checkout; saved.checkoutState = 'ready'; next.version++;
      next.events.push({ id: crypto.randomUUID(), at: new Date().toISOString(), type: 'run.checkout_ready', taskId: task.id, runId: run.id, message: run.label + ': isolated checkout prepared. Waiting for the external agent to report its start.' });
      persist(next); state = next;
      return { taskId: task.id, runId: run.id, ...checkout };
    } catch (error) {
      const next = structuredClone(state), saved = next.runs.find(item => item.id === run.id);
      saved.checkoutState = 'failed'; failRun(next, run.id, 'Checkout could not be prepared. Retained files and the claim are available for inspection. Retry with a new request ID.'); persist(next); state = next;
      throw error;
    }
  }
  async function prepareExternal(taskId, label, claimKey) {
    return repositoryOperation(taskId, async () => {
      const task = state.tasks.find(task => task.id === taskId);
      requireAgentAdmission(task);
      if (state.runs.filter(run => ['assigned', 'running'].includes(run.status)).length >= MAX_ACTIVE_RUNS) throw new WorkflowError('capacity_full', 'All four agent slots are occupied. Queued tasks remain available.');
      const updated = structuredClone(state), currentTask = updated.tasks.find(task => task.id === taskId);
      bindQueuedBase(updated, currentTask);
      const run = assignRun(updated, taskId, { agent: 'external', label, branch: 'newwork/pending' });
      run.origin = 'external-agent'; run.branch = 'newwork/' + run.id; run.checkoutState = 'preparing';
      updated.agentClaims ??= {}; updated.agentClaims[claimKey] = { label, runId: run.id };
      persist(updated); state = updated;
      return finishAssignment(currentTask, run);
    });
  }

  async function handleRequest(request, response) {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try {
      await ready;
      const host = request.headers.host;
      if (!host || !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) {
        throw new WorkflowError('invalid_host', 'Local workbench accepts loopback hosts only.', 403);
      }
      const origin = `http://${host}`;
      const url = new URL(request.url, origin);
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        if (request.headers.origin && request.headers.origin !== origin) throw new WorkflowError('cross_origin', 'Cross-origin writes are not allowed.', 403);
        if (request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(request.headers['sec-fetch-site'])) {
          throw new WorkflowError('cross_origin', 'Use this workbench directly for writes.', 403);
        }
        if (!String(request.headers['content-type']).startsWith('application/json')) throw new WorkflowError('content_type', 'Send application/json.', 415);
      }
      if (url.pathname === '/api/health' && request.method === 'GET') return json(response, { ok: true, provider: 'local-git' });
      if (url.pathname === '/api/workspace' && request.method === 'GET') return json(response, projectWorkspace(snapshot(),parseWorkspacePage(url.search)));
      if (url.pathname === '/api/repositories/inspect' && request.method === 'POST') {
        const input = await bodyJson(request);
        if (typeof input.repo !== 'string' || input.repo.length > 1000 || !isAbsolute(input.repo) || /[\x00-\x1f]/.test(input.repo)) {
          throw new WorkflowError('invalid_repository_path', 'Enter an absolute local repository path.', 422);
        }
        try {
          const headCommit = validateCommit((await readOnlyGit(input.repo)(['rev-parse', '--verify', 'HEAD^{commit}'])).trim());
          return json(response, { headCommit, name: basename(resolve(input.repo)) });
        } catch {
          throw new WorkflowError('repository_inspection_failed', 'Could not read a committed HEAD from that repository. Check the path and make an initial commit if it is empty.', 422);
        }
      }
      if (url.pathname === '/api/projects/catalog' && request.method === 'GET') return json(response, projectCatalog(snapshot(),parseProjectCatalog(url.search)));
      const publishRoute = /^\/api\/runs\/([a-f0-9-]{36})\/publication\/(preview|publish|([a-f0-9-]{36})\/(refresh|resume))$/.exec(url.pathname);
      if (publishRoute && request.method === 'POST') {
        if (!publication) throw new WorkflowError('github_not_configured', 'Private GitHub publication is not configured on this local server.', 503);
        const input = await bodyJson(request);
        const {task} = publication.selected(publishRoute[1]);
        if (publishRoute[2] !== 'publish' && Object.keys(input).length) throw new WorkflowError('publication_input', 'This action takes no caller-supplied identity, destination or source fields.', 422);
        return await repositoryOperation(task.id, async () => {
          const result = publishRoute[2] === 'preview' ? await publication.preview(publishRoute[1])
            : publishRoute[2] === 'publish' ? await publication.publish(publishRoute[1], input)
            : publishRoute[4] === 'refresh' ? await publication.refresh(publishRoute[1], publishRoute[3])
            : await publication.continue(publishRoute[1], publishRoute[3]);
          return json(response, result);
        });
      }
      if (url.pathname === '/api/tasks' && request.method === 'POST') {
        const input = await bodyJson(request, 128 * 1024);
        if (input.source === 'sample') return json(response, { taskId: await startTask() }, 202);
        if (!['project', 'repository'].includes(input.source)) throw new WorkflowError('project_source_required', 'Choose an existing project or create one from committed code.', 422);
        if (!/^[a-f0-9-]{36}$/.test(input.requestId ?? '')) throw new WorkflowError('request_id_required', 'Supply a stable UUID requestId; reuse it only when retrying this request.', 422);
        if (state.cancelledTaskStarts?.[input.requestId]) throw new WorkflowError('request_cancelled', 'This task request was released. Use a new request ID.', 410);
        const briefs = taskBriefs(input);
        if (briefs.some(brief => !brief.owner)) throw new WorkflowError('owner_required', 'Name the person coordinating each task.', 422);
        const fingerprint = digest(JSON.stringify({ source: input.source, projectId: input.projectId, projectName: input.projectName, repo: input.repo, baseCommit: input.baseCommit, tasks: briefs }));
        const previous = state.taskStarts?.[input.requestId];
        if (previous) {
          if (previous.fingerprint !== fingerprint) throw new WorkflowError('idempotency_conflict', 'This request ID belongs to a different task stack.');
          return json(response, { ...previous.result, replayed: true }, 201);
        }
        if (input.source === 'project') {
          const project = state.projects[input.projectId];
          if (!project) throw new WorkflowError('project_not_found', 'Choose an existing project.', 404);
          if (project.codeConnected === false) throw new WorkflowError('project_code_unavailable', 'Restore project code before adding tasks.', 503);
          const repository = await repositoryRunner.directory(project.id);
          // Queueing needs no filesystem operation and can proceed while agents work.
          const updated = structuredClone(state);
          const tasks = queueProjectTasks(updated, updated.projects[project.id], briefs);
          // Clone after the path check, so asynchronous work cannot overwrite newer state.
          for (const task of tasks) repositories[task.id] = repository;
          const result = { projectId: project.id, taskId: tasks[0].id, taskIds: tasks.map(task => task.id), repository, baseCommit: updated.projects[project.id].mainCommit };
          updated.taskStarts ??= {}; updated.taskStarts[input.requestId] = { fingerprint, result };
          persistRepositories(); persist(updated); state = updated;
          return json(response, result, 201);
        }
        if (repositoryImports.get(input.requestId)?.status === 'running') throw new WorkflowError('import_in_progress', 'This import is still running. Follow its progress; no duplicate import was started.');
        const project = { id: crypto.randomUUID(), name: projectName(input.projectName), repositoryName: typeof input.repo === 'string' ? basename(input.repo) : '', kind: 'connected', mainCommit: input.baseCommit, owner: briefs[0].owner, acceptingWork: true, policyVersion: 1 };
        const previewTasks = queueProjectTasks(structuredClone(state), project, briefs, project.id);
        const startedAt = Date.now();
        const progress = value => repositoryImports.set(input.requestId, { requestId: input.requestId, status: 'running', startedAt, ...value });
        progress({ phase: 'Opening repository', completed: 0, total: null });
        let connected;
        try { connected = await repositoryRunner.connect(previewTasks[0], input.repo, progress); }
        catch (error) {
          repositoryImports.set(input.requestId, { requestId: input.requestId, status: 'failed', phase: 'Import refused', startedAt, elapsedMs: Date.now() - startedAt });
          // No task was published. An import refusal is editable, not an unknown start.
          throw new WorkflowError('repository_import_refused', error instanceof WorkflowError ? error.message : 'The selected commit could not be imported. Check the repository, supported file limits and local storage.', 422);
        }
        const updated = structuredClone(state);
        const tasks = queueProjectTasks(updated, project, briefs, project.id);
        updated.projects[project.id] = { ...project, sourceKey: connected.repositoryKey, codeConnected: true };
        const result = { projectId: project.id, taskId: tasks[0].id, taskIds: tasks.map(task => task.id), repository: connected.repository, baseCommit: project.mainCommit };
        updated.taskStarts ??= {}; updated.taskStarts[input.requestId] = { fingerprint, result };
        for (const task of tasks) repositories[task.id] = connected.repository;
        persistRepositories(); persist(updated); state = updated;
        repositoryImports.set(input.requestId, { requestId: input.requestId, status: 'complete', phase: 'Tasks queued', startedAt, elapsedMs: Date.now() - startedAt });
        for (const [key, value] of repositoryImports) if (repositoryImports.size > 20 && value.status !== 'running') repositoryImports.delete(key);
        return json(response, result, 201);
      }
      const release = /^\/api\/task-requests\/([a-f0-9-]{36})\/release$/.exec(url.pathname);
      if (release && request.method === 'POST') {
        await bodyJson(request);
        const prior = state.taskStarts?.[release[1]];
        if (prior) return json(response, { result: prior.result });
        if (repositoryImports.get(release[1])?.status === 'running') throw new WorkflowError('import_in_progress', 'This request is still importing. Wait for its result before editing.');
        state.cancelledTaskStarts ??= {}; state.cancelledTaskStarts[release[1]] = true; persist();
        return json(response, { released: true });
      }
      const projectPolicy = /^\/api\/projects\/([a-f0-9-]{36})\/policy$/.exec(url.pathname);
      if (projectPolicy && request.method === 'POST') {
        const input = await bodyJson(request), updated = structuredClone(state);
        setProjectPolicy(updated, projectPolicy[1], input);
        persist(updated); state = updated; return json(response, snapshot());
      }
      const claim = /^\/api\/projects\/([a-f0-9-]{36})\/claim$/.exec(url.pathname);
      if (claim && request.method === 'POST') {
        const input = await bodyJson(request), project = state.projects[claim[1]];
        if (!project) throw new WorkflowError('project_not_found', 'Project not found.', 404);
        if (typeof input.label !== 'string' || !input.label.trim() || input.label.length > 160) throw new WorkflowError('invalid_input', 'Agent label must be nonempty text of at most160 characters.', 422);
        if (!/^[a-f0-9-]{36}$/.test(input.requestId ?? '')) throw new WorkflowError('request_id_required', 'Supply a UUID for this claim; reuse it when retrying.', 422);
        const key = project.id + ':' + input.requestId, prior = state.agentClaims?.[key];
        if (prior) return json(response, claimResult(prior, input.label), 201);
        requireIdleRepository(project.id);
        requireAgentAdmission({ projectId: project.id });
        const task = eligibleQueuedTasks(state, project.id)[0];
        if (!task) {
          const result = queueIdle(state, project.id);
          state.agentClaims ??= {}; state.agentClaims[key] = { label: input.label, idle: result }; persist();
          return json(response, result);
        }
        const result = await prepareExternal(task.id, input.label, key);
        return json(response, result, 201);
      }
      const assignment = /^\/api\/tasks\/([a-f0-9-]{36})\/agents$/.exec(url.pathname);
      if (assignment && request.method === 'POST') {
        const input = await bodyJson(request);
        const task = state.tasks.find(task => task.id === assignment[1] && task.origin === 'connected-git');
        if (!task) throw new WorkflowError('repository_task_required', 'Select a project task with connected code.', 404);
        if (!/^[a-f0-9-]{36}$/.test(input.requestId ?? '')) throw new WorkflowError('request_id_required', 'Supply a UUID requestId for this assignment; reuse it on retry.', 422);
        const key = task.id + ':assignment:' + input.requestId;
        if (state.agentClaims?.[key]) return json(response, claimResult(state.agentClaims[key], input.label), 201);
        return json(response, await prepareExternal(task.id, input.label, key), 201);
      }
      const baseUpdate = /^\/api\/runs\/([a-f0-9-]{36})\/update-base$/.exec(url.pathname);
      if (baseUpdate && request.method === 'POST') {
        const input = await bodyJson(request), run = state.runs.find(run => run.id === baseUpdate[1]);
        const task = state.tasks.find(task => task.id === run?.taskId);
        if (!task?.projectId) throw new WorkflowError('repository_task_required', 'Select a project candidate.', 404);
        if (input.headCommit !== run.headCommit || input.taskRevision !== task.revision || !['reapply', 'resolve'].includes(input.mode)) throw new WorkflowError('stale_candidate', 'Refresh the candidate before updating its base.');
        return await repositoryOperation(task.id, async () => {
          const main = await repositoryRunner.main(task);
          const checkState = structuredClone(state);
          updateTaskBase(checkState, task.id, { expectedBaseCommit: task.baseCommit, baseCommit: main, sourceRunId: run.id });
          if (input.mode === 'resolve') requireAgentAdmission(task);
          const change = input.mode === 'reapply' ? await repositoryRunner.reapply(task, run, main) : null;
          const candidateId = crypto.randomUUID();
          const checksConfigured = change ? await repositoryRunner.retainCandidate(checkState.tasks.find(task => task.id === run.taskId), { id: candidateId, headCommit: change.headCommit }, run) : false;
          const updated = structuredClone(state);
          const current = updateTaskBase(updated, task.id, { expectedBaseCommit: task.baseCommit, baseCommit: main, sourceRunId: run.id });
          current.origin = 'connected-git';
          let next;
          if (change) {
            next = recordGitCandidate(updated, task.id, { ...change, id: candidateId, branch: 'refs/candidates/' + candidateId });
            next.origin = 'reconciled-git'; next.label = run.label + ' · updated base'; next.ownerVersion = current.ownerVersion;
            next.checksConfigured = checksConfigured;
          } else {
            if (updated.runs.filter(run => ['assigned', 'running'].includes(run.status)).length >= MAX_ACTIVE_RUNS) throw new WorkflowError('capacity_full', 'Wait for an agent slot before preparing a resolution checkout.');
            next = assignRun(updated, task.id, { agent: 'external', label: 'Resolve ' + run.label, branch: 'newwork/pending' });
            next.origin = 'external-agent'; next.branch = 'newwork/' + next.id; next.checkoutState = 'preparing';
          }
          next.reconcilesRunId = run.id;
          if (mergeIntents[run.id]) { updated.mergeAttemptHistory ??= []; updated.mergeAttemptHistory.push({ runId: run.id, ...mergeIntents[run.id], outcome: 'superseded-by-base-update' }); }
          persist(updated); state = updated;
          delete mergeIntents[run.id]; persistIntents();
          clearRecoveryErrors(run.id);
          if (!change) await finishAssignment(current, next);
          return json(response, { taskId: task.id, runId: next.id, mode: input.mode }, 201);
        });
      }
      const external = /^\/api\/runs\/([a-f0-9-]{36})\/(start|submit|fail|checks)$/.exec(url.pathname);
      if (external && request.method === 'POST') {
        const input = await bodyJson(request, external[2] === 'checks' ? 128 * 1024 : MAX_BODY);
        const run = state.runs.find(run => run.id === external[1] && run.origin === 'external-agent');
        if (!run) throw new WorkflowError('external_run_required', 'Select an assigned external-agent candidate.', 404);
        const task = state.tasks.find(task => task.id === run.taskId);
        return await repositoryOperation(task.id, async () => {
          if (external[2] === 'start' || external[2] === 'fail') {
            const updated = structuredClone(state);
            if (external[2] === 'start') {
              requireAgentAdmission(task);
              if (!run.repository) throw new WorkflowError('checkout_pending', 'Wait for the checkout to be prepared.');
              startRun(updated, run.id);
            } else failRun(updated, run.id, input.message);
            persist(updated); state = updated;
          } else if (external[2] === 'submit') {
            if (run.status !== 'running') throw new WorkflowError('invalid_transition', 'Report the agent start before submitting its commit.');
            const result = await repositoryRunner.submit(task, run, input.headCommit);
            const updated = structuredClone(state);
            completeRun(updated, run.id, { ...result, summary: input.summary });
            persist(updated); state = updated;
          } else {
            if (run.status !== 'awaiting_review') throw new WorkflowError('invalid_transition', 'Submit a candidate before configuring and running checks.');
            const evidence = await repositoryRunner.verify(state, task, run, input);
            const updated = structuredClone(state); verifyRun(updated, run.id, evidence); persist(updated); state = updated;
          }
          return json(response, snapshot());
        });
      }
      const handoff = /^\/api\/tasks\/([a-f0-9-]{36})\/handoff$/.exec(url.pathname);
      if (handoff && request.method === 'GET') return json(response, await buildTaskHandoff(state, handoff[1]));
      if (url.pathname === '/api/model-runs' && request.method === 'POST') {
        const requestKey = request.headers['idempotency-key'];
        if (requestKey !== undefined && (typeof requestKey !== 'string' || !/^[a-zA-Z0-9-]{16,128}$/.test(requestKey))) throw new WorkflowError('invalid_request_key', 'Use a 16 to 128 character request key.', 422);
        return json(response, { taskId: await startTask(await bodyJson(request), requestKey) }, 202);
      }
      const ownership = /^\/api\/tasks\/([a-f0-9-]{36})\/owner$/.exec(url.pathname);
      if (ownership && request.method === 'POST') {
        const input = await bodyJson(request);
        requireIdleRepository(ownership[1]);
        if (Object.keys(mergeIntents).some(id => state.runs.find(run => run.id === id)?.taskId === ownership[1])) throw new WorkflowError('merge_pending', 'Reconcile the pending merge before changing ownership.');
        const updated = structuredClone(state);
        setTaskOwner(updated, ownership[1], input);
        persist(updated); state = updated;
        return json(response, snapshot());
      }
      const revision = /^\/api\/tasks\/([a-f0-9-]{36})\/revise$/.exec(url.pathname);
      if (revision && request.method === 'POST') {
        const input = await bodyJson(request);
        requireIdleRepository(revision[1]);
        if (Object.keys(mergeIntents).some(id => state.runs.find(run => run.id === id)?.taskId === revision[1])) throw new WorkflowError('merge_pending', 'Reconcile the pending merge before changing requirements.');
        const updated = structuredClone(state);
        reviseTask(updated, revision[1], input);
        persist(updated); state = updated;
        return json(response, snapshot());
      }
      const action = /^\/api\/runs\/([a-f0-9-]{36})\/(review|merge|verify)$/.exec(url.pathname);
      if (action && request.method === 'POST') {
        const input = await bodyJson(request);
        const run = state.runs.find(item => item.id === action[1]);
        if (!run) throw new WorkflowError('run_not_found', 'Agent run not found.', 404);
        requireIdleRepository(run.taskId);
        if (action[2] === 'verify') {
          const task = state.tasks.find(item => item.id === run.taskId);
          const revision = task.revision ?? 1;
          if (input.headCommit !== run.headCommit || input.taskRevision !== revision || run.status !== 'awaiting_review') throw new WorkflowError('stale_verification', 'Recheck the current submitted commit and task revision.');
          const evidence = task.origin === 'connected-git'
            ? await repositoryOperation(task.id, () => repositoryRunner.verify(state, task, run))
            : await runner.verifyCandidate({ repository: repositories[run.taskId], runId: run.id, headCommit: run.headCommit });
          const updated = structuredClone(state);
          verifyRun(updated, run.id, { ...evidence, taskRevision: revision });
          persist(updated); state = updated;
        } else if (action[2] === 'review') {
          const updated = structuredClone(state);
          reviewRun(updated, run.id, input);
          persist(updated);
          state = updated;
        } else {
          if (merging.has(run.id)) throw new WorkflowError('merge_in_progress', 'Merge is already in progress.');
          if (run.status !== 'accepted') throw new WorkflowError('acceptance_required', 'Accept the candidate before merging.');
          if (input.headCommit !== run.headCommit) throw new WorkflowError('stale_merge', 'Review the current candidate commit before merging.');
          const repository = repositories[run.taskId];
          if (!repository) throw new WorkflowError('repository_missing', 'Task repository is missing. Inspect local state.', 500);
          const task = state.tasks.find(task => task.id === run.taskId);
          const retainedIntent = mergeIntents[run.id];
          if (retainedIntent && await reconcileMerge(run, retainedIntent)) return json(response, snapshot());
          if (await targetHead(task, repository) !== task.baseCommit) throw new WorkflowError('project_advanced', 'Project main advanced. Update the candidate base, recheck and review before merging.');
          clearRecoveryErrors(run.id);
          merging.add(run.id);
          try {
            mergeIntents[run.id] = { headCommit: run.headCommit, baseCommit: run.baseCommit, requestedAt: new Date().toISOString(), attemptId: crypto.randomUUID() };
            persistIntents();
            await repositoryOperation(run.taskId, () => finishMerge(run, mergeIntents[run.id]));
          } finally { merging.delete(run.id); }
        }
        return json(response, snapshot());
      }
      if (url.pathname.startsWith('/api/')) throw new WorkflowError('not_found', 'API endpoint not found.', 404);
      if (!['GET', 'HEAD'].includes(request.method)) throw new WorkflowError('method_not_allowed', 'Use GET for static assets.', 405);
      const filename = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!/^[a-zA-Z0-9._/-]+$/.test(filename) || filename.split('/').some(segment => segment === '..' || segment.startsWith('.'))) {
        throw new WorkflowError('not_found', 'Asset not found.', 404);
      }
      const path = resolve(publicDir, filename);
      const root = `${resolve(publicDir)}/`.replaceAll('\\', '/');
      if (!path.replaceAll('\\', '/').startsWith(root)) throw new WorkflowError('not_found', 'Asset not found.', 404);
      let content;
      try { content = readFileSync(path); }
      catch { throw new WorkflowError('not_found', 'Asset not found.', 404); }
      response.writeHead(200, { 'Content-Type': mediaTypes[extname(path)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (response.headersSent) return response.end();
      const expected = error instanceof WorkflowError || error instanceof ProjectCatalogError;
      if (!expected) console.error(JSON.stringify({ type: 'local.request.failure', message: error.message }));
      json(response, { error: { code: expected ? error.code : 'internal_error', message: expected ? error.message : 'Local operation failed. Inspect the terminal and retained files.' } }, expected ? error.status : 500);
    }
  }
  const server = http.createServer((request, response) => {
    const job = handleRequest(request, response);
    requests.add(job);
    job.finally(() => requests.delete(job)).catch(error => console.error(JSON.stringify({ type: 'local.request.drain.failure', message: error.message })));
  });
  async function waitForJobs() {
    await ready;
    while (jobs.size || requests.size) await Promise.allSettled([...jobs, ...requests]);
  }
  async function close() {
    if (server.listening) await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
    await waitForJobs();
    releaseLock();
  }
  return { server, snapshot, ready, waitForJobs, close };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 4178);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be an integer from 1024 to 65535.');
  const sandbox = process.env.PROJECTS_SANDBOX_IMAGE ? new DockerChecks({ image: process.env.PROJECTS_SANDBOX_IMAGE }) : null;
  const modelName = process.env.PROJECTS_MODEL;
  const configured = [process.env.PROJECTS_MODEL_ENDPOINT, process.env.PROJECTS_MODEL_API_KEY, modelName].some(Boolean);
  const modelProvider = configured ? chatProvider({ endpoint: process.env.PROJECTS_MODEL_ENDPOINT, apiKey: process.env.PROJECTS_MODEL_API_KEY, model: modelName }) : null;
  const githubProvider = process.env.PROJECTS_GITHUB_REPOSITORY ? new GitHubClient(process.env.PROJECTS_GITHUB_REPOSITORY) : null;
  const app = createApplication({ modelProvider, modelName, sandbox, githubProvider });
  await app.ready;
  app.server.on('error', error => { console.error(error.message); app.close().finally(() => { process.exitCode = 1; }); });
  app.server.listen(port, '127.0.0.1', () => console.log(`Projects Git: http://127.0.0.1:${port}\n${modelProvider ? 'Model execution configured; requests require an explicit budget.' : 'Trusted scripted demonstration.'} Repository data is retained in ${resolve(projectRoot, '.local')}`));
  const shutdown = () => { app.close().then(() => process.exit(0), error => { console.error(error.message); process.exit(1); }); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
