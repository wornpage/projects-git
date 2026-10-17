import {ApiError,digest,validateIdempotencyKey} from './security.ts';
import {trialCandidateSource} from './trial-workflow.ts';
import type {ArtifactGit} from './git-transport.mjs';

export interface TrialPublicationContext {
  workspaceId:string;runId:string;taskId:string;revision:number;baseCommit:string;branch:string;
  repositoryName:string;marker:string;
}
type Storage=Pick<DurableObjectStorage,'sql'|'transactionSync'>;
type Row={run_id:string;context:string;source_hash:string;timestamp:number;repository_id:string|null;head_commit:string|null;state:string;lease_id:string;lease_until:number};
const changed=()=>new ApiError(409,'TRIAL_SOURCE_CHANGED','Inspect the retained candidate publication before retrying.');

// The coordinator supplies a fresh assignment/tenant check and its dedicated
// Artifacts binding. Publication is separate from submission, checks and review.
// Only checkout.mjs is writable; no repository token is returned to the caller.
export class TrialSourcePublication {
  private storage:Storage;
  private artifacts:Artifacts;
  private git:ArtifactGit;
  private validate:(runId:string)=>Promise<TrialPublicationContext>;
  constructor(storage:Storage,artifacts:Artifacts,git:ArtifactGit,validate:(runId:string)=>Promise<TrialPublicationContext>) {
    this.storage=storage;this.artifacts=artifacts;this.git=git;this.validate=validate;
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS trial_source_publications(
      run_id TEXT PRIMARY KEY,context TEXT NOT NULL,source_hash TEXT NOT NULL,timestamp INTEGER NOT NULL,
      repository_id TEXT,head_commit TEXT,state TEXT NOT NULL,lease_id TEXT NOT NULL,lease_until INTEGER NOT NULL)`);
  }
  private row(runId:string) {return this.storage.sql.exec<Row>('SELECT * FROM trial_source_publications WHERE run_id=?',runId).toArray()[0];}
  async status(runId:string) {
    await this.validate(runId);const row=this.row(runId);
    return {runId,state:row?.state??'not-started',headCommit:row?.head_commit??null};
  }
  async publish(runId:string,input:Record<string,unknown>,key:string) {
    validateIdempotencyKey(key);const {source,headCommit:baseCommit}=trialCandidateSource(input);
    const context=await this.validate(runId);
    if(context.runId!==runId||!/^trial-[a-f0-9]{64}$/.test(context.workspaceId)||context.baseCommit!==baseCommit
      ||!context.marker.includes(context.workspaceId)||!Number.isSafeInteger(context.revision)||context.revision<1)throw changed();
    const fingerprint=JSON.stringify(context),hash=await digest(source),lease=crypto.randomUUID();
    const current=async()=>{if(JSON.stringify(await this.validate(runId))!==fingerprint)throw changed();};
    await current();
    this.storage.transactionSync(()=>{
      const prior=this.row(runId);
      if(prior&&(prior.context!==fingerprint||prior.source_hash!==hash))throw changed();
      if(prior&&prior.lease_until>Date.now())throw new ApiError(409,'OPERATION_IN_PROGRESS','Candidate publication is still in progress. Inspect status before retrying.');
      if(!prior&&this.storage.sql.exec<{n:number}>('SELECT count(*) n FROM trial_source_publications').one().n>=10)
        throw new ApiError(429,'TRIAL_WORKFLOW_LIMIT','This trial has reached 10 / 10 candidate publications.');
      this.storage.sql.exec(`INSERT INTO trial_source_publications(run_id,context,source_hash,timestamp,repository_id,head_commit,state,lease_id,lease_until)
        VALUES(?,?,?,?,NULL,NULL,'preparing',?,?) ON CONFLICT(run_id) DO UPDATE SET lease_id=excluded.lease_id,lease_until=excluded.lease_until`,runId,fingerprint,hash,Math.floor(Date.now()/1000),lease,Date.now()+120_000);
    });
    const owns=()=>{const row=this.row(runId);if(!row||row.lease_id!==lease||row.lease_until<=Date.now())throw changed();return row;};
    try {
      await current();using repo=await this.artifacts.get(context.repositoryName);const info=await repo.info();let row=owns();
      if(info.name!==context.repositoryName||info.description!==context.marker||row.repository_id&&info.id!==row.repository_id)throw changed();
      this.storage.sql.exec('UPDATE trial_source_publications SET repository_id=? WHERE run_id=?',info.id,runId);
      const validate=async()=>{await current();owns();const latest=await repo.info();if(latest.id!==info.id||latest.name!==info.name||latest.description!==info.description)throw changed();};
      const revoke=async()=>{
        const inventory=await repo.listTokens();
        if(!Array.isArray(inventory.tokens)||inventory.total!==inventory.tokens.length||inventory.total>32
          ||inventory.tokens.some(t=>!t||typeof t.id!=='string'||!t.id||!['active','expired','revoked'].includes(t.state))
          ||new Set(inventory.tokens.map(t=>t.id)).size!==inventory.tokens.length)throw new ApiError(409,'TOKEN_INVENTORY_INCOMPLETE','Owned candidate credentials need inspection.');
        for(const token of inventory.tokens)if(token.state==='active')await repo.revokeToken(token.id);
        const remaining=await repo.listTokens();
        if(remaining.total!==remaining.tokens.length||remaining.tokens.some(t=>t.state==='active'))throw new ApiError(409,'TOKEN_REVOCATION_UNCONFIRMED','Candidate credential revocation is unconfirmed.');
      };
      await validate();await revoke();
      const heads=await repo.log({ref:context.branch,limit:1});await validate();row=owns();
      if(heads.length){
        if(!row.head_commit||heads[0].hash!==row.head_commit)throw changed();
      }else{
        if(row.state==='complete')throw changed();
        await validate();const token=await repo.createToken('write',60);
        try {
          await validate();
          const head=await this.git.commitCandidate({remote:info.remote,token:token.plaintext,defaultBranch:info.defaultBranch,branch:context.branch,baseCommit,
            files:[{path:'checkout.mjs',content:source}],context:{runId,taskId:context.taskId,revision:context.revision},timestamp:row.timestamp,
            beforePush:async head=>{await validate();const retained=owns();if(retained.head_commit&&retained.head_commit!==head)throw changed();
              this.storage.sql.exec("UPDATE trial_source_publications SET head_commit=?,state='publishing' WHERE run_id=?",head,runId);}});
          if(head!==owns().head_commit)throw changed();
        }finally {await repo.revokeToken(token.id);}
        await revoke();await validate();
        const observed=await repo.log({ref:context.branch,limit:1});if(observed[0]?.hash!==owns().head_commit)throw changed();
      }
      await current();row=owns();
      this.storage.sql.exec("UPDATE trial_source_publications SET state='complete',lease_until=0 WHERE run_id=?",runId);
      return {runId,headCommit:row.head_commit,sourceBytes:new TextEncoder().encode(source).byteLength};
    }catch(error){
      if(this.row(runId)?.lease_id===lease)this.storage.sql.exec('UPDATE trial_source_publications SET lease_until=0 WHERE run_id=?',runId);
      throw error;
    }
  }
}
