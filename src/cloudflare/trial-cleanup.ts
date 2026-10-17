import {ApiError} from './security.ts';
import type {HostedSnapshot} from './controller.ts';
import {TRIAL_SAMPLE,trialSampleName} from '../core/trial-sample.mjs';
import {TRIAL_CLEANUP_CALLS} from './trial-controls.ts';

export interface TrialCleanupResult {state:'complete'|'pending'|'blocked';resources:number|null;deleted:number|null;reason:string|null}
type Storage=Pick<DurableObjectStorage,'sql'|'transactionSync'>;
type Receipt={name:string;repository_id:string;marker:string;state:string};
const absent=(error:unknown)=>Boolean(error&&typeof error==='object'&&'code' in error&&error.code==='NOT_FOUND');

export function checkedTrialCleanup(value:unknown):TrialCleanupResult {
  const result=value as TrialCleanupResult;
  if(!result||typeof result!=='object'||Object.keys(result).sort().join(',')!=='deleted,reason,resources,state'
    ||!['complete','pending','blocked'].includes(result.state)
    ||result.resources!==null&&(!Number.isSafeInteger(result.resources)||result.resources<0||result.resources>10000)
    ||result.deleted!==null&&(!Number.isSafeInteger(result.deleted)||result.deleted<0||result.resources===null||result.deleted>result.resources)
    ||(result.resources===null)!==(result.deleted===null)
    ||result.state==='complete'&&(result.resources===null||result.deleted!==result.resources||result.reason!==null)
    ||result.state!=='complete'&&result.reason===null
    ||result.reason!==null&&(typeof result.reason!=='string'||!/^[A-Z_]{1,64}$/.test(result.reason)))
    throw new ApiError(503,'TRIAL_UNAVAILABLE','Cleanup returned an invalid receipt.');
  return {state:result.state,resources:result.resources,deleted:result.deleted,reason:result.reason};
}

// This dedicated namespace has one writer: the trial runtime. Never discover
// deletion targets by listing a namespace or accepting names from HTTP input.
export async function cleanupTrialResources(storage:Storage,snapshot:HostedSnapshot,artifacts:Artifacts|undefined,
  validate:()=>Promise<void>,now=Date.now()):Promise<TrialCleanupResult> {
  const name=trialSampleName(snapshot.workspace.id),operations=Object.entries(snapshot.operations).filter(([,op])=>op.resourceName);
  const result=(state:TrialCleanupResult['state'],reason:string|null,deleted=0):TrialCleanupResult=>({state,resources:operations.length,deleted,reason});
  // Validate the complete deletion set before the first provider effect.
  if(operations.length>1||Object.values(snapshot.workspace.projects??{}).some(p=>p.repositoryName!==name)
    ||Object.keys(snapshot.forks).length||snapshot.workspace.tasks.length||snapshot.workspace.runs.length)return result('blocked','UNTRACKED_RESOURCE');
  if(!operations.length)return Object.keys(snapshot.workspace.projects??{}).length?result('blocked','UNTRACKED_RESOURCE'):result('complete',null);
  const [key,op]=operations[0];
  if(op.kind!=='repository-create'||op.resourceName!==name||op.seedTemplate!==TRIAL_SAMPLE.id
    ||op.marker!==`Projects Git creation: ${snapshot.workspace.id}:${key}\n\n${TRIAL_SAMPLE.description}`)
    return result('blocked','OWNERSHIP_UNCONFIRMED');
  if((op.leaseUntil??0)>now)return result('pending','OPERATION_IN_FLIGHT');
  if(!artifacts)return result('blocked','REPOSITORY_BINDING_UNAVAILABLE');
  storage.sql.exec('CREATE TABLE IF NOT EXISTS trial_cleanup_resources(name TEXT PRIMARY KEY,repository_id TEXT NOT NULL,marker TEXT NOT NULL,state TEXT NOT NULL)');
  const known=storage.sql.exec<Receipt>('SELECT * FROM trial_cleanup_resources WHERE name=?',name).toArray()[0];
  if(known&&(known.marker!==op.marker||op.repositoryId&&known.repository_id!==op.repositoryId))return result('blocked','OWNERSHIP_CHANGED');
  let calls=0;
  const effect=async<T>(work:()=>Promise<T>):Promise<T>=>{
    if(++calls>TRIAL_CLEANUP_CALLS)throw new ApiError(409,'CLEANUP_CALL_LIMIT','The cleanup attempt allowance is used.');
    await validate();return work();
  };
  try{
    let handle:ArtifactsRepo;
    try{handle=await effect(()=>artifacts.get(name));}
    catch(error){
      if(!absent(error))throw error;
      if(!known&&!op.repositoryId)return result('pending','CREATION_OUTCOME_UNKNOWN');
      return result('complete',null,1);
    }
    using repo=handle;
    const info=await effect(()=>repo.info());
    if(typeof info.id!=='string'||!info.id||info.id.length>200||info.name!==name||info.description!==op.marker
      ||op.repositoryId&&info.id!==op.repositoryId||known&&info.id!==known.repository_id)return result('blocked','OWNERSHIP_CHANGED');
    if(known)return result(known.state==='deleted'?'blocked':'pending',known.state==='deleted'?'RESOURCE_REAPPEARED':'DELETE_OUTCOME_UNKNOWN');
    const inventory=async()=>{
      const value=await effect(()=>repo.listTokens());
      if(!Array.isArray(value.tokens)||!Number.isSafeInteger(value.total)||value.total!==value.tokens.length||value.total>16
        ||value.tokens.some(t=>!t||typeof t.id!=='string'||!t.id||!['active','revoked','expired'].includes(t.state))
        ||new Set(value.tokens.map(t=>t.id)).size!==value.total)throw new ApiError(409,'TOKEN_INVENTORY_INCOMPLETE','Token cleanup needs operator attention.');
      return value.tokens;
    };
    for(const token of await inventory())if(token.state==='active')await effect(()=>repo.revokeToken(token.id));
    if((await inventory()).some(t=>t.state==='active'))return result('pending','TOKEN_REVOCATION_UNCONFIRMED');
    const latest=await effect(()=>repo.info());
    if(latest.id!==info.id||latest.name!==name||latest.description!==op.marker)return result('blocked','OWNERSHIP_CHANGED');
    // Later attempts inspect an uncertain deletion; they never blindly resend it.
    await effect(()=>{
      storage.sql.exec("INSERT INTO trial_cleanup_resources(name,repository_id,marker,state) VALUES(?,?,?,'deleting')",name,info.id,op.marker);
      return artifacts.delete(name);
    });
    try{using remaining=await effect(()=>artifacts.get(name));return result('pending','DELETE_UNCONFIRMED');}
    catch(error){if(!absent(error))throw error;}
    storage.sql.exec("UPDATE trial_cleanup_resources SET state='deleted' WHERE name=?",name);
    return result('complete',null,1);
  }catch(error){return result('pending',error instanceof ApiError?error.code:'PROVIDER_OUTCOME_UNKNOWN');}
}

