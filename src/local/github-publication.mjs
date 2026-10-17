import {createHash, randomUUID} from 'node:crypto';
import {WorkflowError} from '../core/workflow.mjs';
import {requirementsDigest} from '../core/check-definition.mjs';

const uuid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const refuse = (code, message, status = 409) => { throw new WorkflowError(code, message, status); };
const exact = (input, keys) => input && typeof input === 'object' && !Array.isArray(input)
  && Object.keys(input).sort().join(',') === [...keys].sort().join(',');

export function githubRepository(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,38}\/[a-z0-9][a-z0-9_.-]{0,99}$/i.test(value) || value.toLowerCase().endsWith('.git'))
    refuse('github_configuration', 'Configure a private GitHub repository as owner/name, without a URL or .git suffix.', 422);
  return value.toLowerCase();
}

export function githubBranch(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._/-]{0,179}$/i.test(value)
    || value.includes('..') || value.includes('//') || value.endsWith('/') || value.split('/').some(part => part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock')))
    refuse('github_branch', 'GitHub returned an unsupported branch name.', 422);
  return value;
}

/** One local owner workflow. Provider credentials never enter records or candidate checkouts. */
export class GitHubPublication {
  constructor({provider, read, save, source, now = () => Date.now()}) {
    this.provider = provider;
    this.repository = githubRepository(provider.repository);
    this.read = read; this.save = save; this.source = source; this.now = now;
  }

  selected(runId) {
    const state = this.read(), run = state.runs.find(item => item.id === runId), task = state.tasks.find(item => item.id === run?.taskId);
    if (!run || !task) refuse('run_not_found', 'Select a retained candidate in this workspace.', 404);
    return {state, task, run};
  }

  binding(runId) {
    const {state, task, run} = this.selected(runId), evidence = run.evidence;
    if (state.provider !== 'local-git' || task.origin !== 'connected-git' || run.status !== 'merged' || task.acceptedRunId !== run.id
      || task.mergedCommit !== run.headCommit || run.baseCommit !== task.baseCommit || !task.owner
      || run.review?.decision !== 'accept' || run.review.headCommit !== run.headCommit
      || run.review.taskRevision !== task.revision || run.review.ownerVersion !== task.ownerVersion
      || run.verificationPending || !evidence?.verified || evidence.commit !== run.headCommit || evidence.taskRevision !== task.revision
      || !['independent-local-checks', 'independent-sandbox-checks'].includes(evidence.source)
      || evidence.total < 1 || evidence.passed !== evidence.total || evidence.exitCode !== 0
      || evidence.checks?.length !== evidence.total || evidence.checks.some(check => !check.passed))
      refuse('publication_not_approved', 'Publish only a locally accepted and merged commit with its current passing evidence.');
    if (!sha(run.headCommit) || !sha(run.baseCommit)) refuse('github_object_format', 'GitHub publication requires SHA-1 commit IDs.', 422);
    return {workspaceId:state.id, taskId:task.id, runId:run.id, headCommit:run.headCommit, baseCommit:run.baseCommit,
      taskRevision:task.revision, ownerVersion:task.ownerVersion, requirementsSha256:requirementsDigest(task), reviewSha256:hash(run.review)};
  }

  assertBinding(runId, binding) {
    if (hash(this.binding(runId)) !== hash(binding.local)) refuse('publication_stale', 'The approved source or owner decision changed. Read a fresh publication preview.');
    if (binding.repository !== this.repository) refuse('github_configuration_changed', 'This publication belongs to a different configured repository.');
  }

  async verifyRepository(expectedId) {
    const repo = await this.provider.repositoryInfo();
    if (githubRepository(repo.full_name) !== this.repository || !Number.isSafeInteger(repo.id) || repo.id < 1
      || expectedId !== undefined && repo.id !== expectedId) refuse('github_repository_changed', 'The GitHub repository identity changed.');
    if (repo.private !== true) refuse('github_private_required', 'Publication is limited to private GitHub repositories.', 403);
    if (repo.archived || repo.disabled || repo.permissions?.push !== true) refuse('github_write_required', 'The configured GitHub account needs write access to this active private repository.', 403);
    return {...repo, default_branch:githubBranch(repo.default_branch)};
  }

  async upstream(binding) {
    const repo = await this.verifyRepository(binding.repositoryId);
    if (repo.default_branch !== binding.baseBranch || await this.provider.ref(binding.baseBranch) !== binding.local.baseCommit)
      refuse('github_base_changed', 'GitHub main has advanced or changed. Update the project and obtain a new approved candidate before publishing.');
  }

