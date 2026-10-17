import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { AccessVerifier, accessPolicy, assertAuthority, authorizeRoute, systemAuthority, ownerBinding } from './access.ts';
import type { AccessPolicy, AccessPrincipal, HostedAuthority,HumanAccessIdentity } from './access.ts';
import {currentPolicy} from './current-policy.ts';
import { publicEntrance } from '../entrance/handler.mjs';
import { privateWorkbench } from './workbench-assets.mjs';
const accessVerifier = new AccessVerifier();
import { HostedController } from "./controller.ts";
import { WorkspaceStore } from './workspace-store.ts';
import { parseWorkspacePage, projectMutationResult } from '../../public/workspace-page.js';
import {parseProjectCatalog} from '../../public/project-catalog.js';
import {WORKSPACE_BACKUP_REQUEST_BYTES} from '../../public/workspace-backup-limits.js';
import {ArtifactEventReceipts,artifactEventPolicy,parseArtifactPush,parseArtifactPushEnvelope,reconcileArtifactPush} from './artifact-events.ts';
import type {ArtifactEventSource} from './artifact-events.ts';
import {ArtifactSubscriptions,subscriptionPlan,subscriptionDigest} from './artifact-subscriptions.ts';
import type {SubscriptionPlan,RegisteredSubscription,SubscriptionProvider} from './artifact-subscriptions.ts';
import type {ArtifactSubscriptionService} from './subscription-service.ts';
import { RetainedIndex, projectDocuments } from './search-index.ts';
import { SemanticSearch, EMBEDDING_MODEL, removeIndexedVectors } from './semantic-search.ts';
import { ApiError, bodyJson, errorResponse, idempotencyKey, json, requireSameOrigin } from "./security.ts";
import { ArtifactGit } from './git-transport.mjs';
import { WorkerChecks } from './sandbox.ts';
import { chatProvider } from '../core/agent.mjs';
import {isTrial,coordinatorWorkspaceId,trialRegistry,assertTrialRoute,assertNoTrialBackground,configuredTrialPolicy,trialWorkflowEnabled} from './trial-scope.ts';
import {scopedTrialArtifacts} from './trial-artifacts.ts';
import {TrialSourcePublication} from './trial-source-publication.ts';
import {trialWorkflowUsage,TRIAL_WORKFLOW_LIMITS} from './trial-workflow.ts';
import {assertTrialActive,trialAccessPolicy,trialStatus,trialGrant,trialCleanupDue} from './trial-admission.ts';
import {readArtifactSnapshot} from './artifacts.ts';
import {buildWorkspaceBackup} from '../core/workspace-backup.mjs';
import type {TrialGrant,TrialPolicy} from './trial-admission.ts';
import {cleanupTrialResources,purgeTrialWorkspace,retainedTrialCleanup} from './trial-cleanup.ts';
import type {TrialCleanupResult} from './trial-cleanup.ts';
import type { ModelProvider } from '../core/agent.mjs';
export { RepositoryCheckContainer } from './check-container.ts';

interface ApiCall {
  principal: AccessPrincipal;
  policy: AccessPolicy;
  forbiddenSecrets: string[];
  method: string;
  path: string;
  body: Record<string, unknown>;
  key: string;
  search?: string;
  trialPolicy?:TrialPolicy;
}

// Named RPC entrypoint only; the public HTTP handler never exposes this method.
// A service invocation gets a new WorkerEntrypoint with current Worker bindings.
export class WorkspacePolicy extends WorkerEntrypoint<Env> {
  readPolicy(workspaceId: string, nonce: string) {
    const policy = accessPolicy(this.env);
    if (workspaceId !== policy.workspaceId || typeof nonce !== 'string' || !/^[a-f0-9-]{36}$/.test(nonce))
      throw new ApiError(403, 'WORKSPACE_FORBIDDEN', 'Policy requests must target the configured workspace.');
    return {nonce, policy};
  }
}