export function purgeTrialWorkspace(storage:Storage,workspaceId:string,receipt:TrialCleanupResult):void {
  trialSampleName(workspaceId);
  checkedTrialCleanup(receipt);
  if(receipt.state!=='complete'||receipt.resources!==receipt.deleted)throw new ApiError(409,'CLEANUP_UNCONFIRMED','Keep workspace records until cleanup is confirmed.');
  storage.transactionSync(()=>{
    const tables=storage.sql.exec<{name:string}>("SELECT name FROM sqlite_master WHERE type='table'").toArray()
      .map(row=>row.name).filter(name=>!name.startsWith('sqlite_')&&!name.startsWith('_cf_')&&name!=='trial_cleanup_receipt');
    if(tables.some(name=>!/^[a-z][a-z0-9_]*$/.test(name)))throw new ApiError(409,'CLEANUP_STORAGE_UNKNOWN','Workspace storage needs operator review.');
    // One transaction purges content and retains its tombstone: no deleteAll/put gap.
    for(const name of tables)storage.sql.exec('DROP TABLE "'+name+'"');
    storage.sql.exec('CREATE TABLE IF NOT EXISTS trial_cleanup_receipt(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL)');
    storage.sql.exec('INSERT INTO trial_cleanup_receipt(id,data) VALUES(1,?)',JSON.stringify(receipt));
  });
}

export function retainedTrialCleanup(storage:Storage):TrialCleanupResult|null {
  if(!storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='trial_cleanup_receipt'").toArray().length)return null;
  const row=storage.sql.exec<{data:string}>('SELECT data FROM trial_cleanup_receipt WHERE id=1').toArray()[0];
  if(!row)return null;
  const receipt=checkedTrialCleanup(JSON.parse(row.data));
  if(receipt.state!=='complete')throw new ApiError(503,'TRIAL_UNAVAILABLE','Workspace cleanup tombstone is inconsistent.');
  return receipt;
}