  publicationContent(task, run) {
    return {title:task.title, body:`${task.purpose}\n\nRequirements:\n${task.criteria.map(value => '- ' + value).join('\n')}\n\nLocally accepted and merged commit: ${run.headCommit}\nRequirements revision: ${task.revision}\n\nGitHub review, merge and deployment remain separate actions.`};
  }

  async preview(runId) {
    const {run, task, state} = this.selected(runId);
    if (run.publication) refuse('publication_exists', 'This candidate already has a publication record. Refresh or resume that record.');
    const local = this.binding(runId);
    await this.source(task, run);
    const repo = await this.verifyRepository(), baseBranch = repo.default_branch;
    if (await this.provider.ref(baseBranch) !== local.baseCommit) refuse('github_base_changed', 'The task base is not current GitHub main. Update the project and obtain a new approved candidate.');
    const headBranch = githubBranch(`newwork/projects-${state.id}-${run.id}`);
    if (await this.provider.ref(headBranch) !== null) refuse('github_branch_exists', 'The dedicated publication branch already exists without this publication receipt. Inspect it before proceeding.');
    const binding = {local, repository:this.repository, repositoryId:repo.id, baseBranch, headBranch};
    this.assertBinding(runId, binding);
    const preview = {id:randomUUID(), binding, createdAt:new Date(this.now()).toISOString(), expiresAt:new Date(this.now() + 5 * 60_000).toISOString(),
      ...this.publicationContent(task, run)};
    this.save(next => { next.runs.find(item => item.id === runId).publicationPreview = preview; });
    return structuredClone(preview);
  }

  record(runId, id) {
    const record = this.selected(runId).run.publication;
    if (!uuid(id) || !record || record.id !== id) refuse('publication_not_found', 'Read this candidate’s publication record first.', 404);
    return record;
  }

  update(runId, id, fields, message) {
    const record = this.record(runId, id);
    if (record.observations.length >= 100) refuse('publication_history_full', 'The publication retains 100 observations. Inspect its preserved history before further action.');
    const at = new Date(this.now()).toISOString();
    this.save(next => {
      const run = next.runs.find(item => item.id === runId), saved = run.publication;
      Object.assign(saved, fields, {lastCheckedAt:at});
      saved.observations.push({at, status:saved.status, stage:saved.stage, message, ...(saved.pr ? {pr:structuredClone(saved.pr)} : {})});
      next.events.push({id:randomUUID(), at, type:'run.publication', taskId:run.taskId, runId, message});
    });
    return structuredClone(this.record(runId, id));
  }

  failure(runId, id, error) {
    return this.update(runId, id, {status:'needs_attention', error: error instanceof WorkflowError ? {code:error.code, message:error.message}
      : {code:'github_outcome_unknown', message:'GitHub did not confirm the outcome. Refresh remote status; no write was retried.'}}, 'Publication needs attention. Its operation and prior observations are retained.');
  }

  normalizedPR(raw, record) {
    const b = record.binding;
    if (!Number.isSafeInteger(raw?.number) || raw.number < 1 || record.pr && raw.number !== record.pr.number
      || raw.html_url?.toLowerCase() !== `https://github.com/${b.repository}/pull/${raw.number}`
      || !sha(raw.head?.sha) || !['open', 'closed'].includes(raw.state) || typeof raw.merged !== 'boolean') refuse('github_pr_invalid', 'GitHub returned an invalid pull request identity.');
    const changed = raw.base?.repo?.id !== b.repositoryId || raw.head?.repo?.id !== b.repositoryId
      || raw.base?.ref !== b.baseBranch || raw.head?.ref !== b.headBranch || raw.head.sha !== b.local.headCommit;
    if (raw.merged && (raw.state !== 'closed' || !sha(raw.merge_commit_sha) || typeof raw.merged_at !== 'string' || !Number.isFinite(Date.parse(raw.merged_at)))) refuse('github_pr_invalid', 'GitHub did not return a complete merge observation.');
    return {number:raw.number, url:`https://github.com/${b.repository}/pull/${raw.number}`, headCommit:raw.head.sha,
      status:changed ? 'changed' : raw.merged ? 'merged' : raw.state, mergedAt:raw.merged ? raw.merged_at : null, mergeCommit:raw.merged ? raw.merge_commit_sha : null};
  }