export class WorkspaceCoordinator extends DurableObject<Env> {
  private store: WorkspaceStore;
  private artifactReceipts: ArtifactEventReceipts;
  private subscriptions: ArtifactSubscriptions;
  private artifactWork = new Map<string, Promise<Record<string,unknown>>>();
  // Serialize index publication and cleanup for a project across await points.
  // The outbox, embedding reservations and generation rows remain the durable
  // recovery source; this chain only coordinates calls in this DO instance.
  private indexWork = new Map<string, Promise<void>>();
  private checkoutExecutions = new Map<string, { abort: AbortController; finished: Promise<unknown> }>();
  private activeCalls=0;
  private trialCleanupRunning=false;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new WorkspaceStore(ctx.storage, coordinatorWorkspaceId(ctx,env));
    this.artifactReceipts = new ArtifactEventReceipts(ctx.storage);
    this.subscriptions = new ArtifactSubscriptions(ctx.storage);
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS attempts (run_id TEXT PRIMARY KEY, receipt TEXT NOT NULL)');
  }

  protected artifacts(): Artifacts { return isTrial(this.env)?this.env.TRIAL_ARTIFACTS!:this.env.ARTIFACTS; }
  protected artifactEventSource():ArtifactEventSource {return this.artifacts();}

  private subscriptionScope(){
    const policy=artifactEventPolicy(this.env);
    return {accountId:policy.accountId,namespace:policy.namespace,queueId:this.env.ARTIFACTS_EVENTS_QUEUE_ID,
      workspaceId:policy.workspaceId,ownerKey:subscriptionDigest(ownerBinding(accessPolicy(this.env)))};
  }
  private validateSubscriptionOwner(repositoryName:string){
    const snapshot=this.store.read(),binding=ownerBinding(accessPolicy(this.env));
    if(snapshot.workspace.id!==this.env.WORKSPACE_ID||!snapshot.workspace.authentication
      ||(['provider','issuer','audience','subject','workspaceId'] as const).some(key=>snapshot.workspace.authentication![key]!==binding[key]))
      throw new ApiError(403,'ARTIFACT_WORKSPACE_FORBIDDEN','Registration requires the adopted workspace owner.');
    const owned=Object.values(snapshot.workspace.projects??{}).some(project=>project.repositoryName===repositoryName)
      ||Object.values(snapshot.forks).some(fork=>fork.name===repositoryName)
      ||Object.values(snapshot.operations).some(op=>op.state==='pending'&&['assign','claim','base-update'].includes(op.kind)
        &&op.resourceName===repositoryName&&op.projectId&&snapshot.workspace.projects?.[op.projectId]);
    if(!owned)throw new ApiError(403,'SUBSCRIPTION_REPOSITORY_FORBIDDEN','Registration requires a retained project or reserved owned fork.');
  }
  private async ensureSubscription(repositoryName:string,validateCaller:()=>void){
    if(String(this.env.ARTIFACTS_EVENTS_AUTOMATIC)!=='true')return;
    const validate=()=>{validateCaller();this.validateSubscriptionOwner(repositoryName);};
    validate();
    // Operator-pinned subscriptions are already admitted by the consumer. Do not
    // create a second subscription when upgrading an existing working workspace.
    if(artifactEventPolicy(this.env).subscriptions.some(s=>s.repositoryName===repositoryName))return;
    const plan=subscriptionPlan({...this.subscriptionScope(),repositoryName});
    await this.subscriptions.ensure(plan,this.subscriptionProvider(),validate);
  }
  protected subscriptionProvider():SubscriptionProvider{
    // Wrangler cannot infer the separately deployed entrypoint from this config.
    const service=this.env.EVENT_SUBSCRIPTIONS as Service<ArtifactSubscriptionService>;
    if(!service)throw new ApiError(503,'SUBSCRIPTIONS_NOT_CONFIGURED','Bind the private subscription registration service.');
    const step=async(action:'find'|'create'|'enable',value:SubscriptionPlan,id?:string)=>{
      const reply=await service.registerStep(action,value,id);
      if(!reply.ok)throw new ApiError(502,reply.code,'Event registration needs attention. Retry the original request to reconcile its retained attempt.');
      return reply.result;
    };
    return {
      find:async value=>await step('find',value) as RegisteredSubscription[],
      create:async value=>await step('create',value) as RegisteredSubscription,
      enable:async(value,id)=>await step('enable',value,id) as RegisteredSubscription,
    };
  }

  async artifactPush(body:unknown,messageId:string):Promise<Record<string,unknown>> {
    assertNoTrialBackground(this.env);
    const policy=artifactEventPolicy(this.env);
    if(policy.automatic){
      const managed=this.subscriptions.bindings(this.subscriptionScope());
      for(const entry of managed){
        if(policy.subscriptions.some(s=>s.id===entry.id&&s.repositoryName!==entry.repositoryName))throw new ApiError(503,'SUBSCRIPTION_CONFIG_CHANGED','A subscription ID has conflicting repository bindings.');
        if(!policy.subscriptions.some(s=>s.id===entry.id))policy.subscriptions.push(entry);
      }
    }
    const event=parseArtifactPush(body,policy);
    const validateOwner=()=>{
      const snapshot=this.store.read(),binding=ownerBinding(accessPolicy(this.env));
      if(snapshot.workspace.id!==policy.workspaceId||!snapshot.workspace.authentication
        ||(['provider','issuer','audience','subject','workspaceId'] as const).some(key=>snapshot.workspace.authentication![key]!==binding[key]))
        throw new ApiError(403,'ARTIFACT_WORKSPACE_FORBIDDEN','Events require the configured, adopted workspace owner.');
    };
    validateOwner();
    // This serializes read-only ref reconciliation in the active instance;
    // durable attempts and generation checks fence late callbacks after restart.
    const previous=this.artifactWork.get(event.repositoryName)??Promise.resolve({});
    const work=previous.catch(()=>({})).then(()=>reconcileArtifactPush(this.store,this.artifactReceipts,this.artifactEventSource(),event,messageId,policy.workspaceId,validateOwner));
    this.artifactWork.set(event.repositoryName,work);
    try {return await work;}
    finally {if(this.artifactWork.get(event.repositoryName)===work)this.artifactWork.delete(event.repositoryName);}
  }
  protected gitTransport(): ArtifactGit { return new ArtifactGit(); }
  protected modelProvider(): ModelProvider | undefined {
    return this.env.MODEL_API_KEY && this.env.MODEL ? chatProvider({ endpoint: this.env.MODEL_ENDPOINT, apiKey: this.env.MODEL_API_KEY, model: this.env.MODEL }) : undefined;
  }

  private controller(authority: HostedAuthority,trial?:TrialGrant,sampleSetup=false): HostedController {
    const provider = this.modelProvider();
    const workflow=Boolean(trial&&trialWorkflowEnabled(this.env));
    let trialFailure:unknown;
    const validateTrial=async()=>{
      try {
        if(this.trialCleanupRunning||retainedTrialCleanup(this.ctx.storage))throw new ApiError(403,'TRIAL_CLOSED','Trial cleanup fences new work.');
        if(authority.principal.kind==='system')throw new ApiError(403,'TRIAL_SAMPLE_FORBIDDEN','Trial work requires a current identity.');
        assertTrialActive(trial!);
        const fresh=trialGrant(await trialRegistry(this.env).authorize(trial!.workspaceId,authority.principal,configuredTrialPolicy(this.env)));
        if(JSON.stringify(trialAccessPolicy(fresh,workflow))!==JSON.stringify(authority.policy)||fresh.policyRevision!==trial!.policyRevision
          ||fresh.createdAt!==trial!.createdAt||fresh.expiresAt!==trial!.expiresAt)
          throw new ApiError(403,'TRIAL_SAMPLE_FORBIDDEN','Sample setup no longer matches its authenticated trial.');
        assertTrialActive(fresh);Object.assign(trial!,fresh);
      }catch(error){trialFailure=error;throw error;}
    };
    const reserve=async(kind:'setup'|'read'|'create'|'issue'|'push'|'fork'|'check')=>{
      const principal=authority.principal;if(principal.kind==='system')throw new ApiError(403,'TRIAL_SAMPLE_FORBIDDEN','Trial resources require a current identity.');
      trialGrant(await trialRegistry(this.env).reserveResource(trial!.workspaceId,principal,configuredTrialPolicy(this.env),kind));
    };
    const artifacts=workflow&&!sampleSetup?scopedTrialArtifacts(this.artifacts(),()=>this.store.read(),reserve,validateTrial):this.artifacts();
    return new HostedController(this.store, artifacts, authority, {
      guard:trial?()=>{if(trialFailure)throw trialFailure;assertTrialActive(trial);}:undefined,
      trial:trial?{workspaceId:trial.workspaceId,workflow,validate:validateTrial,reserve,
        allowance:async()=>{
          const principal=authority.principal;if(principal.kind!=='owner')throw new ApiError(403,'TRIAL_SAMPLE_FORBIDDEN','Trial allowance requires the owner.');
          const reply=await trialRegistry(this.env).controls({issuer:principal.issuer,audience:authority.policy.audience,
            subject:principal.id,displayName:principal.displayName,issuedAt:principal.issuedAt,expiresAt:principal.expiresAt},configuredTrialPolicy(this.env));
          const fresh=trialGrant(reply);if(fresh.workspaceId!==trial!.workspaceId||!reply.allowance)throw new ApiError(503,'TRIAL_UNAVAILABLE','Trial allowance is unavailable.');
          assertTrialActive(fresh);Object.assign(trial!,fresh);return reply.allowance;
        }}:undefined,
      currentPolicy: () => currentPolicy(this.env.CURRENT_POLICY, this.env.WORKSPACE_ID),
      ensureSubscription:(repository,validate)=>this.ensureSubscription(repository,validate),
      checks: { verify: async(source, commit, signal, attemptId) => {if(trial)await reserve('check');return this.verifyCheckout(source, commit, signal, attemptId);} }, git: this.gitTransport(), provider,
      repositoryChecks: { observe: (attemptId, index, files, argv, input, timeoutMs) => {
        this.requireExecutor(attemptId);
        return this.env.REPOSITORY_CHECKS.getByName(attemptId + ':' + index).observe(files, argv, input, timeoutMs);
      } },
      cancelVerification: async (attemptId, profile, count) => {
        if (profile === 'commands') {
          await Promise.all(Array.from({length: count}, (_, index) => this.env.REPOSITORY_CHECKS.getByName(attemptId + ':' + index).stop()));
        } else {
          const execution = this.checkoutExecutions.get(attemptId);
          if (execution) { execution.abort.abort(new Error('Verification recovery')); await execution.finished.catch(() => {}); }
        }
      },
      modelName: this.env.MODEL || undefined, repository: this.env.MODEL_REPOSITORY,
      saveReceipt: async (runId, receipt) => {
        const value = JSON.stringify(receipt);
        if (new TextEncoder().encode(value).byteLength > 1900000) throw new ApiError(413, 'RECEIPT_LIMIT', 'Execution receipt exceeded its retained size allowance.');
        if ([...(authority.forbiddenSecrets ?? []), this.env.MODEL_API_KEY].some(secret => secret && value.includes(secret))) throw new ApiError(400, 'SECRET_IN_RECEIPT', 'Credentials cannot be saved in execution receipts.');
        this.ctx.storage.sql.exec('INSERT INTO attempts (run_id, receipt) VALUES (?, ?) ON CONFLICT(run_id) DO UPDATE SET receipt = excluded.receipt', runId, value);
      },
    });
  }

  private requireExecutor(attemptId?: string): void {
    const snapshot = this.store.read();
    if (!attemptId || !(Object.values(snapshot.operations).some(operation => operation.state === 'pending' && operation.attemptId === attemptId && !operation.executorAttemptId)
      || snapshot.jobs?.[attemptId]?.status === 'running')) throw new ApiError(409, 'STALE_OPERATION', 'The executor no longer owns this attempt.');
  }

  protected async verifyCheckout(source: string, commit: string, signal?: AbortSignal, attemptId?: string) {
    this.requireExecutor(attemptId);
    const abort = new AbortController(), key = attemptId!;
    const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
    const finished = new WorkerChecks(isTrial(this.env)?this.env.TRIAL_LOADER!:this.env.LOADER).verify(source, commit, combined);
    const execution = {abort, finished}; this.checkoutExecutions.set(key, execution);
    try { return await finished; }
    finally { if (this.checkoutExecutions.get(key) === execution) this.checkoutExecutions.delete(key); }
  }

  private semantic(): SemanticSearch | null {
    if (String(this.env.SEARCH_EMBEDDINGS_ENABLED) !== 'true') return null;
    if (!this.env.SEARCH_AI || !this.env.SEARCH_VECTORS) throw new ApiError(503, 'SEMANTIC_NOT_CONFIGURED', 'Configure embedding and Vectorize bindings before enabling semantic search.');
    return new SemanticSearch(this.ctx.storage, this.env.SEARCH_VECTORS, text => this.env.SEARCH_AI.run(EMBEDDING_MODEL, { text: [text], pooling: 'mean' }), Number(this.env.SEARCH_EMBEDDING_DAILY_LIMIT));
  }

  async alarm(): Promise<void> {
    if(isTrial(this.env))return;
    const controller = this.controller(systemAuthority(accessPolicy(this.env)));
    await controller.drainJobs();
    try { await controller.drainAutomaticMerges(); }
    finally { await this.deliverIndexJobs(); }
    await this.schedule(controller);
  }

  private async schedule(controller: HostedController): Promise<void> {
    if(isTrial(this.env))return;
    const indexDue = this.env.SEARCH_JOBS && this.env.SEARCH_DB ? this.store.nextIndexAttempt() : null;
    const due = this.store.hasSchedulingCandidates() && (controller.hasQueuedWork() || controller.hasAutomaticMergeWork()) ? Date.now() + 100 : indexDue === null ? null : Math.max(Date.now() + 100, indexDue);
    if (due !== null) {
      const existing = await this.ctx.storage.getAlarm();
      if (existing === null || existing > due) await this.ctx.storage.setAlarm(due);
    }
  }

  private async deliverIndexJobs(): Promise<void> {
    if (!this.env.SEARCH_JOBS || !this.env.SEARCH_DB) return;
    for (const item of this.store.pendingIndex()) {
      try {
        await this.env.SEARCH_JOBS.send({ workspaceId: this.env.WORKSPACE_ID, projectId: item.project_id, revision: item.revision });
        this.store.delivered(item.project_id, item.revision);
      } catch { this.store.indexFailure(item.project_id, item.revision, 'QUEUE_DELIVERY_FAILED'); }
    }
  }

  async indexProject(projectId: string, requestedRevision: number, terminal: boolean): Promise<void> {
    assertNoTrialBackground(this.env);
    const previous = this.indexWork.get(projectId) ?? Promise.resolve();
    const work = previous.catch(() => {}).then(() => this.performIndexProject(projectId, requestedRevision, terminal));
    this.indexWork.set(projectId, work);
    try { await work; }
    finally { if (this.indexWork.get(projectId) === work) this.indexWork.delete(projectId); }
  }

  private async performIndexProject(projectId: string, requestedRevision: number, terminal: boolean): Promise<void> {
    const state = this.store.indexState(projectId);
    if(state?.automatic===0)return;
    if (!state || requestedRevision > state.revision) throw new ApiError(409, 'INDEX_REVISION_CONFLICT', 'Search job does not match retained indexing intent.');
    // A stale delivery has no authority to spend a newer intent's retry budget.
    // Its replacement is already retained in the outbox and scheduled separately.
    if (requestedRevision < state.revision) return;
    if (state.indexed_revision >= requestedRevision) { await this.cleanupIndex(projectId); return; }
    const snapshot = this.store.read();
    try {
      if (!this.env.SEARCH_DB) throw new ApiError(503, 'SEARCH_NOT_CONFIGURED', 'Configure the search database.');
      const docs = projectDocuments(snapshot.workspace, projectId);
      await new RetainedIndex(this.env.SEARCH_DB).replace(snapshot.workspace.id, projectId, snapshot.revision, docs);
      await this.semantic()?.index(snapshot.workspace.id, projectId, snapshot.revision, docs);
      this.store.indexed(projectId, snapshot.revision);
    } catch (error) {
      this.store.indexFailure(projectId, state.revision, error instanceof ApiError ? error.code : 'INDEX_FAILED', terminal);
      if (error instanceof ApiError) throw error;
      throw new ApiError(502, 'INDEX_FAILED', 'Indexing failed; workflow records remain authoritative.');
    }
    await this.cleanupIndex(projectId);
  }

  private async cleanupIndex(projectId: string): Promise<void> {
    try {
      const more = await new RetainedIndex(this.env.SEARCH_DB).cleanup(this.env.WORKSPACE_ID, projectId, async rows => {
        if (this.env.SEARCH_VECTORS) await removeIndexedVectors(this.env.SEARCH_VECTORS, this.env.WORKSPACE_ID, projectId, rows);
      });
      this.store.cleanupFailure(projectId, false);
      if (more) await this.env.SEARCH_JOBS.send({ workspaceId: this.env.WORKSPACE_ID, projectId, revision: this.store.indexState(projectId)!.revision });
    } catch {
      this.store.cleanupFailure(projectId, true);
      throw new ApiError(502, 'INDEX_CLEANUP_FAILED', 'Index cleanup needs attention. Authoritative history is unchanged.');
    }
  }

  async exportTrial(identity:HumanAccessIdentity,policy:TrialPolicy) {
    if(!trialWorkflowEnabled(this.env)||this.trialCleanupRunning||retainedTrialCleanup(this.ctx.storage))throw new ApiError(403,'TRIAL_CLOSED','Trial data is not available for export.');
    const workspaceId=coordinatorWorkspaceId(this.ctx,this.env);
    const validate=async()=>{
      const grant=trialGrant(await trialRegistry(this.env).read(identity,policy));
      if(grant.workspaceId!==workspaceId||grant.ownerSubject!==identity.subject||grant.issuer!==identity.issuer||grant.audience!==identity.audience)throw new ApiError(403,'WORKSPACE_FORBIDDEN','Export belongs to a different trial.');
      if(grant.closedAt!==null)throw new ApiError(403,'TRIAL_CLOSED','Closed trials cannot export.');
      if(Date.now()>=trialCleanupDue(grant,policy))throw new ApiError(403,'TRIAL_EXPIRED','The export window has ended.');
    };
    this.activeCalls++;
    try {
      await validate();trialGrant(await trialRegistry(this.env).reserveExport(identity,policy));
      const {snapshot,backupLedgers}=this.store.captureBackup(),history=await buildWorkspaceBackup(snapshot,new Date().toISOString(),backupLedgers);
      const targets=Object.values(snapshot.workspace.projects??{}).map(project=>({name:project.repositoryName,commit:project.mainCommit,runId:null as string|null}));
      for(const run of snapshot.workspace.runs){const fork=snapshot.forks[run.id];if(fork&&run.headCommit)targets.push({name:fork.name,commit:run.headCommit,runId:run.id});}
      if(targets.length>11)throw new ApiError(413,'TRIAL_WORKFLOW_LIMIT','Export exceeds the trial resource limit.');
      const sources=[];
      for(const target of targets){
        await validate();const operation=Object.values(snapshot.operations).find(op=>op.resourceName===target.name);
        if(!operation?.repositoryId||!operation.marker)throw new ApiError(409,'TRIAL_SOURCE_CHANGED','Export resource ownership is unconfirmed.');
        using repo=await this.artifacts().get(target.name);const info=await repo.info();
        if(info.id!==operation.repositoryId||info.name!==target.name||info.description!==operation.marker)throw new ApiError(409,'TRIAL_SOURCE_CHANGED','An export repository was replaced.');
        const source=await readArtifactSnapshot(repo,target.commit);
        if(source.files.length>16||source.files.reduce((bytes,file)=>bytes+file.base64.length,0)>128*1024)throw new ApiError(413,'TRIAL_SOURCE_LIMIT','Export source exceeds the trial allowance.');
        sources.push({runId:target.runId,repository:target.name,...source});
      }
      await validate();if(this.store.identity().revision!==snapshot.revision)throw new ApiError(409,'STALE_EXPORT','Trial history changed during export.');
      return {format:'projects-git-trial-export/v1',workspaceId,history,sources,boundary:'Source snapshots and retained workflow history; not a Git object database or renewed authority.'};
    }finally{this.activeCalls--;}
  }

  async cleanupTrial(policy:TrialPolicy):Promise<TrialCleanupResult> {
    if(!isTrial(this.env))throw new ApiError(403,'TRIAL_ROUTING_REQUIRED','This is not a trial coordinator.');
    const workspaceId=coordinatorWorkspaceId(this.ctx,this.env);
    const validate=async()=>{
      const grant=trialGrant(await trialRegistry(this.env).cleanupGrant(workspaceId,policy));
      if(grant.workspaceId!==workspaceId)throw new ApiError(403,'WORKSPACE_FORBIDDEN','Cleanup authority targets another workspace.');
    };
    if(this.trialCleanupRunning)return {state:'pending',resources:null,deleted:null,reason:'OPERATION_IN_FLIGHT'};
    this.trialCleanupRunning=true;
    try {
      await validate();
      const prior=retainedTrialCleanup(this.ctx.storage);if(prior)return prior;
      if(this.activeCalls)return {state:'pending',resources:null,deleted:null,reason:'OPERATION_IN_FLIGHT'};
      if(this.ctx.storage.sql.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='trial_source_publications'").toArray().length
        &&this.ctx.storage.sql.exec('SELECT 1 FROM trial_source_publications WHERE lease_until>? LIMIT 1',Date.now()).toArray().length)
        return {state:'pending',resources:null,deleted:null,reason:'OPERATION_IN_FLIGHT'};
      const result=await cleanupTrialResources(this.ctx.storage,this.store.read(),this.env.TRIAL_ARTIFACTS,validate);
      if(result.state==='complete'){
        await validate();
        if(this.activeCalls)return {...result,state:'pending',reason:'OPERATION_IN_FLIGHT'};
        purgeTrialWorkspace(this.ctx.storage,workspaceId,result);
      }
      return result;
    }finally {this.trialCleanupRunning=false;}
  }

  async api(call: ApiCall): Promise<Response> {
    if(this.trialCleanupRunning)return json({code:'TRIAL_CLEANUP_IN_PROGRESS',error:'Trial cleanup is in progress.'},409);
    this.activeCalls++;
    const reply = (value:unknown,status=200) => json(call.method==='POST'?projectMutationResult(value,call.path):value,status);
    let controller: HostedController | undefined;
    try {
    if (!call.principal || !['owner', 'agent', 'reviewer', 'member'].includes(call.principal.kind)) return reply({code:'UNAUTHORIZED',error:'Authenticated request context required.'},401);
    // Only the authenticated Worker supplies this policy over internal RPC.
    // A retained DO environment can predate a settings-only Worker deployment.
    if (!call.policy) throw new ApiError(503, 'AUTH_POLICY_REQUIRED', 'The authenticated Worker must supply its current Access policy.');
    const authority = {policy:call.policy,principal:call.principal,forbiddenSecrets:call.forbiddenSecrets};
    let trial:TrialGrant|undefined;
    const workspaceId=coordinatorWorkspaceId(this.ctx,this.env);
    if(isTrial(this.env)) {
      assertTrialRoute(call.method,call.path,trialWorkflowEnabled(this.env));
      if(!call.trialPolicy)throw new ApiError(503,'TRIAL_POLICY_REQUIRED','The authenticated Worker must supply its current trial policy.');
      trial=trialGrant(await trialRegistry(this.env).authorize(workspaceId,call.principal,call.trialPolicy));
      if(JSON.stringify(call.policy)!==JSON.stringify(trialAccessPolicy(trial,trialWorkflowEnabled(this.env))))throw new ApiError(403,'TRIAL_POLICY_MISMATCH','Trial authority differs from the retained admission.');
    }
    assertAuthority(authority, workspaceId);
    authorizeRoute(call.principal, call.method, call.path);
    controller = this.controller(authority,trial,call.path==='/api/trial/sample');
      const trialSource=/^\/api\/runs\/([a-f0-9-]{36})\/source$/.exec(call.path);
      if(trialSource&&trial&&trialWorkflowEnabled(this.env)){
        const validate=async()=>{await controller!.trialAssignmentContext(trialSource[1]);};
        const reserve=async(kind:'read'|'create'|'issue'|'fork'|'push')=>{trialGrant(await trialRegistry(this.env).reserveResource(workspaceId,call.principal,call.trialPolicy!,kind));};
        const publication=new TrialSourcePublication(this.ctx.storage,scopedTrialArtifacts(this.artifacts(),()=>this.store.read(),reserve,validate),this.gitTransport(),
          run=>controller!.trialAssignmentContext(run),()=>reserve('push'));
        if(call.method==='GET'){
          const source=await controller.trialSource(trialSource[1]);
          const row=this.ctx.storage.sql.exec<{state:string;head_commit:string|null}>('SELECT state,head_commit FROM trial_source_publications WHERE run_id=?',trialSource[1]).toArray()[0];
          return reply({...source,publication:{state:row?.state??'not-started',headCommit:row?.head_commit??null}});
        }
        return reply(await publication.publish(trialSource[1],call.body,call.key));
      }
      if(call.path==='/api/trial/sample') {
        if(!trial)throw new ApiError(404,'NOT_FOUND','Trial sample setup is not available in this application.');
        if(call.search)throw new ApiError(400,'INVALID_TRIAL_SAMPLE','Sample setup accepts no query parameters.');
        if(call.method==='GET')return reply(await controller.trialSampleStatus());
        if(call.method==='POST'){const result=await controller.setupTrialSample(call.body,call.key);return reply(result,result.replayed?200:201);}
      }
      if(call.method==='GET'&&call.path==='/api/repositories') return reply(await controller.repositoryCatalog(call.search ?? ''));
      if(call.method==='GET'&&call.path==='/api/workspace/backup')return reply(await controller.workspaceBackup());
      if(call.method==='GET'&&call.path==='/api/workspace/recovery-imports')return reply(controller.recoveryHistory());
      const recoveryImport=/^\/api\/workspace\/recovery-imports\/([a-f0-9]{64})(\/archive)?$/.exec(call.path);
      if(call.method==='GET'&&recoveryImport)return reply(controller.recoveryHistory(recoveryImport[1],Boolean(recoveryImport[2])));
      if(call.method==='GET'&&call.path==='/api/repositories/head') return reply(await controller.repositoryHead(call.search ?? ''));
      if(call.method==='POST'&&call.path==='/api/repositories') return reply(await controller.createRepository(call.body,call.key),201);
      if(call.method==='GET'&&call.path==='/api/projects/catalog') {
        let query;try {query=parseProjectCatalog(call.search);}catch(error){throw new ApiError(400,'INVALID_PROJECT_CATALOG',(error as Error).message);}
        return reply(controller.projectCatalog(query));
      }
      if (call.method === "GET" && call.path === "/api/workspace") {
        let pageRequest;
        try { pageRequest = parseWorkspacePage(call.search); }
        catch (error) { throw new ApiError(400,'INVALID_WORKSPACE_PAGE',(error as Error).message); }
        const snapshot = controller.workspacePage(pageRequest);
        if(trial) {
          assertTrialActive(trial);
          if(trialWorkflowEnabled(this.env))return reply({...snapshot,sourceRevision:this.store.identity().revision,
            capacity:{...snapshot.capacity,limit:TRIAL_WORKFLOW_LIMITS.activeRuns},
            trial:{...trialStatus(trial),workflowReady:true,usage:trialWorkflowUsage(this.store.read()),limits:TRIAL_WORKFLOW_LIMITS,
              checks:await trialRegistry(this.env).checkAllowance(workspaceId,call.principal,call.trialPolicy!)},
            capabilities:{...snapshot.capabilities,repository:false,repositoryCatalog:false,repositoryCreate:false,model:false,repositoryChecks:false,baseUpdate:false}});
          return reply({...snapshot,sourceRevision:this.store.identity().revision,trial:trialStatus(trial),
            authentication:{...snapshot.authentication,permissions:{manage:false,review:false,merge:false}},
            capabilities:Object.fromEntries(Object.keys(snapshot.capabilities).map(name=>[name,false]))});
        }
        return reply({ ...snapshot, sourceRevision: this.store.identity().revision,
          ...(call.principal.kind==='owner'?{artifactEvents:this.artifactReceipts.summary(),artifactSubscriptions:this.subscriptions.summary()}:{}),
          capabilities: { ...snapshot.capabilities, retainedSearch: Boolean(this.env.SEARCH_DB && this.env.SEARCH_JOBS), semanticSearch: String(this.env.SEARCH_EMBEDDINGS_ENABLED) === 'true' } });
      }
      const search = /^\/api\/projects\/([a-f0-9-]{36})\/(search|search-index)$/.exec(call.path);
      const metrics = /^\/api\/projects\/([a-f0-9-]{36})\/metrics$/.exec(call.path);
      if(metrics&&call.method==='GET')return reply(controller.operationalMetrics(metrics[1]));
      if (search) {
        controller.requireProjectAccess(search[1]);
        const snapshot = this.store.read();
        if (!Object.hasOwn(snapshot.workspace.projects ?? {}, search[1])) throw new ApiError(404, 'PROJECT_NOT_FOUND', 'Project is not in this workspace.');
        if (!this.env.SEARCH_DB || !this.env.SEARCH_JOBS) throw new ApiError(503, 'SEARCH_NOT_CONFIGURED', 'Configure search database and queue bindings.');
        if (search[2] === 'search-index' && call.method === 'GET') return reply(this.store.indexState(search[1]));
        if (search[2] === 'search-index' && call.method === 'POST') {
          if (!Number.isSafeInteger(call.body.expectedRevision)) throw new ApiError(400, 'INDEX_REVISION_REQUIRED', 'Supply the current indexing revision.');
          return reply(this.store.rebuild(search[1], call.body.expectedRevision as number), 202);
        }
        if (search[2] === 'search' && call.method === 'GET') {
          const params = new URLSearchParams(call.search);
          const index = new RetainedIndex(this.env.SEARCH_DB);
          const query = params.get('q') ?? '', mode = params.get('mode') ?? 'literal';
          if (query.length > 200 || !['literal', 'semantic'].includes(mode)) throw new ApiError(400, 'INVALID_SEARCH', 'Choose literal or semantic search with up to 200 characters.');
          if (mode === 'semantic') {
            const semantic = this.semantic();
            if (!semantic) throw new ApiError(409, 'SEMANTIC_DISABLED', 'Semantic search is disabled. Literal search is available.');
            const current = await index.generation(snapshot.workspace.id, search[1]);
            controller.requireProjectAccess(search[1]);
            if (!current) throw new ApiError(409, 'SEMANTIC_INDEX_NOT_CURRENT', 'Build the history index before semantic search.');
            const matches = await semantic.search(snapshot.workspace.id, search[1], current.generation, query);
            controller.requireProjectAccess(search[1]);
            const items = await index.documents(snapshot.workspace.id, search[1], current.generation, matches.map(match => match.documentId));
            controller.requireProjectAccess(search[1]);
            return reply({ mode, generation: current.generation, total: current.document_count, matched: null, items: items.map(doc => ({ ...doc, score: matches.find(match => match.documentId === doc.id)!.score })), nextOffset: null, index: this.store.indexState(search[1]), sourceRevision: this.store.read().revision });
          }
          const result = await index.search(snapshot.workspace.id, search[1], query, Number(params.get('offset') ?? '0'));
          controller.requireProjectAccess(search[1]);
          return reply({ ...result, mode, index: this.store.indexState(search[1]), sourceRevision: this.store.read().revision });
        }
        throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use GET for search or GET/POST for index status and rebuild.');
      }
      const handoff = /^\/api\/tasks\/([a-f0-9-]{36})\/handoff$/.exec(call.path);
      const projectAccess = /^\/api\/projects\/([a-f0-9-]{36})\/access$/.exec(call.path);
      if(projectAccess&&call.method==='GET')return reply(controller.projectAccess(projectAccess[1]));
      if (call.method === 'GET' && call.path === '/api/review-inbox') return reply(controller.reviewInbox());
      const reviewContext = /^\/api\/runs\/([a-f0-9-]{36})\/review-context$/.exec(call.path);
      if (call.method === 'GET' && reviewContext) return reply(await controller.reviewContext(reviewContext[1]));
      if (call.method === 'GET' && handoff) return reply(await controller.handoff(handoff[1]));
      const archive = /^\/api\/projects\/([a-f0-9-]{36})\/(export|history)$/.exec(call.path);
      if (call.method === 'GET' && archive) return reply(archive[2] === 'export' ? await controller.exportProject(archive[1]) : controller.projectHistory(archive[1]));
      if (call.method !== "POST") throw new ApiError(404, "NOT_FOUND", "API route not found.");
      if(call.path==='/api/workspace/backup-preview')return reply(await controller.workspaceBackupPreview(call.body));
      if(call.path==='/api/workspace/restore')return reply(await controller.restoreWorkspaceHistory(call.body,call.key),201);
      if(projectAccess)return reply(await controller.changeProjectAccess(projectAccess[1],call.body,call.key));
      if (call.path === '/api/projects/restore') return reply(await controller.restoreProject(call.body, call.key), 201);
      if (call.path === "/api/workspace/adopt-owner") return reply(controller.adoptOwner());
      if (call.path === "/api/workspace/revoke-sessions") return reply(controller.revokeSessions(call.body));
      if (call.path === '/api/workspace/reviewer-name') return reply(controller.reviewerName(call.body));
      if (call.path === "/api/tasks") return reply(await controller.createTasks(call.body, call.key), 201);
      const release = /^\/api\/task-requests\/([a-f0-9-]{36})\/release$/.exec(call.path);
      if (release) return reply(await controller.releaseTaskRequest(release[1]));
      const automaticMerge = /^\/api\/projects\/([a-f0-9-]{36})\/automatic-merge$/.exec(call.path);
      if (automaticMerge) return reply(controller.automaticMergePolicy(automaticMerge[1], call.body));
      const project = /^\/api\/projects\/([a-f0-9-]{36})\/(claim|policy)$/.exec(call.path);
      if (project) return reply(project[2] === 'claim' ? await controller.claim(project[1], call.body, call.key) : controller.policy(project[1], call.body));
      if (call.path === '/api/model-runs') return reply(await controller.queueModels(call.body, call.key), 202);
      const owner = /^\/api\/tasks\/([a-f0-9-]{36})\/owner$/.exec(call.path);
      if (owner) return reply(controller.setOwner(owner[1], call.body));
      const revise = /^\/api\/tasks\/([a-f0-9-]{36})\/revise$/.exec(call.path);
      if (revise) return reply(controller.revise(revise[1], call.body));
      const assign = /^\/api\/tasks\/([a-f0-9-]{36})\/agents$/.exec(call.path);
      if (assign) return reply(await controller.assign(assign[1], call.body, call.key), 201);
      const start = /^\/api\/runs\/([a-f0-9-]{36})\/start$/.exec(call.path);
      if (start) return reply(controller.start(start[1]));
      const fail = /^\/api\/runs\/([a-f0-9-]{36})\/fail$/.exec(call.path);
      if (fail) return reply(await controller.fail(fail[1], call.body));
      const complete = /^\/api\/runs\/([a-f0-9-]{36})\/submit$/.exec(call.path);
      if (complete) {
        if(trial&&trialWorkflowEnabled(this.env)){
          const exists=this.ctx.storage.sql.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='trial_source_publications'").toArray().length;
          const row=exists?this.ctx.storage.sql.exec<{state:string;head_commit:string}>('SELECT state,head_commit FROM trial_source_publications WHERE run_id=?',complete[1]).toArray()[0]:null;
          if(row?.state!=='complete'||row.head_commit!==call.body.headCommit)throw new ApiError(409,'TRIAL_SOURCE_REQUIRED','Publish the bounded checkout source before submitting this exact commit.');
        }
        return reply(await controller.complete(complete[1], call.body));
      }
      const review = /^\/api\/runs\/([a-f0-9-]{36})\/review$/.exec(call.path);
      const reviewAssignments = /^\/api\/runs\/([a-f0-9-]{36})\/review-assignments$/.exec(call.path);
      if (reviewAssignments) return reply(await controller.assignReviewers(reviewAssignments[1],call.body,call.key));
      const reviewInference = /^\/api\/runs\/([a-f0-9-]{36})\/review-inference$/.exec(call.path);
      if (reviewInference) return reply(await controller.reserveReviewInference(reviewInference[1],call.body,call.key));
      const reconcileInference = /^\/api\/runs\/([a-f0-9-]{36})\/review-inference\/([a-f0-9-]{36})\/reconcile$/.exec(call.path);
      if (reconcileInference) return reply(controller.reconcileReviewInference(reconcileInference[1],reconcileInference[2],call.body));
      const codeReview = /^\/api\/runs\/([a-f0-9-]{36})\/code-review$/.exec(call.path);
      if (codeReview) return reply(await controller.codeReview(codeReview[1], call.body, call.key));
      const findingDecision = /^\/api\/runs\/([a-f0-9-]{36})\/findings\/([a-f0-9-]{36})\/decision$/.exec(call.path);
      if (findingDecision) return reply(await controller.findingDecision(findingDecision[1], findingDecision[2], call.body, call.key));
      if (review) return reply(await controller.review(review[1], call.body));
      const verify = /^\/api\/runs\/([a-f0-9-]{36})\/verify$/.exec(call.path);
      if (verify) return reply(await controller.verify(verify[1], call.body, call.key));
      const checks = /^\/api\/runs\/([a-f0-9-]{36})\/checks$/.exec(call.path);
      if (checks) return reply(await controller.configureChecks(checks[1], call.body, call.key));
      const updateBase = /^\/api\/runs\/([a-f0-9-]{36})\/update-base$/.exec(call.path);
      if (updateBase) return reply(await controller.updateBase(updateBase[1], call.body, call.key));
      const merge = /^\/api\/runs\/([a-f0-9-]{36})\/merge$/.exec(call.path);
      if (merge) return reply(await controller.merge(merge[1], call.body));
      if (call.path === "/api/demo") {
        throw new ApiError(409, "HOSTED_CAPABILITY_UNAVAILABLE", "Connect an Artifacts project and queue tasks, then assign an external agent or configure model execution.");
      }
      throw new ApiError(404, "NOT_FOUND", "API route not found.");
    } catch (error) { return errorResponse(error); }
    finally { try {if (controller) await this.schedule(controller);} finally {this.activeCalls--;} }
  }
}

