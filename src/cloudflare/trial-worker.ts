import {DurableObject} from 'cloudflare:workers';
import {AccessVerifier} from './access.ts';
import type {HumanAccessIdentity,AccessPrincipal} from './access.ts';
import {TrialAdmissionStore,trialAccessPolicy,trialStatus,assertTrialActive,trialReply,trialGrant} from './trial-admission.ts';
import type {TrialRegistry,TrialReply,TrialPolicy} from './trial-admission.ts';
import {configuredTrialPolicy,trialRegistry,assertTrialRead} from './trial-scope.ts';
import {dispatchWorkspaceRequest} from './index.ts';
import {ApiError,bodyJson,errorResponse,idempotencyKey,json,requireSameOrigin} from './security.ts';
export {WorkspaceCoordinator} from './index.ts';

// Only a private binding invokes the registry. No HTTP endpoint accepts an
// arbitrary subject, email, workspace name, owner policy or client-selected role.
export class TrialAdmissions extends DurableObject<Env> implements TrialRegistry {
  private admissions:TrialAdmissionStore;
  constructor(ctx:DurableObjectState,env:Env) {
    super(ctx,env);
    this.admissions=new TrialAdmissionStore(ctx.storage,configuredTrialPolicy(env));
  }
  async admit(identity:HumanAccessIdentity,key:string,policy:TrialPolicy) {return trialReply(()=>{this.admissions.assertPolicy(policy);return this.admissions.admit(identity,key);});}
  async read(identity:HumanAccessIdentity,policy:TrialPolicy) {return trialReply(()=>{this.admissions.assertPolicy(policy);return this.admissions.read(identity);});}
  async close(identity:HumanAccessIdentity,policy:TrialPolicy) {return trialReply(()=>{this.admissions.assertPolicy(policy);return this.admissions.close(identity);});}
  async authorize(workspaceId:string,principal:AccessPrincipal,policy:TrialPolicy) {return trialReply(()=>{this.admissions.assertPolicy(policy);return this.admissions.authorize(workspaceId,principal);});}
}

export function createTrialFetch(verifier:AccessVerifier) {
  return async(request:Request,env:Env):Promise<Response>=>{
    try {
      const policy=configuredTrialPolicy(env),url=new URL(request.url);
      const identity=await verifier.authenticateHuman(request,policy);
      const ownGrant=(reply:TrialReply)=>{
        const grant=trialGrant(reply);
        if(grant.issuer!==identity.issuer||grant.audience!==identity.audience||grant.ownerSubject!==identity.subject)
          throw new ApiError(403,'WORKSPACE_FORBIDDEN','Admission does not belong to the verified trial identity.');
        return grant;
      };
      const admissionPath=url.pathname==='/api/trial'||url.pathname==='/api/trial/close';
      // Queries never select a trial; even redundant identity fields are refused.
      if(admissionPath&&url.search)throw new ApiError(400,'INVALID_TRIAL_REQUEST','Trial admission takes no query parameters.');
      if(admissionPath) {
        if(request.headers.has('X-Workspace-Id'))throw new ApiError(400,'INVALID_TRIAL_REQUEST','Admission derives workspace identity from the verified login.');
        if(url.pathname==='/api/trial'&&request.method==='GET')return json(trialStatus(ownGrant(await trialRegistry(env).read(identity,policy))));
        if(request.method!=='POST')throw new ApiError(405,'METHOD_NOT_ALLOWED','Use GET for trial status or POST for admission and closure.');
        requireSameOrigin(request);
        const key=idempotencyKey(request);
        const body=await bodyJson(request,[request.headers.get('Cf-Access-Jwt-Assertion')??''],1024);
        if(Object.keys(body).length)throw new ApiError(400,'INVALID_TRIAL_REQUEST','Send an empty object; identity and limits are resolved on the server.');
        const registry=trialRegistry(env);
        const grant=ownGrant(url.pathname==='/api/trial'?await registry.admit(identity,key,policy):await registry.close(identity,policy));
        return json(trialStatus(grant));
      }
      if(url.pathname.startsWith('/api/'))assertTrialRead(request.method,url.pathname);
      const grant=ownGrant(await trialRegistry(env).read(identity,policy));assertTrialActive(grant);
      for(const key of ['workspace','workspaceId','expectedWorkspaceId'])
        for(const value of url.searchParams.getAll(key))if(value!==grant.workspaceId)
          throw new ApiError(403,'WORKSPACE_FORBIDDEN','The request targets a different workspace.');
      const principal:AccessPrincipal={provider:'cloudflare-access',kind:'owner',id:identity.subject,issuer:identity.issuer,
        workspaceId:grant.workspaceId,displayName:identity.displayName,issuedAt:identity.issuedAt,expiresAt:identity.expiresAt};
      return await dispatchWorkspaceRequest(request,env,trialAccessPolicy(grant),principal);
    }catch(error){return errorResponse(error);}
  };
}

export default {fetch:createTrialFetch(new AccessVerifier())} satisfies ExportedHandler<Env>;
