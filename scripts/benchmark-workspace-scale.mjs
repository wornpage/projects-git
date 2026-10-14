import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {execFileSync,spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {WorkspaceStore} from '../src/cloudflare/workspace-store.ts';
import {HostedController} from '../src/cloudflare/controller.ts';
import {parseWorkspacePage} from '../public/workspace-page.js';
import {scaleSnapshot} from '../tests/helpers/workspace-scale.mjs';
import {testAuthority} from '../tests/helpers/hosted-authority.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=Object.fromEntries(process.argv.slice(2).map(arg=>{const split=arg.indexOf('=');assert(split>2,'Use --name=value arguments');return [arg.slice(2,split),arg.slice(split+1)];}));
const out=path.resolve(args.out??'');
assert(args.out&&path.isAbsolute(args.out),'Supply a new absolute --out directory.');
const samples=Number(args.samples??7),warmup=Number(args.warmup??2),burst=Number(args.burst??4);
assert(Number.isInteger(samples)&&samples>=3&&samples<=50);
assert(Number.isInteger(warmup)&&warmup>=0&&warmup<=5);
assert(Number.isInteger(burst)&&burst>=1&&burst<=16);
const digest=value=>createHash('sha256').update(value).digest('hex');
const json=value=>JSON.stringify(value,null,2)+'\n';
const percentile=(values,p)=>[...values].sort((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*p)-1)];
const summarize=values=>({samples:values.length,min:Math.min(...values),median:percentile(values,.5),p95:percentile(values,.95),max:Math.max(...values)});

function fixture(groups,shape){
  const snapshot=scaleSnapshot(groups),workspace=snapshot.workspace;
  workspace.name='Synthetic local benchmark';
  if(shape==='many-projects')return snapshot;
  assert.equal(shape,'one-project');
  const projects=Object.keys(workspace.projects),projectId=projects[0],project=workspace.projects[projectId];
  const taskProjects=new Map(workspace.tasks.map(task=>[task.id,task.projectId]));
  const rewrite=(value,oldProject)=>{
    if(typeof value==='string')return projects.includes(value)?projectId:/^[a-f0-9]{40}$/.test(value)?digest(oldProject+':'+value).slice(0,40):value;
    if(Array.isArray(value))return value.map(item=>rewrite(item,oldProject));
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,rewrite(item,oldProject)]));
    return value;
  };
  workspace.tasks=workspace.tasks.map(task=>({...rewrite(task,task.projectId),repositoryName:project.repositoryName,repositoryKey:projectId}));
  workspace.runs=workspace.runs.map(run=>rewrite(run,taskProjects.get(run.taskId)));
  workspace.events=workspace.events.map(event=>rewrite(event,event.projectId??taskProjects.get(event.taskId)??projectId));
  snapshot.operations=Object.fromEntries(Object.entries(snapshot.operations).map(([key,value])=>[key,rewrite(value,value.projectId??taskProjects.get(value.taskId)??projectId)]));
  snapshot.repositories=Object.fromEntries(workspace.tasks.map(task=>[task.id,project.repositoryName]));
  workspace.projects={[projectId]:{...rewrite(project,projects.at(-1)),id:projectId,name:'One project with retained history'}};
  return snapshot;
}