export default {
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    assertNoTrialBackground(env);
    if(env.ARTIFACTS_EVENTS_QUEUE&&batch.queue===env.ARTIFACTS_EVENTS_QUEUE){
      const policy=artifactEventPolicy(env);
      for(const message of batch.messages){
        try {if(policy.automatic)parseArtifactPushEnvelope(message.body,policy);else parseArtifactPush(message.body,policy);}
        catch(error){if(error instanceof ApiError&&[403,422].includes(error.status)){console.error('ARTIFACT_EVENT_REJECTED');message.ack();continue;}throw error;}
        try {await env.WORKSPACES.getByName(policy.workspaceId).artifactPush(message.body,message.id);message.ack();}
        catch {message.retry({delaySeconds:60});}
      }
      return;
    }
    for (const message of batch.messages) {
      const data = message.body as { workspaceId?: unknown; projectId?: unknown; revision?: unknown } | null;
      if (!data || data.workspaceId !== env.WORKSPACE_ID || typeof data.projectId !== 'string' || !/^[a-f0-9-]{36}$/.test(data.projectId) || !Number.isSafeInteger(data.revision) || Number(data.revision) < 0) {
        console.error('INVALID_SEARCH_JOB'); message.ack(); continue;
      }
      try {
        await env.WORKSPACES.getByName(env.WORKSPACE_ID).indexProject(data.projectId, Number(data.revision), message.attempts >= 4);
        message.ack();
      } catch { message.retry({ delaySeconds: 60 }); }
    }
  },
  fetch: createAuthenticatedFetch(accessVerifier),
} satisfies ExportedHandler<Env>;

