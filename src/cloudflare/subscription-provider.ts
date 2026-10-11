import {ApiError} from './security.ts';
import {subscriptionPlan} from './artifact-subscriptions.ts';
import type {SubscriptionPlan,SubscriptionProvider,RegisteredSubscription} from './artifact-subscriptions.ts';

export interface RegistrationScope {accountId:string;namespace:string;queueId:string;workspaceId:string;ownerKey:string}
type ProviderRecord={id:string;name:string;enabled:boolean;source:{type:string;namespace:string;repo_name:string;name?:string};destination:{type:string;queue_id:string};events:string[]};
function checked(value:unknown,plan:SubscriptionPlan):RegisteredSubscription {
  if(!value||typeof value!=='object')throw new ApiError(502,'SUBSCRIPTION_SHAPE_INVALID','The provider did not return a subscription.');
  const row=value as ProviderRecord;
  if(!/^[a-f0-9-]{16,64}$/.test(row.id)||row.name!==plan.name||typeof row.enabled!=='boolean'
    ||JSON.stringify(row.events)!=='["pushed"]'||!row.source||Object.keys(row.source).some(key=>!['name','namespace','repo_name','type'].includes(key))
    ||(row.source.name!==undefined&&(typeof row.source.name!=='string'||row.source.name.length>160))
    ||row.source.type!=='artifacts.repo'||row.source.namespace!==plan.namespace||row.source.repo_name!==plan.repositoryName
    ||!row.destination||Object.keys(row.destination).sort().join(',')!=='queue_id,type'||row.destination.type!=='queues.queue'||row.destination.queue_id!==plan.queueId)
    throw new ApiError(409,'SUBSCRIPTION_PROVIDER_MISMATCH','The provider subscription differs from the reserved repository, event or destination.');
  return {id:row.id,enabled:row.enabled};
}

/** Only the private registration Worker receives this account-scoped secret.
 * There is no repository/Git/Access permission, caller-supplied URL or raw API proxy. */
export class CloudflareSubscriptions implements SubscriptionProvider {
  private scope:RegistrationScope;
  private token:string;
  private request:typeof fetch;
  constructor(scope:RegistrationScope,token:string,request:typeof fetch=(input,init)=>fetch(input,init)){this.scope=scope;this.token=token;this.request=request;}
  private validate(plan:SubscriptionPlan){
    const expected=subscriptionPlan({...this.scope,repositoryName:plan.repositoryName});
    if(JSON.stringify(plan)!==JSON.stringify(expected)||!this.token)throw new ApiError(403,'SUBSCRIPTION_SCOPE_FORBIDDEN','Registration is restricted to the configured workspace owner and queue.');
  }
  private async api(path:string,method='GET',body?:unknown):Promise<{result:unknown;result_info?:{total_pages?:number}}>{
    const response=await this.request('https://api.cloudflare.com/client/v4/accounts/'+this.scope.accountId+'/event_subscriptions/subscriptions'+path,{
      method,redirect:'manual',signal:AbortSignal.timeout(10000),headers:{Authorization:'Bearer '+this.token,'Content-Type':'application/json'},
      ...(body===undefined?{}:{body:JSON.stringify(body)})});
    if(response.status>=300&&response.status<400)throw new ApiError(502,'SUBSCRIPTION_REDIRECT_REFUSED','The subscription provider redirected the request.');
    const reader=response.body?.getReader();if(!reader)throw new ApiError(502,'SUBSCRIPTION_RESPONSE_EMPTY','The subscription provider returned no result.');
    let size=0;const chunks:Uint8Array[]=[];
    try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>2097152){await reader.cancel();throw new ApiError(502,'SUBSCRIPTION_RESPONSE_LIMIT','The subscription response exceeded its limit.');}chunks.push(value);}}finally{reader.releaseLock();}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
    let data:{success?:boolean;result:unknown;result_info?:{total_pages?:number}};
    try{data=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(bytes));}catch{throw new ApiError(502,'SUBSCRIPTION_RESPONSE_INVALID','The subscription response was not valid JSON.');}
    if(!response.ok||data.success!==true){
      const refused=method==='POST'&&data.success===false&&[400,401,403,422].includes(response.status);
      throw new ApiError(502,refused?'SUBSCRIPTION_CREATE_REJECTED':'SUBSCRIPTION_PROVIDER_FAILED','The subscription provider did not confirm the request.');
    }
    return data;
  }
  async find(plan:SubscriptionPlan):Promise<RegisteredSubscription[]>{
    this.validate(plan);const result:RegisteredSubscription[]=[];
    for(let page=1;page<=10;page++){
      const data=await this.api('?per_page=100&page='+page);
      if(!Array.isArray(data.result)||data.result.length>100)throw new ApiError(502,'SUBSCRIPTION_LIST_INVALID','The provider returned an invalid subscription page.');
      for(const value of data.result)if(value?.name===plan.name)result.push(checked(value,plan));
      const pages=data.result_info?.total_pages;
      if(pages!==undefined&&(!Number.isSafeInteger(pages)||pages<0||pages>10))throw new ApiError(409,'SUBSCRIPTION_LIST_LIMIT','The account subscription inventory exceeds the supported bounded lookup.');
      if(pages!==undefined?page>=pages:data.result.length<100)return result;
    }
    throw new ApiError(409,'SUBSCRIPTION_LIST_LIMIT','The full subscription inventory could not be confirmed.');
  }
  async create(plan:SubscriptionPlan):Promise<RegisteredSubscription>{
    this.validate(plan);
    const data=await this.api('','POST',{name:plan.name,enabled:false,source:{type:'artifacts.repo',namespace:plan.namespace,repo_name:plan.repositoryName},destination:{type:'queues.queue',queue_id:plan.queueId},events:['pushed']});
    return checked(data.result,plan);
  }
  async enable(plan:SubscriptionPlan,id:string):Promise<RegisteredSubscription>{
    this.validate(plan);if(!/^[a-f0-9-]{16,64}$/.test(id))throw new ApiError(403,'SUBSCRIPTION_ID_INVALID','Use the retained provider subscription ID.');
    const existing=checked((await this.api('/'+id)).result,plan);
    if(existing.id!==id)throw new ApiError(409,'SUBSCRIPTION_PROVIDER_MISMATCH','The provider returned another subscription.');
    return existing.enabled?existing:checked((await this.api('/'+id,'PATCH',{enabled:true})).result,plan);
  }
}
