import {mkdir,readFile,writeFile,lstat,realpath,open,unlink,rm,readdir} from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {GitHubPublication,githubRepository,githubBranch} from './github-publication.mjs';
import {RepositoryRunner} from './repository-runner.mjs';
import {readOnlyGit} from './git-reader.mjs';
import {captureGitObjects,readGitObjects,installGitObjects} from './git-object-capsule.mjs';
import {validateBackupHandoff} from '../core/backup-records.mjs';
import {MAX_HANDOFF_BYTES} from '../core/handoff.mjs';
import {requirementsDigest} from '../core/check-definition.mjs';
import {independentReviewStatus} from '../../public/review-boundary.js';
import {createDeliveryState,openDeliveryState} from './durable-delivery-state.mjs';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sha=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const equal=(a,b)=>hash(a)===hash(b);
const requireThat=value=>{if(!value)throw Error('Hosted delivery source, approval or local state is invalid. No write was authorized.');};
const budget=()=>({remainingBytes:64*1024*1024,remainingArchiveBytes:64*1024*1024,remainingObjects:16384});
const canonical=value=>process.platform==='win32'?value.toLowerCase():value;
const samePath=(a,b)=>canonical(a)===canonical(b);
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const keys=['workspaceId','runId','baseCommit','headCommit','tree','handoffSha256'];
function journalGuard(state){const run=state.runs?.find(item=>item.id===state.expected?.runId),record=run?.publication;
  return {previewId:run?.publicationPreview?.id??null,approvalSha256:state.operatorApproval?.sha256??null,publicationId:record?.id??null,
    publicationPreviewId:record?.previewId??null,pushStartedAt:record?.pushStartedAt??null,prStartedAt:record?.prStartedAt??null};}
function validJournalTransition(before,after){
  if(before.publicationId!==null&&after.publicationId!==before.publicationId)return false;
  if(before.publicationPreviewId!==null&&after.publicationId!==null&&after.publicationPreviewId!==before.publicationPreviewId)return false;
  if(before.pushStartedAt!==null&&after.pushStartedAt!==before.pushStartedAt||before.prStartedAt!==null&&after.prStartedAt!==before.prStartedAt)return false;
  if(before.publicationId!==null&&before.approvalSha256!==null&&after.approvalSha256!==before.approvalSha256)return false;
  return true;
}

