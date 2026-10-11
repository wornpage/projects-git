import {WorkerEntrypoint} from 'cloudflare:workers';
import {ApiError} from './security.ts';
import {CloudflareSubscriptions} from './subscription-provider.ts';
import type {SubscriptionPlan,RegisteredSubscription} from './artifact-subscriptions.ts';

export type SubscriptionReply={ok:true;result:RegisteredSubscription|RegisteredSubscription[]}|{ok:false;code:string};
export class ArtifactSubscriptionService extends WorkerEntrypoint<SubscriptionServiceEnv>{
  async registerStep(step:'find'|'create'|'enable',plan:SubscriptionPlan,id?:string):Promise<SubscriptionReply>{
    try{
      const provider=new CloudflareSubscriptions({accountId:this.env.SUBSCRIPTIONS_ACCOUNT_ID,namespace:this.env.SUBSCRIPTIONS_NAMESPACE,
        queueId:this.env.SUBSCRIPTIONS_QUEUE_ID,workspaceId:this.env.SUBSCRIPTIONS_WORKSPACE_ID,ownerKey:this.env.SUBSCRIPTIONS_OWNER_KEY},this.env.SUBSCRIPTIONS_API_TOKEN);
      if(step==='find')return {ok:true,result:await provider.find(plan)};
      if(step==='create')return {ok:true,result:await provider.create(plan)};
      if(step==='enable')return {ok:true,result:await provider.enable(plan,id??'')};
      return {ok:false,code:'SUBSCRIPTION_STEP_INVALID'};
    }catch(error){return {ok:false,code:error instanceof ApiError?error.code:'SUBSCRIPTION_REQUEST_FAILED'};}
  }
}
export default {fetch:()=>new Response('Not found',{status:404})};
