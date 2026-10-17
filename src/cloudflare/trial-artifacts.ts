import {ApiError} from './security.ts';
import type {HostedSnapshot} from './controller.ts';
import {TRIAL_SAMPLE,trialSampleName} from '../core/trial-sample.mjs';
export type TrialArtifactEffect='read'|'create'|'issue'|'fork';

// All normal trial provider calls use this ownership and reservation boundary.
// Cleanup uses its separate bounded teardown path after admission has ended.
export function scopedTrialArtifacts(binding:Artifacts,snapshot:()=>HostedSnapshot,
  reserve:(kind:TrialArtifactEffect)=>Promise<void>,validate:()=>Promise<void>):Artifacts {
  const denied=()=>new ApiError(403,'TRIAL_REPOSITORY_FORBIDDEN','The repository is outside this trial’s retained resource intents.');
  const owned=(name:string)=>{
    const state=snapshot(),sample=trialSampleName(state.workspace.id);
    const found=Object.entries(state.operations).filter(([,op])=>op.resourceName===name);
    if(found.length!==1)throw denied();const [key,op]=found[0];
    const valid=op.kind==='repository-create'?name===sample&&op.seedTemplate===TRIAL_SAMPLE.id&&op.marker===`Projects Git creation: ${state.workspace.id}:${key}\n\n${TRIAL_SAMPLE.description}`
      :['assign','claim'].includes(op.kind)&&/^agent-[a-f0-9-]{36}$/.test(name)&&op.marker==='projects-agent-git:'+state.workspace.id+':'+key;
    if(!valid)throw denied();return op;
  };
  const effect=async<T>(kind:TrialArtifactEffect,work:()=>Promise<T>)=>{await validate();await reserve(kind);await validate();return work();};
  const check=(name:string,info:ArtifactsRepoInfo)=>{const op=owned(name);if(info.name!==name||info.description!==op.marker||op.repositoryId&&info.id!==op.repositoryId)throw denied();};
  async function get(name:string):Promise<ArtifactsRepo>{
    owned(name);const raw=await effect('read',()=>binding.get(name));
    try{check(name,await effect('read',()=>raw.info()));}catch(error){raw[Symbol.dispose]();throw error;}
    let teardownCalls=0;
    const read=async<T>(work:()=>Promise<T>)=>{owned(name);const result=await effect('read',work);await validate();return result;};
    const info=async()=>{const value=await read(()=>raw.info());check(name,value);return value;};
    return {
      info,
      readBlob:hash=>read(()=>raw.readBlob(hash)),readTree:hash=>read(()=>raw.readTree(hash)),readCommit:hash=>read(()=>raw.readCommit(hash)),readFile:args=>read(()=>raw.readFile(args)),
      log:opts=>read(()=>raw.log(opts)),listTokens:()=>read(()=>raw.listTokens()),
      async createToken(scope,ttl){if(!['read','write'].includes(scope??'')||typeof ttl!=='number'||!Number.isSafeInteger(ttl)||ttl<60||ttl>180)throw new ApiError(400,'TRIAL_TOKEN_LIMIT','Trial repository tokens must be explicitly scoped and short lived.');await info();return effect('issue',()=>raw.createToken(scope,ttl));},
      async revokeToken(id){
        // A credential already issued by an owned attempt may be revoked even
        // after pause/expiry. Bound this path; it cannot mint or publish anything.
        if(++teardownCalls>32)throw new ApiError(409,'TRIAL_TEARDOWN_LIMIT','Credential teardown needs cleanup recovery.');
        check(name,await raw.info());return raw.revokeToken(id);
      },
      async fork(target,options){const op=owned(target);if(!['assign','claim'].includes(op.kind)||options?.description!==op.marker)throw denied();await info();return effect('fork',()=>raw.fork(target,options));},
      [Symbol.dispose](){raw[Symbol.dispose]();},
    };
  }
  return {
    get,
    async create(name,options){const op=owned(name);if(op.kind!=='repository-create'||options?.description!==op.marker)throw denied();return effect('create',()=>binding.create(name,options));},
    async import(){throw denied();},async list(){throw denied();},async delete(){throw denied();},
  };
}