export function createAuthenticatedFetch(verifier: AccessVerifier) {
  return async (request: Request, env: Env): Promise<Response> => {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/api/health" && request.method === "GET") return json({ ok: true, provider: "cloudflare-artifacts" });
      const entranceEnabled = String(env.PUBLIC_ENTRANCE_ENABLED) === 'true';
      if (entranceEnabled) {
        const response = await publicEntrance(request, env.ASSETS);
        if (response) return response;
      }
      const policy = accessPolicy(env);
      const principal = await verifier.authenticate(request, policy);
      return await dispatchWorkspaceRequest(request,env,policy,principal);
    } catch (error) { return errorResponse(error); }
  };
}

// Both deployments enter this HTTP contract with authenticated, server-resolved
// authority. Caller-supplied workspace IDs are equality conditions, never routes.
export async function dispatchWorkspaceRequest(request:Request,env:Env,policy:AccessPolicy,principal:AccessPrincipal):Promise<Response> {
  const url=new URL(request.url);
  if (!url.pathname.startsWith('/api/')) return isTrial(env)||String(env.PUBLIC_ENTRANCE_ENABLED)==='true'
    ? await privateWorkbench(request, env.ASSETS) : await env.ASSETS.fetch(request);
  authorizeRoute(principal, request.method, url.pathname);
  const workspaceId=policy.workspaceId;
  if (!workspaceId || !/^[A-Za-z0-9_.-]{1,100}$/.test(workspaceId)) throw new ApiError(503, "WORKSPACE_NOT_CONFIGURED", "Configure a valid workspace identity.");
  const mutation = request.method !== "GET" && request.method !== "HEAD";
  if (mutation) requireSameOrigin(request);
  const forbiddenSecrets = [request.headers.get('Cf-Access-Jwt-Assertion'), request.headers.get('CF-Access-Client-Secret'),request.headers.get('Authorization')?.replace(/^Bearer /,''), env.MODEL_API_KEY].filter((value): value is string => Boolean(value));
  const body = mutation ? await bodyJson(request, forbiddenSecrets, ['/api/workspace/backup-preview','/api/workspace/restore'].includes(url.pathname) ? WORKSPACE_BACKUP_REQUEST_BYTES : url.pathname === '/api/projects/restore' ? 1100 * 1024 : url.pathname === '/api/tasks' || url.pathname.endsWith('/checks') || url.pathname.endsWith('/source') || /^\/api\/projects\/[a-f0-9-]{36}\/access$/.test(url.pathname) ? 128 * 1024 : 32 * 1024) : {};
  for(const expectedWorkspace of [request.headers.get('X-Workspace-Id'),body.expectedWorkspaceId])
    if (expectedWorkspace !== undefined && expectedWorkspace !== null && expectedWorkspace !== workspaceId) throw new ApiError(403, 'WORKSPACE_FORBIDDEN', 'The request targets a different workspace.');
  const needsKey = request.method === "POST" && (["/api/tasks", '/api/repositories', '/api/model-runs', '/api/projects/restore','/api/workspace/restore','/api/trial/sample'].includes(url.pathname) || /^\/api\/tasks\/[^/]+\/agents$/.test(url.pathname) || /^\/api\/projects\/[^/]+\/(claim|access)$/.test(url.pathname) || /^\/api\/runs\/[^/]+\/(source|checks|verify|update-base|code-review|review-assignments|review-inference)$/.test(url.pathname) || /^\/api\/runs\/[^/]+\/findings\/[^/]+\/decision$/.test(url.pathname));
  const key = needsKey ? idempotencyKey(request) : "";
  const stub = env.WORKSPACES.getByName(workspaceId);
  return await stub.api({ principal, policy, forbiddenSecrets, method: request.method, path: url.pathname, body, key, search: url.search,
    ...(isTrial(env)?{trialPolicy:configuredTrialPolicy(env)}:{}) });
}