  async observe(runId, id) {
    const record = this.record(runId, id), b = record.binding;
    if (b.repository !== this.repository) refuse('github_configuration_changed', 'Restore the publication’s configured repository before refreshing it.');
    await this.verifyRepository(b.repositoryId);
    const raw = record.pr ? await this.provider.pullRequest(record.pr.number) : await this.provider.findPullRequest(b.headBranch);
    if (raw) {
      const pr = this.normalizedPR(raw, record);
      return this.update(runId, id, {pr, status:pr.status, stage:'pr', error:pr.status === 'changed'
        ? {code:'github_source_changed', message:'The PR head or destination changed. This is not the approved publication.'} : null}, `GitHub PR #${pr.number}: ${pr.status}. Source approval and merge remain separate records.`);
    }
    const branchHead = await this.provider.ref(b.headBranch);
    const changed = branchHead && branchHead !== b.local.headCommit;
    const uncertain = record.prStartedAt || record.pushStartedAt && !branchHead;
    const error = changed ? {code:'github_source_changed', message:'The dedicated branch no longer points to the approved commit.'}
      : uncertain ? {code:'github_outcome_unknown', message:'A remote write was attempted but is not confirmed. No write will be repeated; refresh or inspect GitHub.'} : null;
    return this.update(runId, id, {branchHead, status:changed ? 'changed' : uncertain ? 'needs_attention' : 'pending',
      stage:branchHead === b.local.headCommit ? 'branch' : record.stage, error}, branchHead ? 'Observed the publication branch on GitHub.' : 'No publication branch or PR was observed; this does not prove that an uncertain write stopped.');
  }

  async publish(runId, input) {
    if (!exact(input, ['previewId', 'requestId']) || !uuid(input.previewId) || !uuid(input.requestId)) refuse('publication_input', 'Send only the preview ID and a stable request ID.', 422);
    const prior = this.read().runs.find(run => run.publication?.id === input.requestId);
    if (prior) {
      if (prior.id !== runId || prior.publication.previewId !== input.previewId) refuse('idempotency_conflict', 'This request ID belongs to a different publication.');
      return structuredClone(prior.publication);
    }
    const {run} = this.selected(runId), preview = run.publicationPreview;
    if (run.publication) refuse('publication_exists', 'This candidate already has a publication. Refresh or resume it.');
    if (!preview || preview.id !== input.previewId || !Number.isFinite(Date.parse(preview.expiresAt)) || Date.parse(preview.expiresAt) <= this.now()) refuse('publication_preview_expired', 'Read a fresh publication preview before publishing.');
    this.assertBinding(runId, preview.binding);
    const record = {id:input.requestId, previewId:preview.id, binding:preview.binding, title:preview.title, body:preview.body,
      createdAt:new Date(this.now()).toISOString(), status:'pending', stage:'reserved', pushStartedAt:null, prStartedAt:null,
      branchHead:null, pr:null, error:null, observations:[]};
    this.save(next => { const saved = next.runs.find(item => item.id === runId); saved.publication = record; delete saved.publicationPreview; });
    return this.continue(runId, record.id);
  }

  async refresh(runId, id) {
    this.record(runId, id);
    try { return await this.observe(runId, id); } catch (error) { return this.failure(runId, id, error); }
  }

  /** Explicit continuation, never an automatic retry of an attempted remote write. */
  async continue(runId, id) {
    this.record(runId, id);
    try {
      let record = await this.observe(runId, id);
      if (record.pr || record.status === 'changed') return record;
      this.assertBinding(runId, record.binding);
      await this.upstream(record.binding);
      const {task, run} = this.selected(runId), repository = await this.source(task, run);
      if (!record.branchHead) {
        if (record.pushStartedAt) refuse('github_push_uncertain', 'A branch push was already attempted. Its absence is not proof of failure; no second push will be sent. Refresh or inspect GitHub.');
        this.assertBinding(runId, record.binding);
        record = this.update(runId, id, {stage:'push', pushStartedAt:new Date(this.now()).toISOString()}, 'Reserved one creation-only branch push before provider I/O.');
        await this.provider.pushBranch(repository, record.binding);
        record = await this.observe(runId, id);
        if (record.pr || record.status === 'changed') return record;
        if (record.branchHead !== record.binding.local.headCommit) refuse('github_push_uncertain', 'GitHub has not confirmed the exact branch head. Refresh before continuing.');
      }
      if (record.prStartedAt) refuse('github_pr_uncertain', 'PR creation was already attempted. No second request will be sent; refresh or inspect GitHub.');
      this.assertBinding(runId, record.binding);
      await this.upstream(record.binding);
      this.assertBinding(runId, record.binding);
      record = this.update(runId, id, {stage:'create_pr', prStartedAt:new Date(this.now()).toISOString()}, 'Reserved one PR creation before provider I/O.');
      await this.provider.createPullRequest(record);
      record = await this.observe(runId, id);
      if (!record.pr) refuse('github_pr_uncertain', 'GitHub has not confirmed the created PR. Refresh its status; no duplicate will be created.');
      return record;
    } catch (error) { return this.failure(runId, id, error); }
  }
}