/** Closed nested schemas plus semantic bindings; a checksum remains historical, not authenticated authority. */
export async function hostedDeliverySource(text, expected) {
  requireThat(exact(expected,keys)&&typeof expected.workspaceId==='string'&&/^[A-Za-z0-9_.-]{1,100}$/.test(expected.workspaceId)
    &&uuid(expected.runId)&&sha(expected.baseCommit)&&sha(expected.headCommit)&&sha(expected.tree)&&digest(expected.handoffSha256));
  let handoff;try{handoff=JSON.parse(text);await validateBackupHandoff(handoff);}catch{requireThat(false);}
  requireThat(handoff.sha256===expected.handoffSha256);
  const {workspace,task,runs}=handoff.payload,run=runs.find(item=>item.id===expected.runId);
  requireThat(workspace.provider==='cloudflare-artifacts'&&workspace.id===expected.workspaceId&&uuid(task.id)&&uuid(task.projectId)
    &&new Set(runs.map(item=>item.id)).size===runs.length&&runs.every(item=>uuid(item.id)&&item.taskId===task.id&&!item.publication));
  requireThat(run&&task.status==='merged'&&run.status==='merged'&&task.acceptedRunId===run.id&&task.mergedCommit===run.headCommit
    &&run.headCommit===expected.headCommit&&task.baseCommit===expected.baseCommit&&run.baseCommit===task.baseCommit
    &&run.headCommit!==run.baseCommit&&task.owner&&task.ownerVersion>0&&task.revision>0&&!run.verificationPending);
  const evidence=run.evidence,proof=evidence?.verification,review=run.review,assessment=run.codeReview;
  requireThat(evidence?.verified===true&&evidence.source==='independent-sandbox-checks'&&evidence.commit===run.headCommit
    &&evidence.taskRevision===task.revision&&evidence.total>0&&evidence.passed===evidence.total&&evidence.exitCode===0
    &&evidence.checks.length===evidence.total&&evidence.checks.every(check=>check.passed===true));
  requireThat(proof?.kind==='repository-command-checks/v1'&&proof.tree===expected.tree&&proof.requirementsSha256===requirementsDigest(task)
    &&digest(proof.definitionSha256)&&digest(proof.verifierSha256)&&digest(proof.inputHandoffSha256)
    &&/^(?:[^\s]+@)?sha256:[a-f0-9]{64}$/.test(proof.image));
  const state={...workspace,tasks:[task],runs,projects:{[task.projectId]:{}}};
  requireThat(independentReviewStatus(state,run).passed&&uuid(assessment.id)&&assessment.contextId===hash(assessment.context)
    &&run.reviewAssignments.at(-1)?.contextId===assessment.contextId&&assessment.findings.every(finding=>finding.priority>1)
    &&review?.decision==='accept'&&review.headCommit===run.headCommit&&review.taskRevision===task.revision
    &&review.ownerVersion===task.ownerVersion&&review.codeReviewId===assessment.id);
  const owner=review.identity??review.policy?.enabledBy;
  requireThat(owner?.provider==='cloudflare-access'&&owner.kind==='owner'&&owner.workspaceId===workspace.id&&owner.id
    &&/^https:\/\/[a-z0-9][a-z0-9-]*\.cloudflareaccess\.com$/.test(owner.issuer)
    &&assessment.identity.issuer===owner.issuer&&assessment.identity.id!==owner.id
    &&(!review.policy||review.policy.enabled===true&&review.policy.mode==='checks-and-independent-review'&&review.policy.projectId===task.projectId));
  requireThat(run.changedFiles.length>0&&run.changedFiles.length<=100&&new Set(run.changedFiles).size===run.changedFiles.length);
  const binding={workspaceId:workspace.id,taskId:task.id,runId:run.id,headCommit:run.headCommit,baseCommit:task.baseCommit,
    taskRevision:task.revision,ownerVersion:task.ownerVersion,requirementsSha256:requirementsDigest(task),reviewSha256:hash(review),
    provenance:'historical-hosted-export',handoffSha256:handoff.sha256,tree:expected.tree,evidenceSha256:hash(evidence),assessmentSha256:hash(assessment)};
  return {handoff,state,task,run,binding};
}

async function ordinary(file,limit) {
  const info=await lstat(file);requireThat(info.isFile()&&!info.isSymbolicLink()&&info.size<=limit&&samePath(await realpath(file),file));
  const bytes=await readFile(file);requireThat(bytes.length<=limit);return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
}
async function directory(value) {
  requireThat(typeof value==='string'&&path.isAbsolute(value));const info=await lstat(value);
  requireThat(info.isDirectory()&&!info.isSymbolicLink()&&samePath(await realpath(value),value));return value;
}
async function exists(file,predicate){try{return predicate(await lstat(file));}catch(error){if(error.code==='ENOENT')return false;throw error;}}
async function privateTarget(target,source){
  requireThat(typeof target==='string'&&path.isAbsolute(target));
  const sourceRoot=await realpath(source),resolved=path.resolve(target),left=canonical(sourceRoot),right=canonical(resolved);
  requireThat(left!==right&&!right.startsWith(left+path.sep)&&!left.startsWith(right+path.sep));
  for(let parent=path.dirname(target);;parent=path.dirname(parent)){
    const parentInfo=await lstat(parent);requireThat(parentInfo.isDirectory()&&!parentInfo.isSymbolicLink()&&samePath(await realpath(parent),parent));
    try{await lstat(path.join(parent,'.git'));requireThat(false);}catch(error){if(error.code!=='ENOENT')throw error;}
    const bare=await exists(path.join(parent,'HEAD'),info=>info.isFile()&&!info.isSymbolicLink())
      &&await exists(path.join(parent,'objects'),info=>info.isDirectory()&&!info.isSymbolicLink())
      &&await exists(path.join(parent,'refs'),info=>info.isDirectory()&&!info.isSymbolicLink())
      &&await exists(path.join(parent,'config'),info=>info.isFile()&&!info.isSymbolicLink());
    requireThat(!bare);
    if(path.dirname(parent)===parent)break;
  }
}
async function fileDigest(file){const info=await lstat(file);requireThat(info.isFile()&&!info.isSymbolicLink()&&samePath(await realpath(file),file));return createHash('sha256').update(await readFile(file)).digest('hex');}
async function trustedStaging(repository,expectedConfig){
  await directory(repository);requireThat(await fileDigest(path.join(repository,'config'))===expectedConfig);
  const hooks=path.join(repository,'hooks'),hooksInfo=await lstat(hooks);requireThat(hooksInfo.isDirectory()&&!hooksInfo.isSymbolicLink()&&samePath(await realpath(hooks),hooks)&&(await readdir(hooks)).length===0);
  for(const file of ['config.worktree','commondir',path.join('objects','info','alternates'),path.join('objects','info','http-alternates')])
    requireThat(!await exists(path.join(repository,file),()=>true));
}
async function objectBinding(repository,source) {
  await directory(repository);const git=readOnlyGit(repository),{task,run,binding}=source;
  requireThat((await git(['rev-parse','--verify',run.headCommit+'^{tree}'])).trim()===binding.tree);
  await git(['merge-base','--is-ancestor',task.baseCommit,run.headCommit]);
  const inventory=async commit=>{
    const bytes=await git(['ls-tree','-r','-z','--full-tree',commit],{binary:true,maxBuffer:8*1024*1024}),result=new Map();
    for(const row of new TextDecoder('utf-8',{fatal:true}).decode(bytes).split('\0').filter(Boolean)){
      const match=/^([0-7]{6}) (blob|commit) ([a-f0-9]{40})\t(.+)$/.exec(row);
      requireThat(match&&!result.has(match[4]));result.set(match[4],{mode:match[1],type:match[2],oid:match[3]});
    }return result;
  };
  const [before,after]=await Promise.all([inventory(task.baseCommit),inventory(run.headCommit)]);
  const changes=[...new Set([...before.keys(),...after.keys()])].sort().filter(name=>!equal(before.get(name)??null,after.get(name)??null))
    .map(name=>({path:name,before:before.get(name)??null,after:after.get(name)??null}));
  requireThat(equal(changes.map(item=>item.path),[...run.changedFiles].sort()));
  return hash(changes);
}

