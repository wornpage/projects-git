import {ApiError} from './security.ts';
import {readTrialPolicy,TRIAL_REGISTRY_NAME} from './trial-admission.ts';

export function isTrial(env:Env):boolean {return env.TRIAL_POLICY!==undefined;}

export function configuredTrialPolicy(env:Env) {
  // A dedicated trial deployment must never inherit the real owner's resources
  // or execution capabilities. Samples use only the separate TRIAL_ARTIFACTS binding.
  if(!isTrial(env)||env.WORKSPACE_ID||env.ACCESS_OWNER_SUB
    ||[env.ACCESS_AGENT_CLIENT_IDS,env.ACCESS_REVIEWER_CLIENT_IDS,env.ACCESS_REVIEWER_SUBJECTS,env.ACCESS_MEMBER_SUBJECTS].some(value=>value&&value!=='[]')
    ||env.ARTIFACTS||env.LOADER||env.REPOSITORY_CHECKS||env.SEARCH_DB||env.SEARCH_JOBS||env.SEARCH_VECTORS||env.SEARCH_AI
    ||env.EVENT_SUBSCRIPTIONS||env.CURRENT_POLICY||env.MODEL_API_KEY||env.MODEL||env.ARTIFACTS_EVENTS_QUEUE
    ||String(env.PUBLIC_ENTRANCE_ENABLED)==='true'||String(env.ARTIFACTS_EVENTS_AUTOMATIC)==='true'||!env.TRIAL_REGISTRY)
    throw new ApiError(503,'TRIAL_DEPLOYMENT_FORBIDDEN','Use a separate trial deployment without existing-owner or execution bindings.');
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
export function assertTrialRoute(method:string,path:string):void {
  if(['GET','POST'].includes(method)&&path==='/api/trial/sample')return;
  if(method==='GET'&&(path==='/api/workspace'||path==='/api/projects/catalog'
    ||/^\/api\/projects\/[a-f0-9-]{36}\/(metrics|access)$/.test(path)))return;
  throw new ApiError(409,'TRIAL_CAPABILITY_UNAVAILABLE','Only trial metadata and supplied sample setup are available. Agents, exports and execution are unavailable.');
}
export function assertNoTrialBackground(env:Env):void {
  if(isTrial(env))throw new ApiError(409,'TRIAL_CAPABILITY_UNAVAILABLE','Trial admission has no background workflow capabilities.');
}
