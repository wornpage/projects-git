import test from 'node:test';
import assert from 'node:assert/strict';
import {createProjectsGitWebMcp,PROJECTS_GIT_WEBMCP_TOOLS} from '../public/webmcp.js';
import {projectOperationalMetrics} from '../src/core/operational-metrics.mjs';

const WORKSPACE='workspace-private',PROJECT='10000000-0000-4000-8000-000000000001',TASK='20000000-0000-4000-8000-000000000002',RUN='30000000-0000-4000-8000-000000000003';
const BASE='a'.repeat(40),HEAD='b'.repeat(40);
function context(){return {demo:false,workspace:{id:WORKSPACE,provider:'cloudflare-artifacts',authentication:{mode:'cloudflare-access',principal:{kind:'owner',id:'owner-subject',issuer:'https://fixture.cloudflareaccess.com',workspaceId:WORKSPACE}}}};}
function catalog(){return {workspaceId:WORKSPACE,query:'',revision:7,total:1,matched:1,offset:0,limit:20,previousOffset:null,nextOffset:null,scope:'accessible-project-names',items:[{id:PROJECT,name:'Private repository',taskCount:1,candidateCount:1}]};}
function page(criteria=['Expected result']){return {id:WORKSPACE,provider:'cloudflare-artifacts',sourceRevision:7,version:4,authentication:{SECRET_AUTH:'excluded'},projects:{[PROJECT]:{id:PROJECT,name:'Private repository',mainCommit:BASE,defaultBranch:'main',acceptingWork:true,codeConnected:true}},
  tasks:[{id:TASK,projectId:PROJECT,title:'Retained task',purpose:'Inspect status',criteria,status:'review',createdAt:'2026-10-16T00:00:00.000Z',revision:2,baseCommit:BASE,acceptedRunId:null,mergedCommit:null,dependsOn:[]}],
  runs:[{id:RUN,taskId:TASK,label:'Candidate',agent:'external',origin:'external-agent',status:'awaiting_review',baseCommit:BASE,headCommit:HEAD,startedAt:'2026-10-16T00:01:00.000Z',finishedAt:'2026-10-16T00:02:00.000Z',changedFiles:['src/app.js'],diff:'SECRET_DIFF',agentIdentity:{id:'SECRET_IDENTITY'},summary:'Retained candidate summary',evidence:null,review:null,codeReview:null}],events:[{message:'SECRET_EVENT'}],
  page:{offset:0,limit:1,totalProjects:1,revision:7,nextOffset:null,previousOffset:null,taskNumbers:{[TASK]:1},workspaceTotals:{projects:1,tasks:1,runs:1},scope:'loaded-projects'}};}
function metrics(){return projectOperationalMetrics({revision:7,workspace:{id:WORKSPACE,projects:{[PROJECT]:{id:PROJECT}},
  tasks:[{id:TASK,projectId:PROJECT}],runs:[{id:RUN,taskId:TASK,agent:'model',origin:'model',status:'assigned',execution:{model:'fixture-model',requests:[]}}],events:[]},operations:{}},PROJECT,'2026-10-16T00:00:00.000Z');}
function metricsWithUnknownFields(){
  const value=metrics(),secret='SECRET_METRICS_DETAIL';value.unexpectedPrivateField=secret;value.counts.unexpectedPrivateField=secret;
  for(const row of Object.values(value.phases)){row.unexpectedPrivateField=secret;row.outcomes.unexpectedPrivateField=0;
    if(row.coverage)row.coverage.unexpectedPrivateField=secret;}
  value.phases.unexpectedPhase={unexpectedPrivateField:secret};
  value.modelProvenance.unexpectedPrivateField=secret;for(const model of value.modelProvenance.models)model.unexpectedPrivateField=secret;
  value.usage.unexpectedPrivateField=secret;value.cost.unexpectedPrivateField=secret;value.flags.unexpectedPrivateField=secret;return value;
}
class NativeModelContext{
  constructor(){this.tools=new Map([['existing_other_tool',{name:'existing_other_tool'}]]);this.calls=[];this.fail=null;this.wait=null;}
  async registerTool(tool,{signal}){this.calls.push({tool,signal});if(this.wait?.name===tool.name)await this.wait.promise;if(this.fail===tool.name)throw Error('scripted registration failure');
    if(signal.aborted){const error=Error('aborted');error.name='AbortError';throw error;}this.tools.set(tool.name,tool);
    signal.addEventListener('abort',()=>{if(this.tools.get(tool.name)===tool)this.tools.delete(tool.name);},{once:true});
  }
}
function harness({ctx=context(),modelContext=new NativeModelContext(),api}={}){
  let generation=0,current=ctx,connected=true;const paths=[],statuses=[],listeners={};
  const responses={catalog:catalog(),page:page(),metrics:metrics()};
  const request=api??(async path=>{paths.push(path);if(path.startsWith('/api/projects/catalog'))return structuredClone(responses.catalog);
    if(path.startsWith('/api/workspace?'))return structuredClone(responses.page);if(path===`/api/projects/${PROJECT}/metrics`)return structuredClone(responses.metrics);throw Error('Unexpected path '+path);});
  const manager=createProjectsGitWebMcp({document:{modelContext},getContext:()=>current,captureSession:()=>{const saved=generation;return()=>saved===generation;},api:request,
    isConnected:()=>connected,onStatus:value=>statuses.push(value),pageWindow:{addEventListener:(name,fn)=>{listeners[name]=fn;}}});
  return {manager,modelContext,paths,statuses,responses,listeners,setContext:value=>{current=value;generation++;},disconnect:()=>{connected=false;generation++;},nextSession:()=>generation++};
}
const parsed=value=>JSON.parse(value);