if(!args.case){
  const groups=(args.groups??'10,100,500').split(',').map(Number);
  assert(groups.every(n=>Number.isInteger(n)&&n>=1&&n<=5000));
  const shapes=(args.shapes??'many-projects,one-project').split(',');
  assert(shapes.every(s=>['many-projects','one-project'].includes(s)));
  await mkdir(out,{recursive:false});
  const source=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',windowsHide:true}).trim();
  const productionDiff=execFileSync('git',['diff','--binary','HEAD','--','src','public'],{cwd:root,windowsHide:true});
  const sources={};for(const file of ['scripts/benchmark-workspace-scale.mjs','tests/helpers/workspace-scale.mjs','src/cloudflare/workspace-store.ts','src/cloudflare/controller.ts','src/core/workflow.mjs'])sources[file]=digest(await readFile(path.join(root,file)));
  const manifest={kind:'local-node-sqlite-control-plane-benchmark',source,productionDiffSha256:digest(productionDiff),productionDiffBytes:productionDiff.length,sources,groups,shapes,samples,warmup,burst,
    fixture:'Synthetic retained tasks, candidates, reports and operation receipts; eight candidates per group. One-project shape has distinct historical bases per group.',
    units:'Candidates are retained records, not measured merged changes. Read/write operations and queued task creations are measured separately.',
    runtime:{node:process.version,platform:process.platform,arch:process.arch,cpu:os.cpus()[0].model,logicalCpus:os.cpus().length,totalMemoryBytes:os.totalmem()},
    boundaries:{local:true,providerCalls:0,hosted:false,realGitOperations:0,modelCalls:0,mergeThroughputMeasured:false},
    timing:'Warmup excluded. SQL durations are nested within store read/write durations, not additive. Response serialization is included in page/task requests. Each case uses a fresh process and SQLite file with WAL/NORMAL.',
    at:new Date().toISOString()};
  await writeFile(path.join(out,'manifest.json'),json(manifest),{flag:'wx'});
  await writeFile(path.join(out,'production.patch'),productionDiff,{flag:'wx'});
  const results=[];
  for(const shape of shapes)for(const group of groups){
    const key=shape+'-'+group;
    const started=Date.now();
    const child=spawnSync(process.execPath,['--expose-gc','--max-old-space-size=4096',fileURLToPath(import.meta.url),'--out='+out,'--case='+key,'--shape='+shape,'--groups='+group,'--samples='+samples,'--warmup='+warmup,'--burst='+burst],{cwd:root,windowsHide:true,encoding:'utf8',timeout:240000,maxBuffer:4*1024*1024});
    await writeFile(path.join(out,key+'.log'),child.stdout+'\n'+child.stderr,{flag:'wx'});
    const status={key,exitCode:child.status,signal:child.signal,error:child.error?.message??null,elapsedMs:Date.now()-started};
    results.push(status);await writeFile(path.join(out,'cases.json'),json(results));
    console.log(JSON.stringify(status));
    if(child.status!==0)continue;
    const report=JSON.parse(await readFile(path.join(out,key+'.json'),'utf8'));
    console.log(JSON.stringify({key,counts:report.counts,phases:report.phases.map(p=>({name:p.name,medianMs:p.ms.median,readMs:p.readMs.median,writeMs:p.writeMs.median,presentationMs:p.presentationMs.median}))}));
  }
  process.exitCode=results.some(r=>r.exitCode!==0)?1:0;
}else{
  const groups=Number(args.groups),shape=args.shape,snapshot=fixture(groups,shape);
  const db=new DatabaseSync(path.join(out,args.case+'.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL');
  let measured=false,stats;
  const reset=()=>stats={queries:0,rows:0,sqlMs:0,readMs:0,writeMs:0,readCalls:0,writeCalls:0,presentationMs:0};
  reset();
  const storage={sql:{exec(sql,...values){
    const start=performance.now(),rows=db.prepare(sql).all(...values);
    if(measured){stats.queries++;stats.rows+=rows.length;stats.sqlMs+=performance.now()-start;}
    return {toArray:()=>rows,one(){assert.equal(rows.length,1);return rows[0];}};
  }},transactionSync(fn){db.exec('BEGIN');try{const result=fn();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}}};
  const store=new WorkspaceStore(storage,'workspace-scale');
  const seedStart=performance.now();store.write(snapshot,0);const seedMs=performance.now()-seedStart;
  const counts={projects:Object.keys(snapshot.workspace.projects).length,tasks:snapshot.workspace.tasks.length,candidates:snapshot.workspace.runs.length,operationReceipts:Object.keys(snapshot.operations).length,
    storedRecords:db.prepare('SELECT count(*) AS n FROM workspace_records').get().n,storedDataBytes:db.prepare('SELECT sum(length(CAST(data AS BLOB))) AS n FROM workspace_records').get().n};
  const originalRunHash=digest(JSON.stringify(snapshot.workspace.runs));
  const originalOperations=Object.entries(snapshot.operations).map(([key,value])=>[key,digest(JSON.stringify(value))]);
  const originalRead=store.read.bind(store),originalWrite=store.write.bind(store);
  store.read=()=>{const start=performance.now();try{return originalRead();}finally{if(measured){stats.readCalls++;stats.readMs+=performance.now()-start;}}};
  store.write=(...params)=>{const start=performance.now();try{return originalWrite(...params);}finally{if(measured){stats.writeCalls++;stats.writeMs+=performance.now()-start;}}};
  let providerCalls=0;
  const controller=new HostedController(store,{get(){providerCalls++;throw Error('A benchmark must not call Artifacts.');}},testAuthority('workspace-scale'));
  const originalWorkspace=controller.workspace.bind(controller);
  controller.workspace=(...params)=>{const start=performance.now();try{return originalWorkspace(...params);}finally{if(measured)stats.presentationMs+=performance.now()-start;}};
  const phases=[];let created=0,key=0,lastInput,lastKey;
  const projectId=Object.keys(snapshot.workspace.projects)[0],taskId=snapshot.workspace.tasks[0].id;
  async function phase(name,fn,prepare=()=>{}){
    const observations=[];
    for(let i=-warmup;i<samples;i++){
      measured=false;const input=prepare(i);reset();
      const cpu=process.cpuUsage(),start=performance.now();measured=true;
      try{await fn(input,i);}finally{measured=false;}
      const ms=performance.now()-start,usage=process.cpuUsage(cpu);
      if(i>=0)observations.push({ms,cpuMs:(usage.user+usage.system)/1000,...stats});
    }
    const summary={name};for(const metric of Object.keys(observations[0]))summary[metric]=summarize(observations.map(item=>item[metric]));
    phases.push({...summary,observations});
    await writeFile(path.join(out,args.case+'.partial.json'),json({counts,phases,memory:process.memoryUsage()}));
    console.log(JSON.stringify({phase:name,medianMs:summary.ms.median,counts}));
    global.gc?.();
  }
  await phase('full-snapshot-read',()=>store.read());
  await phase('one-record-write',value=>store.write(value,value.revision-1),i=>{const value=store.read();value.revision++;value.workspace.tasks.find(t=>t.id===taskId).title='Synthetic edit '+i;return value;});
  await phase('project-page',()=>{const page=store.readPage(parseWorkspacePage('limit=10&offset=0'));const response={...controller.workspace(page.snapshot,page.capacity),page:page.page};assert(Object.keys(response.projects).length<=10);JSON.stringify(response);});
  await phase('queue-one-task',async()=>{
    const requestKey='bench-'+(++key),input={source:'project',projectId,tasks:[{title:'Synthetic queued task '+key,purpose:'Measure local state work without executing code.',criteria:['Retain one task and operation receipt.'],owner:'Scripted benchmark owner'}]};
    const result=await controller.createTasks(input,requestKey);assert.equal(result.replayed,false);assert.equal(result.taskIds.length,1);created++;lastInput=input;lastKey=requestKey;JSON.stringify(result);
  });
  await phase('replay-same-task',async()=>{const result=await controller.createTasks(lastInput,lastKey);assert.equal(result.replayed,true);JSON.stringify(result);});
  const burstStart=performance.now(),latencies=[];
  await Promise.all(Array.from({length:burst},async(_,index)=>{const start=performance.now(),result=await controller.createTasks({source:'project',projectId,tasks:[{title:'Synthetic burst '+index,purpose:'Measure a local concurrent arrival burst.',criteria:['Create once.'],owner:'Scripted benchmark owner'}]},'burst-'+index);assert.equal(result.replayed,false);created++;JSON.stringify(result);latencies.push(performance.now()-start);}));
  const burstMs=performance.now()-burstStart;
  const final=store.read();
  assert.equal(final.workspace.tasks.length,counts.tasks+created);
  assert.equal(final.workspace.runs.length,counts.candidates);
  assert.equal(Object.keys(final.operations).length,counts.operationReceipts+created);
  assert.equal(digest(JSON.stringify(final.workspace.runs)),originalRunHash);
  for(const [id,hash]of originalOperations)assert.equal(digest(JSON.stringify(final.operations[id])),hash);
  assert.equal(providerCalls,0);
  const report={shape,groups,counts,seedMs,phases,burst:{arrivals:burst,completed:burst,elapsedMs:burstMs,latencyMs:summarize(latencies),taskCreationsPerSecond:burst*1000/burstMs},
    correctness:{createdTasks:created,oldCandidatesUnchanged:true,oldOperationReceiptsUnchanged:true,duplicateTasks:0,providerCalls},memory:process.memoryUsage(),finalRevision:final.revision};
  db.close();await writeFile(path.join(out,args.case+'.json'),json(report),{flag:'wx'});
}
