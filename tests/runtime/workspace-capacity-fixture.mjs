// Local-only qualification Worker. No account routes, credentials or provider calls.
import {WorkspaceCoordinator} from '../../src/cloudflare/index.ts';
import {scaleSnapshot} from '../helpers/workspace-scale.mjs';
import {testAuthority} from '../helpers/hosted-authority.mjs';

export class CapacityWorkspace extends WorkspaceCoordinator {
  constructor(ctx,env){super(ctx,env);this.fullReads=0;const read=this.store.read.bind(this.store);this.store.read=()=>{this.fullReads++;return read();};}
  async seed(){
    const current=this.store.identity();if(!current.empty)throw Error('This fixture is already seeded.');
    const snapshot=scaleSnapshot();snapshot.revision=current.revision+1;this.store.write(snapshot,current.revision);return this.stats();
  }
  stats(){return {fixture:'synthetic histories; local Workerd/SQLite; no provider calls',revision:this.store.identity().revision,
    counts:Object.fromEntries(this.ctx.storage.sql.exec('SELECT kind,count(*) AS n FROM workspace_records GROUP BY kind').toArray().map(row=>[row.kind,row.n]))};}
  restart(){this.ctx.abort('Controlled local capacity fixture restart');}
  async measuredApi(call){this.fullReads=0;const response=await this.api(call);response.headers.set('X-Fixture-Full-Reads',String(this.fullReads));return response;}
}

export default {async fetch(request,env){
  const url=new URL(request.url),stub=env.WORKSPACES.getByName(env.WORKSPACE_ID+'/'+env.FIXTURE_INSTANCE);
  if(url.pathname==='/__fixture/seed'&&request.method==='POST')return Response.json(await stub.seed());
  if(url.pathname==='/__fixture/stats')return Response.json(await stub.stats());
  if(url.pathname==='/__fixture/restart'&&request.method==='POST'){await stub.restart();return new Response(null,{status:204});}
  if(url.pathname.startsWith('/api/')){
    const authority=testAuthority(env.WORKSPACE_ID,request.headers.get('X-Fixture-Agent')||undefined);
    // Workerd module evaluation has no request clock. Timestamp this explicitly
    // scripted principal inside the request, without weakening production expiry checks.
    authority.principal.issuedAt=Math.floor(Date.now()/1000)-1;authority.principal.expiresAt=authority.principal.issuedAt+3600;
    return stub.measuredApi({path:url.pathname,search:url.search,method:request.method,key:request.headers.get('Idempotency-Key')??'',body:request.method==='POST'?await request.json():{},principal:authority.principal,policy:authority.policy,forbiddenSecrets:[]});
  }
  return env.ASSETS.fetch(request);
}};
