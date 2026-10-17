import {DurableObject} from 'cloudflare:workers';
import {AccessVerifier} from './access.ts';
import type {HumanAccessIdentity,AccessPrincipal} from './access.ts';
import {TrialAdmissionStore,trialAccessPolicy,trialStatus,assertTrialActive,trialReply,trialGrant,trialCleanupDue} from './trial-admission.ts';
import type {TrialRegistry,TrialReply,TrialPolicy} from './trial-admission.ts';
import {configuredTrialPolicy,trialRegistry,assertTrialRoute,trialWorkflowEnabled} from './trial-scope.ts';
import {TrialCredentials} from './trial-credentials.ts';
import type {TrialCredentialPrincipal,TrialCredentialRole} from './trial-credentials.ts';
import {dispatchWorkspaceRequest} from './index.ts';
import {ApiError,bodyJson,errorResponse,idempotencyKey,json,requireSameOrigin,digest} from './security.ts';
import {trialUiAsset} from './trial-ui-assets.mjs';
export {WorkspaceCoordinator} from './index.ts';

// Only a private binding invokes the registry. No HTTP endpoint accepts an
// arbitrary subject, email, workspace name, owner policy or client-selected role.
export class TrialAdmissions extends DurableObject<Env> implements TrialRegistry {
  private admissions:TrialAdmissionStore;
  private credentials:TrialCredentials;
  constructor(ctx:DurableObjectState,env:Env) {
    super(ctx,env);
    this.admissions=new TrialAdmissionStore(ctx.storage,configuredTrialPolicy(env));
    this.credentials=new TrialCredentials(ctx.storage,id=>this.admissions.retainedGrant(id));
  }
  async admit(identity:HumanAccessIdentity,key:string,policy:TrialPolicy) {const result=await trialReply(()=>{this.admissions.assertPolicy(policy);return this.admissions.admit(identity,key);});if(result.ok)await this.scheduleCleanup();return result;}
  async read(identity:HumanAccessIdentity,policy:TrialPolicy) {const result=await trialReply(()=>{this.admissions.assertPolicy(policy);return this.admissions.read(identity);});if(result.ok)await this.scheduleCleanup();return result;}
  async close(identity:HumanAccessIdentity,policy:TrialPolicy) {const result=await trialReply(()=>{this.admissions.assertPolicy(policy);return this.admissions.close(identity);});if(result.ok)await this.scheduleCleanup();return result;}
  async authorize(workspaceId:string,principal:AccessPrincipal,policy:TrialPolicy) {const result=await trialReply(async()=>{
    this.admissions.assertPolicy(policy);
    if(principal.provider==='trial-credential'){
      if(!trialWorkflowEnabled(this.env))throw new ApiError(403,'TRIAL_CREDENTIAL_INVALID','Trial workflow credentials are unavailable.');
      const grant=this.credentials.authorize(principal);if(grant.workspaceId!==workspaceId)throw new ApiError(403,'WORKSPACE_FORBIDDEN','Credential targets another trial.');return grant;
    }
    return this.admissions.authorize(workspaceId,principal);
  });if(result.ok)await this.scheduleCleanup();return result;}
  async reserveResource(workspaceId:string,principal:AccessPrincipal,policy:TrialPolicy,kind:'setup'|'read'|'create'|'issue'|'push'|'fork'|'check') {
    return trialReply(async()=>{
      this.admissions.assertPolicy(policy);await this.scheduleCleanup();
      if(principal.provider!=='trial-credential')return this.admissions.reserveResource(workspaceId,principal,kind);
      const grant=this.credentials.authorize(principal);
      if(grant.workspaceId!==workspaceId||!trialWorkflowEnabled(this.env)||kind==='setup'||kind==='create'||kind==='check'||principal.kind==='reviewer'&&kind!=='read')
        throw new ApiError(403,'WORKSPACE_FORBIDDEN','This role cannot reserve that resource effect.');
      this.admissions.resources.reserveEffect(workspaceId,kind);return grant;
    });
  }
  async authenticateCredential(token:string,policy:TrialPolicy) {
    let principal:TrialCredentialPrincipal|undefined;
    const result=await trialReply(async()=>{this.admissions.assertPolicy(policy);if(!trialWorkflowEnabled(this.env))throw new ApiError(401,'TRIAL_CREDENTIAL_INVALID','Trial workflow is unavailable.');principal=await this.credentials.authenticate(token);return this.credentials.authorize(principal);});
    if(result.ok)await this.scheduleCleanup();return {...result,...(result.ok?{principal}: {})};
  }
  async issueCredential(identity:HumanAccessIdentity,policy:TrialPolicy,role:TrialCredentialRole,key:string) {
    this.admissions.assertPolicy(policy);if(!trialWorkflowEnabled(this.env))throw new ApiError(409,'TRIAL_CAPABILITY_UNAVAILABLE','Trial workflow is not configured.');
    const grant=await this.admissions.read(identity);return this.credentials.issue(grant.workspaceId,identity,role,key);
  }
  async revokeCredential(identity:HumanAccessIdentity,policy:TrialPolicy,role:TrialCredentialRole) {
    this.admissions.assertPolicy(policy);const grant=await this.admissions.read(identity);return this.credentials.revoke(grant.workspaceId,identity,role);
  }
  async checkAllowance(workspaceId:string,principal:AccessPrincipal,policy:TrialPolicy) {
    trialGrant(await this.authorize(workspaceId,principal,policy));return this.admissions.resources.checkStatus(workspaceId);
  }
  async reserveExport(identity:HumanAccessIdentity,policy:TrialPolicy) {
    return trialReply(async()=>{
      this.admissions.assertPolicy(policy);const previous=await this.admissions.read(identity),grant=this.admissions.retainedGrant(previous.workspaceId);
      if(grant.closedAt!==null)throw new ApiError(403,'TRIAL_CLOSED','Closed trials cannot export.');
      if(Date.now()>=trialCleanupDue(grant,policy))throw new ApiError(403,'TRIAL_EXPIRED','The export window has ended.');
      this.admissions.resources.reserveExport(grant.workspaceId);return grant;
    });
  }
  async controls(identity:HumanAccessIdentity,policy:TrialPolicy) {
    const result=await trialReply(()=>{this.admissions.assertPolicy(policy);return this.admissions.read(identity);});
    return {...result,...(result.ok?{allowance:this.admissions.resources.status(result.grant.workspaceId)}:{})};
  }
  async pauseResources(policy:TrialPolicy,reason:string) {this.admissions.assertPolicy(policy);this.admissions.resources.pause(reason);}
  async cleanupGrant(workspaceId:string,policy:TrialPolicy) {return trialReply(async()=>{this.admissions.assertPolicy(policy);return this.admissions.cleanupGrant(workspaceId);});}
  async cleanupStatus(identity:HumanAccessIdentity,policy:TrialPolicy) {this.admissions.assertPolicy(policy);return this.admissions.cleanupStatus(await this.admissions.read(identity));}
  private async scheduleCleanup() {
    const existing=await this.ctx.storage.getAlarm();
    const next=this.admissions.cleanupSchedule()[0];
    if(next){const due=Math.max(Date.now()+1000,next.at);if(existing===null||existing>due)await this.ctx.storage.setAlarm(due);}
    else if(existing!==null)await this.ctx.storage.deleteAlarm();
  }
  async alarm() {
    const policy=configuredTrialPolicy(this.env);
    for(const item of this.admissions.cleanupSchedule().filter(item=>item.at<=Date.now()).slice(0,5)) {
      const attempt=this.admissions.claimCleanup(item.workspaceId);if(!attempt)continue;
      let result;
      try {result=await this.env.WORKSPACES.getByName(item.workspaceId).cleanupTrial(policy);if(result.state==='complete')this.credentials.purge(item.workspaceId);}
      catch {result={state:'pending' as const,resources:null,deleted:null,reason:'CLEANUP_UNAVAILABLE'};}
      this.admissions.recordCleanup(item.workspaceId,attempt,result);
    }
    await this.scheduleCleanup();
  }
}