/** Offline preparation only. Copy exact objects into a fresh bare repository; never checkout or import config/hooks. */
export async function prepareHostedDelivery({handoffText,expected,source,directory:target,repository}) {
  repository=githubRepository(repository);const validated=await hostedDeliverySource(handoffText,expected);
  await directory(source);await privateTarget(target,source);
  const objectChangesSha256=await objectBinding(source,validated),roots=[expected.baseCommit,expected.headCommit];
  const bytes=await captureGitObjects(roots,Object.fromEntries(roots.map(oid=>[oid,source])),budget());
  const objects=readGitObjects(bytes,roots,budget());
  await mkdir(target,{mode:0o700});await directory(target);
  const runner=new RepositoryRunner(target);await runner.initialize();const staged=path.join(target,'objects.git');
  await mkdir(staged,{mode:0o700});await runner.git(staged,['init','--bare']);await rm(path.join(staged,'hooks'),{recursive:true,force:true});await mkdir(path.join(staged,'hooks'),{mode:0o700});await installGitObjects(objects,staged);
  await runner.git(staged,['update-ref','refs/heads/source-base',expected.baseCommit,'0'.repeat(40)]);
  await runner.git(staged,['update-ref','refs/candidates/'+expected.runId,expected.headCommit,'0'.repeat(40)]);
  await runner.git(staged,['symbolic-ref','HEAD','refs/heads/source-base']);await runner.git(staged,['fsck','--strict','--full']);
  const stagedConfigSha256=await fileDigest(path.join(staged,'config'));await trustedStaging(staged,stagedConfigSha256);
  requireThat(await objectBinding(staged,validated)===objectChangesSha256);
  await writeFile(path.join(target,'handoff.json'),handoffText,{flag:'wx',mode:0o600});
  const state={format:'projects-git-hosted-delivery/v1',repository,expected,objectChangesSha256,stagedConfigSha256,operatorApproval:null,
    id:validated.state.id,provider:'cloudflare-artifacts',tasks:[validated.task],runs:validated.state.runs,events:[],version:1};
  // Imported publication metadata is history only; it must never resume another coordinator's effects.
  for(const run of state.runs){requireThat(!run.publication);delete run.publicationPreview;}
  createDeliveryState(target,state,{guard:journalGuard});
  return {format:state.format,source:validated.binding,repository,objectChangesSha256,historical:true,authenticatedHostedAuthority:false,providerRequests:0};
}

