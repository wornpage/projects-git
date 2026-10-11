import { DurableObject } from "cloudflare:workers";
import { AccessVerifier, accessPolicy, assertAuthority, authorizeRoute, systemAuthority, ownerBinding } from './access.ts';
import type { AccessPolicy, AccessPrincipal, HostedAuthority } from './access.ts';
import { publicEntrance } from '../entrance/handler.mjs';
import { privateWorkbench } from './workbench-assets.mjs';
const accessVerifier = new AccessVerifier();
import { HostedController } from "./controller.ts";
import { WorkspaceStore } from './workspace-store.ts';
import { parseWorkspacePage, projectMutationResult } from '../../public/workspace-page.js';
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
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new WorkspaceStore(ctx.storage, env.WORKSPACE_ID);
    this.artifactReceipts = new ArtifactEventReceipts(ctx.storage);
    this.subscriptions = new ArtifactSubscriptions(ctx.storage);
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS attempts (run_id TEXT PRIMARY KEY, receipt TEXT NOT NULL)');
  }

  protected artifacts(): Artifacts { return this.env.ARTIFACTS; }
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

  private controller(authority: HostedAuthority): HostedController {
    const provider = this.modelProvider();
    return new HostedController(this.store, this.artifacts(), authority, {
      ensureSubscription:(repository,validate)=>this.ensureSubscription(repository,validate),
      checks: { verify: (source, commit, signal, attemptId) => this.verifyCheckout(source, commit, signal, attemptId) }, git: this.gitTransport(), provider,
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
    const finished = new WorkerChecks(this.env.LOADER).verify(source, commit, combined);
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
    const controller = this.controller(systemAuthority(accessPolicy(this.env)));
    await controller.drainJobs();
    await controller.drainAutomaticMerges();
    await this.deliverIndexJobs();
    await this.schedule(controller);
  }

  private async schedule(controller: HostedController): Promise<void> {
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

  async api(call: ApiCall): Promise<Response> {
    const reply = (value:unknown,status=200) => json(call.method==='POST'?projectMutationResult(value,call.path):value,status);
    let controller: HostedController | undefined;
    try {
    if (!call.principal || !['owner', 'agent', 'reviewer'].includes(call.principal.kind)) return reply({code:'UNAUTHORIZED',error:'Authenticated request context required.'},401);
    // Only the authenticated Worker supplies this policy over internal RPC.
    // A retained DO environment can predate a settings-only Worker deployment.
    if (!call.policy) throw new ApiError(503, 'AUTH_POLICY_REQUIRED', 'The authenticated Worker must supply its current Access policy.');
    const authority = {policy:call.policy,principal:call.principal,forbiddenSecrets:call.forbiddenSecrets};
    assertAuthority(authority, this.env.WORKSPACE_ID);
    authorizeRoute(call.principal, call.method, call.path);
    controller = this.controller(authority);
      if (call.method === "GET" && call.path === "/api/workspace") {
        let pageRequest;
        try { pageRequest = parseWorkspacePage(call.search); }
        catch (error) { throw new ApiError(400,'INVALID_WORKSPACE_PAGE',(error as Error).message); }
        const page = pageRequest ? this.store.readPage(pageRequest) : null;
        const snapshot = page ? controller.workspace(page.snapshot,page.capacity) : controller.workspace();
        return reply({ ...snapshot, ...(page?{page:page.page,operationReceipts:page.operationReceipts}:{}), sourceRevision: this.store.identity().revision, artifactEvents:this.artifactReceipts.summary(), artifactSubscriptions:this.subscriptions.summary(), capabilities: { ...snapshot.capabilities, retainedSearch: Boolean(this.env.SEARCH_DB && this.env.SEARCH_JOBS), semanticSearch: String(this.env.SEARCH_EMBEDDINGS_ENABLED) === 'true' } });
      }
      const search = /^\/api\/projects\/([a-f0-9-]{36})\/(search|search-index)$/.exec(call.path);
      if (search) {
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
            if (!current) throw new ApiError(409, 'SEMANTIC_INDEX_NOT_CURRENT', 'Build the history index before semantic search.');
            const matches = await semantic.search(snapshot.workspace.id, search[1], current.generation, query);
            const items = await index.documents(snapshot.workspace.id, search[1], current.generation, matches.map(match => match.documentId));
            return reply({ mode, generation: current.generation, total: current.document_count, matched: null, items: items.map(doc => ({ ...doc, score: matches.find(match => match.documentId === doc.id)!.score })), nextOffset: null, index: this.store.indexState(search[1]), sourceRevision: this.store.read().revision });
          }
          const result = await index.search(snapshot.workspace.id, search[1], query, Number(params.get('offset') ?? '0'));
          return reply({ ...result, mode, index: this.store.indexState(search[1]), sourceRevision: this.store.read().revision });
        }
        throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use GET for search or GET/POST for index status and rebuild.');
      }
      const handoff = /^\/api\/tasks\/([a-f0-9-]{36})\/handoff$/.exec(call.path);
      if (call.method === 'GET' && call.path === '/api/review-inbox') return reply(controller.reviewInbox());
      const reviewContext = /^\/api\/runs\/([a-f0-9-]{36})\/review-context$/.exec(call.path);
      if (call.method === 'GET' && reviewContext) return reply(await controller.reviewContext(reviewContext[1]));
      if (call.method === 'GET' && handoff) return reply(await controller.handoff(handoff[1]));
      const archive = /^\/api\/projects\/([a-f0-9-]{36})\/(export|history)$/.exec(call.path);
      if (call.method === 'GET' && archive) return reply(archive[2] === 'export' ? await controller.exportProject(archive[1]) : controller.projectHistory(archive[1]));
      if (call.method !== "POST") throw new ApiError(404, "NOT_FOUND", "API route not found.");
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
      if (complete) return reply(await controller.complete(complete[1], call.body));
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
    finally { if (controller) await this.schedule(controller); }
  }
}

export default {
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
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
      if (!url.pathname.startsWith('/api/')) return entranceEnabled
        ? await privateWorkbench(request, env.ASSETS) : await env.ASSETS.fetch(request);
      authorizeRoute(principal, request.method, url.pathname);
      if (!env.WORKSPACE_ID || !/^[A-Za-z0-9_.-]{1,100}$/.test(env.WORKSPACE_ID)) throw new ApiError(503, "WORKSPACE_NOT_CONFIGURED", "Configure a valid WORKSPACE_ID.");
      const mutation = request.method !== "GET" && request.method !== "HEAD";
      if (mutation) requireSameOrigin(request);
      const forbiddenSecrets = [request.headers.get('Cf-Access-Jwt-Assertion'), request.headers.get('CF-Access-Client-Secret'), env.MODEL_API_KEY].filter((value): value is string => Boolean(value));
      const body = mutation ? await bodyJson(request, forbiddenSecrets, url.pathname === '/api/projects/restore' ? 1100 * 1024 : url.pathname === '/api/tasks' || url.pathname.endsWith('/checks') ? 128 * 1024 : 32 * 1024) : {};
      const expectedWorkspace = request.headers.get('X-Workspace-Id') ?? body.expectedWorkspaceId;
      if (expectedWorkspace !== undefined && expectedWorkspace !== null && expectedWorkspace !== env.WORKSPACE_ID) throw new ApiError(403, 'WORKSPACE_FORBIDDEN', 'The request targets a different workspace.');
      const needsKey = request.method === "POST" && (["/api/tasks", '/api/model-runs', '/api/projects/restore'].includes(url.pathname) || /^\/api\/tasks\/[^/]+\/agents$/.test(url.pathname) || /^\/api\/projects\/[^/]+\/claim$/.test(url.pathname) || /^\/api\/runs\/[^/]+\/(checks|verify|update-base|code-review|review-assignments|review-inference)$/.test(url.pathname) || /^\/api\/runs\/[^/]+\/findings\/[^/]+\/decision$/.test(url.pathname));
      const key = needsKey ? idempotencyKey(request) : "";
      const stub = env.WORKSPACES.getByName(env.WORKSPACE_ID);
      return await stub.api({ principal, policy, forbiddenSecrets, method: request.method, path: url.pathname, body, key, search: url.search });
    } catch (error) { return errorResponse(error); }
  };
}