export function createTrialFetch(verifier:AccessVerifier) {
  return async(request:Request,env:Env):Promise<Response>=>{
    try {
      const policy=configuredTrialPolicy(env),url=new URL(request.url),workflow=trialWorkflowEnabled(env);
      const publicAsset=await trialUiAsset(request,env.ASSETS);
      if(publicAsset)return publicAsset;
      if(url.pathname.startsWith('/agent/api/')){
        if(!workflow)throw new ApiError(409,'TRIAL_CAPABILITY_UNAVAILABLE','Trial agent workflow is not configured.');
        const token=/^Bearer (pgt1_[a-f0-9]{64})$/.exec(request.headers.get('Authorization')??'')?.[1];
        if(!token)throw new ApiError(401,'TRIAL_CREDENTIAL_INVALID','Supply a current trial connection credential.');
        const reply=await trialRegistry(env).authenticateCredential(token,policy),grant=trialGrant(reply),principal=reply.principal;
        if(!principal||principal.provider!=='trial-credential'||principal.workspaceId!==grant.workspaceId||principal.issuer!==grant.issuer
          ||request.headers.get('X-Workspace-Id')!==grant.workspaceId)throw new ApiError(403,'WORKSPACE_FORBIDDEN','Credential and workspace must match.');
        url.pathname=url.pathname.slice('/agent'.length);assertTrialRoute(request.method,url.pathname,true);
        return await dispatchWorkspaceRequest(new Request(url,request),env,trialAccessPolicy(grant,true),principal);
      }
      const identity=await verifier.authenticateHuman(request,policy);
      const identityKey=await digest(JSON.stringify([identity.issuer,identity.audience,identity.subject]));
      const signupAsset=await trialUiAsset(request,env.ASSETS,true);
      if(signupAsset)return signupAsset;
      if(url.pathname==='/api/trial/session') {
        if(request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED','Use GET to inspect the verified trial identity.');
        if(url.search||request.headers.has('X-Workspace-Id'))throw new ApiError(400,'INVALID_TRIAL_REQUEST','The trial session accepts no identity selectors.');
        return json({identityKey,email:identity.displayName,policy:{revision:policy.revision,durationMs:policy.durationMs}});
      }
      const status=async(grant:Parameters<typeof trialStatus>[0])=>{
        const cleanup=await trialRegistry(env).cleanupStatus(identity,policy);
        const result=trialStatus(grant),active=result.status==='admitted';
        return {...result,workflowReady:workflow,...(workflow?{exportUntil:new Date(trialCleanupDue(grant,policy)).toISOString()}:{}),capabilities:{...result.capabilities,agents:workflow&&active,checks:workflow&&active},cleanup:cleanup.reason==='NOT_DUE'?'not-due':cleanup.state,identityKey};
      };
      const ownGrant=(reply:TrialReply)=>{
        const grant=trialGrant(reply);
        if(grant.issuer!==identity.issuer||grant.audience!==identity.audience||grant.ownerSubject!==identity.subject)
          throw new ApiError(403,'WORKSPACE_FORBIDDEN','Admission does not belong to the verified trial identity.');
        return grant;
      };
      if(['/api/trial/credentials','/api/trial/credentials/revoke'].includes(url.pathname)){
        if(request.method!=='POST'||url.search)throw new ApiError(405,'METHOD_NOT_ALLOWED','Use POST for trial connections.');
        requireSameOrigin(request);const key=idempotencyKey(request);
        if(request.headers.get('X-Trial-Identity')!==identityKey)throw new ApiError(409,'TRIAL_IDENTITY_CHANGED','Check the signed-in identity again.');
        const grant=ownGrant(await trialRegistry(env).read(identity,policy));assertTrialActive(grant);
        if(request.headers.get('X-Workspace-Id')!==grant.workspaceId)throw new ApiError(403,'WORKSPACE_FORBIDDEN','The request targets another trial.');
        const body=await bodyJson(request,[],1024);
        if(Object.keys(body).join(',')!=='role'||!['agent','reviewer'].includes(String(body.role)))throw new ApiError(400,'TRIAL_CREDENTIAL_ROLE','Choose agent or reviewer.');
        return json(url.pathname.endsWith('/revoke')?await trialRegistry(env).revokeCredential(identity,policy,body.role as TrialCredentialRole)
          :await trialRegistry(env).issueCredential(identity,policy,body.role as TrialCredentialRole,key));
      }
      if(url.pathname==='/api/trial/export'){
        if(!workflow)throw new ApiError(409,'TRIAL_CAPABILITY_UNAVAILABLE','Trial workflow exports are not configured.');
        requireSameOrigin(request);
        if(request.method!=='GET'||url.search||request.headers.has('X-Workspace-Id'))throw new ApiError(400,'INVALID_TRIAL_REQUEST','Export derives its owner and workspace from the verified login.');
        const grant=ownGrant(await trialRegistry(env).read(identity,policy));
        if(grant.closedAt!==null)throw new ApiError(403,'TRIAL_CLOSED','Closed trials cannot export.');
        if(Date.now()>=trialCleanupDue(grant,policy))throw new ApiError(403,'TRIAL_EXPIRED','The export window has ended.');
        const result=await env.WORKSPACES.getByName(grant.workspaceId).exportTrial(identity,policy);
        const response=json(result);response.headers.set('Content-Disposition','attachment; filename="projects-git-trial-export.json"');return response;
      }
      const admissionPath=url.pathname==='/api/trial'||url.pathname==='/api/trial/close';
      // Queries never select a trial; even redundant identity fields are refused.
      if(admissionPath&&url.search)throw new ApiError(400,'INVALID_TRIAL_REQUEST','Trial admission takes no query parameters.');
      if(admissionPath) {
        if(request.headers.has('X-Workspace-Id'))throw new ApiError(400,'INVALID_TRIAL_REQUEST','Admission derives workspace identity from the verified login.');
        if(url.pathname==='/api/trial'&&request.method==='GET')return json(await status(ownGrant(await trialRegistry(env).read(identity,policy))));
        if(request.method!=='POST')throw new ApiError(405,'METHOD_NOT_ALLOWED','Use GET for trial status or POST for admission and closure.');
        requireSameOrigin(request);
        if(request.headers.get('X-Trial-Identity')!==identityKey)
          throw new ApiError(409,'TRIAL_IDENTITY_CHANGED','Check the signed-in trial identity again before changing a reservation.');
        const key=idempotencyKey(request);
        const body=await bodyJson(request,[request.headers.get('Cf-Access-Jwt-Assertion')??''],1024);
        if(Object.keys(body).length)throw new ApiError(400,'INVALID_TRIAL_REQUEST','Send an empty object; identity and limits are resolved on the server.');
        const registry=trialRegistry(env);
        const grant=ownGrant(url.pathname==='/api/trial'?await registry.admit(identity,key,policy):await registry.close(identity,policy));
        return json(await status(grant));
      }
      if(url.pathname==='/api/trial/sample') {
        if(url.search||request.headers.has('X-Workspace-Id'))throw new ApiError(400,'INVALID_TRIAL_SAMPLE','Sample setup accepts no workspace selectors or query parameters.');
        if(request.method==='POST'&&request.headers.get('X-Trial-Identity')!==identityKey)
          throw new ApiError(409,'TRIAL_IDENTITY_CHANGED','Check the signed-in trial identity before preparing its sample.');
      }
      if(url.pathname.startsWith('/api/'))assertTrialRoute(request.method,url.pathname,workflow);
      const grant=ownGrant(await trialRegistry(env).read(identity,policy));assertTrialActive(grant);
      for(const key of ['workspace','workspaceId','expectedWorkspaceId'])
        for(const value of url.searchParams.getAll(key))if(value!==grant.workspaceId)
          throw new ApiError(403,'WORKSPACE_FORBIDDEN','The request targets a different workspace.');
      const principal:AccessPrincipal={provider:'cloudflare-access',kind:'owner',id:identity.subject,issuer:identity.issuer,
        workspaceId:grant.workspaceId,displayName:identity.displayName,issuedAt:identity.issuedAt,expiresAt:identity.expiresAt};
      return await dispatchWorkspaceRequest(request,env,trialAccessPolicy(grant,workflow),principal);
    }catch(error){return errorResponse(error);}
  };
}

export default {fetch:createTrialFetch(new AccessVerifier())} satisfies ExportedHandler<Env>;