function publicationContent(source){const {task,run,binding}=source;return {title:'Projects Git candidate '+run.id,
  body:`Historical hosted merged candidate: ${run.headCommit}\nBase: ${run.baseCommit}\nExport SHA-256: ${binding.handoffSha256}\nRequirements SHA-256: ${requirementsDigest(task)}\n\nDelivery requires separate operator-local approval. The export checksum is not authenticated or current hosted authority. GitHub review, merge and deployment remain separate.`};}
const approvalDigest=preview=>hash({action:'publish-private-pr',preview});
function validBinding(binding,state,source){
  const local={...source.binding,objectChangesSha256:state.objectChangesSha256,stagedConfigSha256:state.stagedConfigSha256};
  return exact(binding,['local','repository','repositoryId','baseBranch','headBranch'])&&equal(binding.local,local)&&binding.repository===state.repository
    &&Number.isSafeInteger(binding.repositoryId)&&binding.repositoryId>0&&githubBranch(binding.baseBranch)===binding.baseBranch
    &&binding.headBranch===githubBranch(`newwork/projects-${state.id}-${source.run.id}`);
}
function validPreview(preview,state,source){const content=publicationContent(source);
  return exact(preview,['id','binding','createdAt','expiresAt','title','body'])&&uuid(preview.id)&&validBinding(preview.binding,state,source)
    &&Number.isFinite(Date.parse(preview.createdAt))&&Number.isFinite(Date.parse(preview.expiresAt))&&Date.parse(preview.expiresAt)>Date.parse(preview.createdAt)
    &&preview.title===content.title&&preview.body===content.body;
}
function validPR(value,binding){return value===null||exact(value,['number','url','headCommit','status','mergedAt','mergeCommit'])&&Number.isSafeInteger(value.number)&&value.number>0
  &&value.url===`https://github.com/${binding.repository}/pull/${value.number}`&&sha(value.headCommit)&&['open','closed','merged','changed'].includes(value.status)
  &&(value.mergedAt===null||typeof value.mergedAt==='string'&&Number.isFinite(Date.parse(value.mergedAt)))&&(value.mergeCommit===null||sha(value.mergeCommit));}
function validPublication(record,state,source,approval){
  if(!record||typeof record!=='object'||Array.isArray(record))return false;const required=['id','previewId','binding','title','body','createdAt','status','stage','pushStartedAt','prStartedAt','branchHead','pr','error','observations'];
  if(!exact(record,[...required,...(Object.hasOwn(record,'lastCheckedAt')?['lastCheckedAt']:[])])||!uuid(record.id)||!uuid(record.previewId)||!validBinding(record.binding,state,source)
    ||record.title!==publicationContent(source).title||record.body!==publicationContent(source).body||!Number.isFinite(Date.parse(record.createdAt))
    ||!['pending','needs_attention','changed','open','closed','merged'].includes(record.status)||!['reserved','push','branch','create_pr','pr'].includes(record.stage)
    ||record.pushStartedAt!==null&&!Number.isFinite(Date.parse(record.pushStartedAt))||record.prStartedAt!==null&&!Number.isFinite(Date.parse(record.prStartedAt))
    ||record.lastCheckedAt!==undefined&&!Number.isFinite(Date.parse(record.lastCheckedAt))||record.branchHead!==null&&!sha(record.branchHead)
    ||!validPR(record.pr,record.binding)||record.error!==null&&(!exact(record.error,['code','message'])||typeof record.error.code!=='string'||typeof record.error.message!=='string')
    ||!Array.isArray(record.observations)||record.observations.length>100)return false;
  if(record.prStartedAt!==null&&record.pushStartedAt===null||['create_pr','pr'].includes(record.stage)&&record.prStartedAt===null)return false;
  if(!approval||approval.preview.id!==record.previewId||!equal(approval.preview.binding,record.binding)||approval.preview.title!==record.title||approval.preview.body!==record.body)return false;
  return record.observations.every(item=>item&&typeof item==='object'&&!Array.isArray(item)&&Object.keys(item).every(key=>['at','status','stage','message','pr'].includes(key))
    &&typeof item.at==='string'&&Number.isFinite(Date.parse(item.at))&&typeof item.status==='string'&&typeof item.stage==='string'&&typeof item.message==='string'
    &&(item.pr===undefined||validPR(item.pr,record.binding)));
}
function validateDynamicState(state,source){
  requireThat(exact(state,['format','repository','expected','objectChangesSha256','stagedConfigSha256','operatorApproval','id','provider','tasks','runs','events','version'])
    &&state.format==='projects-git-hosted-delivery/v1'&&digest(state.objectChangesSha256)&&digest(state.stagedConfigSha256)
    &&Number.isSafeInteger(state.version)&&state.version>0&&Array.isArray(state.events));
  const selected=state.runs.find(run=>run.id===source.run.id),preview=selected?.publicationPreview,record=selected?.publication,approval=state.operatorApproval;
  if(preview!==undefined)requireThat(validPreview(preview,state,source));
  if(approval!==null)requireThat(exact(approval,['sha256','preview','at'])&&validPreview(approval.preview,state,source)
    &&approval.sha256===approvalDigest(approval.preview)&&Number.isFinite(Date.parse(approval.at)));
  if(record!==undefined)requireThat(validPublication(record,state,source,approval));
  if(preview!==undefined&&approval!==null)requireThat(equal(preview,approval.preview));
  if(record===undefined&&preview===undefined)requireThat(approval===null);
}
function transition(before,next,runId){const old=before.runs.find(run=>run.id===runId),fresh=next.runs.find(run=>run.id===runId);
  if(before.operatorApproval===null&&next.operatorApproval!==null)return 'approve-preview';
  if(old.publicationPreview?.id!==fresh.publicationPreview?.id)return 'preview';
  if(!old.publication&&fresh.publication)return 'reserve-publication';
  if(!old.publication?.pushStartedAt&&fresh.publication?.pushStartedAt)return 'reserve-push';
  if(!old.publication?.prStartedAt&&fresh.publication?.prStartedAt)return 'reserve-pr';
  return 'observe-publication';}