test('native async registration exposes exactly four annotated same-origin read tools',async()=>{
  const h=harness();assert.equal(await h.manager.sync(),true);assert.deepEqual([...h.modelContext.tools.keys()].sort(),['existing_other_tool',...PROJECTS_GIT_WEBMCP_TOOLS].sort());
  for(const name of PROJECTS_GIT_WEBMCP_TOOLS){const tool=h.modelContext.tools.get(name);assert.equal(tool.inputSchema.additionalProperties,false);
    assert.deepEqual(tool.annotations,{readOnlyHint:true,untrustedContentHint:true,consequentialHint:false});}
  await h.manager.sync();assert.equal(h.modelContext.calls.length,4);
  h.nextSession();assert.equal(await h.manager.sync(),true);assert.equal(h.modelContext.calls.length,8);assert.equal(h.modelContext.tools.size,5);
  assert.equal(h.manager.status().phase,'available');assert.match(h.statuses.at(-1).message,/Four read-only/);
});

test('tools use only fixed GET routes and return safe complete denominators',async()=>{
  const h=harness();await h.manager.sync();const repositories=parsed(await h.modelContext.tools.get(PROJECTS_GIT_WEBMCP_TOOLS[0]).execute({q:'',offset:0,limit:20},{}));
  assert.deepEqual(h.paths,['/api/projects/catalog?q=&offset=0&limit=20']);assert.equal(repositories.page.totalRepositories,1);assert.equal(repositories.repositories[0].candidateCount,1);
  const project=parsed(await h.modelContext.tools.get(PROJECTS_GIT_WEBMCP_TOOLS[1]).execute({projectId:PROJECT,at:7},{}));
  assert.equal(h.paths[1],`/api/workspace?limit=1&project=${PROJECT}&at=7`);assert.equal(project.page.scope,'complete-selected-project');assert.deepEqual(project.counts,{tasks:1,candidates:1});
  const task=parsed(await h.modelContext.tools.get(PROJECTS_GIT_WEBMCP_TOOLS[2]).execute({taskId:TASK},{}));
  assert.equal(h.paths[2],`/api/workspace?limit=1&task=${TASK}`);assert.equal(task.task.purpose,'Inspect status');assert.equal(task.candidates.length,1);
  assert.equal(task.candidates[0].changedFiles,1);assert.ok(!JSON.stringify(task).includes('src/app.js'));assert.ok(!Object.hasOwn(task.candidates[0],'agentIdentity'));assert.ok(!JSON.stringify(task).includes('SECRET_'));
  const operational=parsed(await h.modelContext.tools.get(PROJECTS_GIT_WEBMCP_TOOLS[3]).execute({projectId:PROJECT},{}));
  assert.equal(h.paths[3],`/api/projects/${PROJECT}/metrics`);assert.equal(operational.scope,'complete-repository-history');assert.equal(operational.cost.actual,null);
  assert.ok(h.paths.every(path=>path.startsWith('/api/')));assert.ok(h.paths.every(path=>!path.includes('http')&&!path.includes('..')));
});

test('closed schemas and invalid arguments fail before I/O',async()=>{
  const h=harness();await h.manager.sync();for(const [name,args] of [[PROJECTS_GIT_WEBMCP_TOOLS[0],{limit:0}],[PROJECTS_GIT_WEBMCP_TOOLS[0],{url:'https://elsewhere.invalid'}],
    [PROJECTS_GIT_WEBMCP_TOOLS[1],{projectId:'bad'}],[PROJECTS_GIT_WEBMCP_TOOLS[2],{taskId:TASK,command:'git push'}],[PROJECTS_GIT_WEBMCP_TOOLS[3],{}]])
    await assert.rejects(h.modelContext.tools.get(name).execute(args,{}));assert.deepEqual(h.paths,[]);
});

