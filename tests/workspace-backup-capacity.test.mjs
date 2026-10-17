import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createWorkspace} from '../src/core/workflow.mjs';
import {buildWorkspaceBackup,readWorkspaceBackup,workspaceBackupPreview} from '../src/core/workspace-backup.mjs';
import {BACKUP_LIMITS,MAX_WORKSPACE_BACKUP_BYTES} from '../public/workspace-backup-limits.js';

const execute=promisify(execFile),at='2026-10-16T12:00:00.000Z';
const ledgers=()=>({capture:'coherent-sqlite-transaction',artifactSubscriptions:[],artifactSubscriptionAttempts:[],artifactEvents:[],artifactEventAttempts:[],artifactDeliveries:[]});
function source(projects=0){
  const workspace={...createWorkspace({id:'bounded-capacity',provider:'cloudflare-artifacts'}),projects:{}};
  for(let i=0;i<projects;i++){
    const id=crypto.randomUUID();workspace.projects[id]={id,name:'Repository '+i,repositoryName:'repo-'+i,defaultBranch:'main',mainCommit:'a'.repeat(40),kind:'artifacts',acceptingWork:true,policyVersion:1};
  }
  return {workspace,revision:1,repositories:{},forks:{},operations:{},jobs:{},checkPolicies:{}};
}
test('complete current-repository capacity exports all 32 records and refuses the next without truncation',async()=>{
  const snapshot=source(BACKUP_LIMITS.currentProjects),before=structuredClone(snapshot),archive=await buildWorkspaceBackup(snapshot,at,ledgers());
  const preview=workspaceBackupPreview(archive);assert.equal(preview.counts.currentProjects,32);assert.equal(preview.counts.resources,32);
  assert.deepEqual(await readWorkspaceBackup(JSON.stringify(archive),archive.sha256),archive);assert.deepEqual(snapshot,before);
  const extra=Object.values(source(1).workspace.projects)[0];snapshot.workspace.projects[extra.id]=extra;
  await assert.rejects(buildWorkspaceBackup(snapshot,at,ledgers()),error=>error.code==='WORKSPACE_BACKUP_INVALID'&&/currentProjects limit/.test(error.message));
  assert.equal(Object.keys(snapshot.workspace.projects).length,33);
});
test('offline CLI cold round-trip admits complete metadata above 1 MiB and refuses files above the shared byte cap',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'projects-backup-capacity-'));
  t.after(async()=>{assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));assert.ok(path.basename(root).startsWith('projects-backup-capacity-'));await rm(root,{recursive:true,force:true});});
  const snapshot=source();snapshot.workspace.events=Array.from({length:4000},()=>({id:crypto.randomUUID(),at,type:'workspace.observed',message:'x'.repeat(300)}));
  const archive=await buildWorkspaceBackup(snapshot,at,ledgers()),text=JSON.stringify(archive);assert.ok(Buffer.byteLength(text)>1024*1024);assert.ok(Buffer.byteLength(text)<MAX_WORKSPACE_BACKUP_BYTES);
  const file=path.join(root,'workspace.json'),sources=path.join(root,'sources.json'),bundle=path.join(root,'package'),restored=path.join(root,'restored');
  await writeFile(file,text);await writeFile(sources,'{}');
  const command=(...args)=>execute(process.execPath,['scripts/workspace-bundle.mjs',...args],{windowsHide:true,timeout:20000,maxBuffer:1024*1024});
  const exported=JSON.parse((await command('export',file,archive.sha256,sources,bundle)).stdout);assert.equal(exported.resources,0);
  await command('restore',bundle,exported.manifestSha256,archive.payload.workspace.id,restored);
  assert.deepEqual(await readWorkspaceBackup(await readFile(path.join(restored,'workspace.json'),'utf8'),archive.sha256),archive);
  const tooLarge=path.join(root,'too-large.json'),refused=path.join(root,'must-not-exist');await writeFile(tooLarge,'x'.repeat(MAX_WORKSPACE_BACKUP_BYTES+1));
  await assert.rejects(command('export',tooLarge,archive.sha256,sources,refused));await assert.rejects(access(refused));
});