class HostedPublication extends GitHubPublication {
  constructor(ports,source){super(ports);this.hostedSource=source;}
  binding(runId){
    requireThat(runId===this.hostedSource.run.id);
    const state=this.read(),selected=this.selected(runId);
    requireThat(state.provider==='cloudflare-artifacts'&&equal(state.expected,this.hostedSource.expected)
      &&equal(selected.task,this.hostedSource.task));
    const {publication,publicationPreview,...run}=selected.run;
    requireThat(equal(run,this.hostedSource.run));
    return {...this.hostedSource.binding,objectChangesSha256:state.objectChangesSha256,stagedConfigSha256:state.stagedConfigSha256};
  }
  publicationContent(){return publicationContent(this.hostedSource);}
}

/** Open only the operator-local package. No hosted request, imported execution or automatic publication. */
export async function openHostedDelivery(target,provider,{now,storageFault}={}) {
  await directory(target);const durable=openDeliveryState(target,{storageFault,guard:journalGuard,validateTransition:validJournalTransition});let state=durable.read();
  requireThat(state.repository===githubRepository(provider.repository));
  const source=await hostedDeliverySource(await ordinary(path.join(target,'handoff.json'),MAX_HANDOFF_BYTES),state.expected);
  source.expected=state.expected;
  validateDynamicState(state,source);
  requireThat(state.id===source.state.id&&state.tasks.length===1&&equal(state.tasks[0],source.task)&&state.runs.length===source.state.runs.length);
  for(const original of source.state.runs){const retained=state.runs.find(run=>run.id===original.id);requireThat(retained);const {publication,publicationPreview,...run}=retained;requireThat(equal(run,original));}
  const staged=path.join(target,'objects.git');await trustedStaging(staged,state.stagedConfigSha256);
  const sourcePath=async()=>{
    await trustedStaging(staged,state.stagedConfigSha256);
    requireThat(await objectBinding(staged,source)===state.objectChangesSha256);
    const git=readOnlyGit(staged);requireThat((await git(['rev-parse','refs/candidates/'+source.run.id])).trim()===source.run.headCommit);
    const roots=[source.run.baseCommit,source.run.headCommit];
    await captureGitObjects(roots,Object.fromEntries(roots.map(oid=>[oid,staged])),budget());
    return staged;
  };
  const publisher=new HostedPublication({provider,read:()=>state,save:change=>{const next=structuredClone(state);change(next);
    if(!next.runs.find(run=>run.id===source.run.id).publication&&next.runs.find(run=>run.id===source.run.id).publicationPreview?.id!==state.runs.find(run=>run.id===source.run.id).publicationPreview?.id)next.operatorApproval=null;
    validateDynamicState(next,source);const kind=transition(state,next,source.run.id);try{state=durable.save(next,kind);}catch(error){state=durable.read();throw error;}},
    source:sourcePath,...(now?{now}:{})},source);
  publisher.binding(source.run.id);
  const approve=(approvalSha256,preview)=>{
    requireThat(validPreview(preview,state,source)&&digest(approvalSha256)&&approvalSha256===approvalDigest(preview));
    const approval={sha256:approvalSha256,preview:structuredClone(preview),at:new Date().toISOString()};
    if(state.operatorApproval)requireThat(equal(state.operatorApproval,approval)||state.operatorApproval.sha256===approvalSha256&&equal(state.operatorApproval.preview,preview));
    else {const next=structuredClone(state);next.operatorApproval=approval;validateDynamicState(next,source);state=durable.save(next,'approve-preview');}
  };
  return {
    async preview(){const preview=await publisher.preview(source.run.id);return {preview,approvalSha256:approvalDigest(preview)};},
    async publish({previewId,requestId,approvalSha256}){
      const run=publisher.selected(source.run.id).run,record=run.publication;
      requireThat(uuid(previewId)&&uuid(requestId)&&(record?record.previewId===previewId:run.publicationPreview?.id===previewId
        &&Date.parse(run.publicationPreview.expiresAt)>(now?now():Date.now())));
      if(record)requireThat(state.operatorApproval?.preview.id===previewId&&state.operatorApproval.sha256===approvalSha256);
      else approve(approvalSha256,run.publicationPreview);
      return publisher.publish(source.run.id,{previewId,requestId});
    },
    async refresh(id){return publisher.refresh(source.run.id,id);},
    async resume(id,approvalSha256){const record=publisher.record(source.run.id,id);requireThat(state.operatorApproval?.preview.id===record.previewId&&state.operatorApproval.sha256===approvalSha256);return publisher.continue(source.run.id,id);},
    receipt(){const run=publisher.selected(source.run.id).run,record=run.publication;
      const publication=record?Object.fromEntries(['id','previewId','binding','createdAt','lastCheckedAt','status','stage','pushStartedAt','prStartedAt','branchHead','pr','error','observations'].filter(key=>record[key]!==undefined).map(key=>[key,record[key]])):null;
      const operatorApproval=state.operatorApproval?{sha256:state.operatorApproval.sha256,previewId:state.operatorApproval.preview.id,at:state.operatorApproval.at}:null;
      return {format:state.format,source:publisher.binding(source.run.id),repository:state.repository,
        operatorApproval,localState:{journal:'verified',projectionRecovered:durable.projectionRecovered},historical:true,authenticatedHostedAuthority:false,publication};}
  };
}