test('operational metrics recursively omit unknown backend fields and reject unknown outcomes',async()=>{
  const value=metricsWithUnknownFields();for(const row of Object.values(value.phases))if(row.outcomes)delete row.outcomes.unexpectedPrivateField;
  const h=harness();h.responses.metrics=value;await h.manager.sync();const result=parsed(await h.modelContext.tools.get(PROJECTS_GIT_WEBMCP_TOOLS[3]).execute({projectId:PROJECT},{}));
  assert.ok(!JSON.stringify(result).includes('SECRET_METRICS_DETAIL'));assert.ok(!Object.hasOwn(result,'unexpectedPrivateField'));
  assert.ok(!Object.hasOwn(result.counts,'unexpectedPrivateField'));assert.ok(!Object.hasOwn(result.phases,'unexpectedPhase'));
  for(const row of Object.values(result.phases)){assert.ok(!Object.hasOwn(row,'unexpectedPrivateField'));if(row.coverage)assert.ok(!Object.hasOwn(row.coverage,'unexpectedPrivateField'));}
  assert.ok(!Object.hasOwn(result.modelProvenance,'unexpectedPrivateField'));assert.ok(result.modelProvenance.models.every(model=>!Object.hasOwn(model,'unexpectedPrivateField')));
  for(const section of ['usage','cost','flags'])assert.ok(!Object.hasOwn(result[section],'unexpectedPrivateField'));

  const invalid=metricsWithUnknownFields(),rejected=harness();rejected.responses.metrics=invalid;await rejected.manager.sync();
  await assert.rejects(rejected.modelContext.tools.get(PROJECTS_GIT_WEBMCP_TOOLS[3]).execute({projectId:PROJECT},{}),/incomplete/);
});

test('backend ACL denial remains a denial and exposes no fabricated result',async()=>{
  let calls=0;const h=harness({api:async()=>{calls++;throw Object.assign(Error('Repository access denied.'),{status:403,code:'REPOSITORY_ACCESS_DENIED'});}});await h.manager.sync();
  await assert.rejects(h.modelContext.tools.get(PROJECTS_GIT_WEBMCP_TOOLS[3]).execute({projectId:PROJECT},{}),error=>error.status===403);assert.equal(calls,1);
});

test('session, principal, connection, generation and caller aborts suppress pending data',async()=>{
  for(const change of ['session','principal','connection','disable','caller']){
    const pending=Promise.withResolvers(),caller=new AbortController(),h=harness({api:()=>pending.promise});await h.manager.sync();const tool=h.modelContext.tools.get(PROJECTS_GIT_WEBMCP_TOOLS[0]),result=tool.execute({}, {signal:caller.signal});
    if(change==='session')h.nextSession();if(change==='principal'){const next=context();next.workspace.authentication.principal.id='other';h.setContext(next);}
    if(change==='connection')h.disconnect();if(change==='disable')h.manager.disable();if(change==='caller')caller.abort();pending.resolve(catalog());
    await assert.rejects(result,error=>error.name==='AbortError');
  }
  const rejected=Promise.withResolvers(),stale=harness({api:()=>rejected.promise});await stale.manager.sync();const result=stale.modelContext.tools.get(PROJECTS_GIT_WEBMCP_TOOLS[0]).execute({},{});
  stale.nextSession();rejected.reject(Error('late private backend detail'));await assert.rejects(result,error=>error.name==='AbortError');
});

test('partial registration failure and delayed generation abort leave no owned tools behind',async()=>{
  const failing=new NativeModelContext();failing.fail=PROJECTS_GIT_WEBMCP_TOOLS[2];const first=harness({modelContext:failing});assert.equal(await first.manager.sync(),false);
  assert.deepEqual([...failing.tools.keys()],['existing_other_tool']);assert.equal(first.manager.status().phase,'unavailable');
  const delayed=new NativeModelContext(),gate=Promise.withResolvers();delayed.wait={name:PROJECTS_GIT_WEBMCP_TOOLS[1],promise:gate.promise};const second=harness({modelContext:delayed}),old=second.manager.sync();
  await new Promise(resolve=>setImmediate(resolve));second.manager.disable();const next=context();next.workspace.authentication.principal.id='new-owner';second.setContext(next);const renewed=second.manager.sync();gate.resolve();
  assert.equal(await old,false);assert.equal(await renewed,true);assert.deepEqual([...delayed.tools.keys()].sort(),['existing_other_tool',...PROJECTS_GIT_WEBMCP_TOOLS].sort());
});

test('demo, unsupported, unauthenticated and disconnected pages register nothing; pagehide removes only owned tools',async()=>{
  for(const ctx of [{...context(),demo:true},{workspace:{id:WORKSPACE,provider:'local-git'}},{workspace:{id:WORKSPACE,provider:'cloudflare-artifacts'}},null]){
    const h=harness({ctx});assert.equal(await h.manager.sync(),false);assert.equal(h.modelContext.calls.length,0);assert.deepEqual([...h.modelContext.tools.keys()],['existing_other_tool']);
  }
  const unsupported=harness({modelContext:{}});assert.equal(await unsupported.manager.sync(),false);assert.equal(unsupported.manager.status().phase,'unsupported');
  const active=harness();await active.manager.sync();active.listeners.pagehide();assert.deepEqual([...active.modelContext.tools.keys()],['existing_other_tool']);
  assert.equal(await active.manager.sync(),false);assert.deepEqual([...active.modelContext.tools.keys()],['existing_other_tool']);
});

test('oversized complete results fail instead of truncating collections or totals',async()=>{
  const h=harness();h.responses.page=page(Array.from({length:600},()=> 'x'.repeat(500)));await h.manager.sync();
  await assert.rejects(h.modelContext.tools.get(PROJECTS_GIT_WEBMCP_TOOLS[2]).execute({taskId:TASK},{}),/exceeds 256 KiB/);
  assert.equal(h.paths.length,1);
});
