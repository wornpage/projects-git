import {ApiError} from './security.ts';
import {readTrialPolicy,TRIAL_REGISTRY_NAME} from './trial-admission.ts';

export function isTrial(env:Env):boolean {return env.TRIAL_POLICY!==undefined;}

export function configuredTrialPolicy(env:Env) {
  // A dedicated trial deployment must never inherit the real owner's resources
  // or execution capabilities. The initial admission slice has metadata only.
  if(!isTrial(env)||env.WORKSPACE_ID||env.ACCESS_OWNER_SUB
    ||[env.ACCESS_AGENT_CLIENT_IDS,env.ACCESS_REVIEWER_CLIENT_IDS,env.ACCESS_REVIEWER_SUBJECTS,env.ACCESS_MEMBER_SUBJECTS].some(value=>value&&value!=='[]')
    ||env.ARTIFACTS||env.LOADER||env.REPOSITORY_CHECKS||env.SEARCH_DB||env.SEARCH_JOBS||env.SEARCH_VECTORS||env.SEARCH_AI
    ||env.EVENT_SUBSCRIPTIONS||env.CURRENT_POLICY||env.MODEL_API_KEY||env.MODEL||env.ARTIFACTS_EVENTS_QUEUE
    ||String(env.PUBLIC_ENTRANCE_ENABLED)==='true'||!env.TRIAL_REGISTRY)
    throw new ApiError(503,'TRIAL_DEPLOYMENT_FORBIDDEN','Use a separate metadata-only trial deployment without existing-owner or provider bindings.');
  return readTrialPolicy(env.TRIAL_POLICY!);
}
export function trialRegistry(env:Env) {
  configuredTrialPolicy(env);
  return env.TRIAL_REGISTRY!.getByName(TRIAL_REGISTRY_NAME);
}
export function coordinatorWorkspaceId(ctx:DurableObjectState,env:Env):string {
  if(!isTrial(env))return env.WORKSPACE_ID;
  configuredTrialPolicy(env);
  const name=ctx.id.name;
  if(typeof name!=='string'||!/^trial-[a-f0-9]{64}$/.test(name))
    throw new ApiError(403,'TRIAL_ROUTING_REQUIRED','A trial coordinator must be addressed by its server-derived workspace name.');
  return name;
}
export function assertTrialRead(method:string,path:string):void {
  if(method==='GET'&&(path==='/api/workspace'||path==='/api/projects/catalog'
    ||/^\/api\/projects\/[a-f0-9-]{36}\/(metrics|access)$/.test(path)))return;
  throw new ApiError(409,'TRIAL_CAPABILITY_UNAVAILABLE','Trial admission is available; repository, agent, export and execution setup is not implemented.');
}
export function assertNoTrialBackground(env:Env):void {
  if(isTrial(env))throw new ApiError(409,'TRIAL_CAPABILITY_UNAVAILABLE','Trial admission has no background workflow capabilities.');
}