/** One package lock across CLI processes. A dead local process says nothing about its remote effects. */
export async function withHostedDeliveryLock(target,action) {
  await directory(target);const file=path.join(target,'operation.lock'),lock={id:randomUUID(),pid:process.pid,at:new Date().toISOString()};
  let handle;try{handle=await open(file,'wx',0o600);}catch{throw Error('Delivery is locked. Inspect its local lock; never infer remote failure from a stale lock.');}
  try{await handle.writeFile(JSON.stringify(lock));await handle.sync();return await action();}
  finally{await handle.close();const current=JSON.parse(await ordinary(file,1024));requireThat(current.id===lock.id);await unlink(file);}
}

export async function hostedDeliveryLock(target,releaseId) {
  await directory(target);const file=path.join(target,'operation.lock'),text=await ordinary(file,1024),lock=JSON.parse(text);
  requireThat(exact(lock,['id','pid','at'])&&uuid(lock.id)&&Number.isSafeInteger(lock.pid)&&lock.pid>0);
  if(releaseId){
    requireThat(releaseId===lock.id);let stopped=false;
    try{process.kill(lock.pid,0);}catch(error){stopped=error.code==='ESRCH';}
    requireThat(stopped&&(await ordinary(file,1024))===text);await unlink(file);
  }
  return {...lock,released:Boolean(releaseId),remoteOutcome:'not-read; do not repeat an attempted write'};
}

export async function readHostedHandoff(filename){requireThat(path.isAbsolute(filename));return ordinary(filename,MAX_HANDOFF_BYTES);}
