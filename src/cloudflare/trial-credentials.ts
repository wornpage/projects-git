import {ApiError,digest,validateIdempotencyKey} from './security.ts';
import {assertTrialActive,trialGrant} from './trial-admission.ts';
import type {TrialGrant} from './trial-admission.ts';
import type {HumanAccessIdentity} from './access.ts';

export type TrialCredentialRole='agent'|'reviewer';
export interface TrialCredentialPrincipal {
  provider:'trial-credential';kind:TrialCredentialRole;issuer:string;id:string;workspaceId:string;
  displayName:string;issuedAt:number;expiresAt:number;credentialId:string;
}
type Storage=Pick<DurableObjectStorage,'sql'|'transactionSync'>;
type Row={id:string;workspace_id:string;role:TrialCredentialRole;token_hash:string;request_hash:string;issued_at:number;expires_at:number;revoked_at:number|null};
const failure=()=>new ApiError(401,'TRIAL_CREDENTIAL_INVALID','Use a current credential for this trial.');
const actorId=(workspaceId:string,role:TrialCredentialRole)=>role+'-'+workspaceId;

// This registry-owned store issues scoped application credentials. They are not
// Cloudflare service tokens. Only hashes are retained, and no Git token is exposed.
export class TrialCredentials {
  private storage:Storage;
  private grantFor:(workspaceId:string)=>TrialGrant;
  private now:()=>number;
  constructor(storage:Storage,grantFor:(workspaceId:string)=>TrialGrant,now:()=>number=Date.now) {
    this.storage=storage;this.grantFor=grantFor;this.now=now;
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS trial_credentials(
      id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,role TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,
      request_hash TEXT NOT NULL,issued_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,revoked_at INTEGER,
      UNIQUE(workspace_id,request_hash))`);
    storage.sql.exec('CREATE INDEX IF NOT EXISTS trial_credentials_workspace ON trial_credentials(workspace_id)');
  }
  private grant(workspaceId:string):TrialGrant {
    const grant=trialGrant({ok:true,grant:this.grantFor(workspaceId)});
    if(grant.workspaceId!==workspaceId)throw new ApiError(403,'WORKSPACE_FORBIDDEN','The credential targets a different trial.');
    assertTrialActive(grant,this.now());return grant;
  }
  private owner(workspaceId:string,identity:HumanAccessIdentity):TrialGrant {
    const grant=this.grant(workspaceId);
    if(identity.subject!==grant.ownerSubject||identity.issuer!==grant.issuer||identity.audience!==grant.audience
      ||!Number.isSafeInteger(identity.issuedAt)||!Number.isSafeInteger(identity.expiresAt)
      ||identity.issuedAt>Math.floor(this.now()/1000)||identity.expiresAt<=Math.floor(this.now()/1000))
      throw new ApiError(403,'WORKSPACE_FORBIDDEN','Only the current trial owner can manage credentials.');
    return grant;
  }
  private principal(row:Row,grant:TrialGrant):TrialCredentialPrincipal {
    return {provider:'trial-credential',kind:row.role,issuer:grant.issuer,id:actorId(row.workspace_id,row.role),workspaceId:row.workspace_id,
      displayName:row.role==='agent'?'Trial coding agent':'Trial independent reviewer',issuedAt:row.issued_at,expiresAt:row.expires_at,credentialId:row.id};
  }
  async issue(workspaceId:string,identity:HumanAccessIdentity,role:TrialCredentialRole,key:string) {
    this.owner(workspaceId,identity);validateIdempotencyKey(key);
    if(!['agent','reviewer'].includes(role))throw new ApiError(400,'TRIAL_CREDENTIAL_ROLE','Choose agent or reviewer.');
    const bytes=crypto.getRandomValues(new Uint8Array(32));
    const token='pgt1_'+Array.from(bytes,n=>n.toString(16).padStart(2,'0')).join('');
    const [hash,requestHash]=await Promise.all([digest(token),digest(key)]);
    return this.storage.transactionSync(()=>{
      const grant=this.owner(workspaceId,identity),now=Math.floor(this.now()/1000);
      const prior=this.storage.sql.exec<Row>('SELECT * FROM trial_credentials WHERE workspace_id=? AND request_hash=?',workspaceId,requestHash).toArray()[0];
      if(prior){
        if(prior.role!==role)throw new ApiError(409,'IDEMPOTENCY_CONFLICT','This request belongs to another credential role.');
        return {principal:this.principal(prior,grant),token:null,replayed:true,revoked:prior.revoked_at!==null};
      }
      const count=this.storage.sql.exec<{n:number}>('SELECT count(*) n FROM trial_credentials WHERE workspace_id=?',workspaceId).one().n;
      if(count>=32)throw new ApiError(429,'TRIAL_CREDENTIAL_LIMIT','This trial has reached its credential rotation limit.');
      const row:Row={id:crypto.randomUUID(),workspace_id:workspaceId,role,token_hash:hash,request_hash:requestHash,
        issued_at:now,expires_at:Math.min(now+3600,Math.floor(grant.expiresAt/1000)),revoked_at:null};
      if(row.expires_at<=now)throw failure();
      this.storage.sql.exec('UPDATE trial_credentials SET revoked_at=coalesce(revoked_at,?) WHERE workspace_id=? AND role=?',now,workspaceId,role);
      this.storage.sql.exec('INSERT INTO trial_credentials(id,workspace_id,role,token_hash,request_hash,issued_at,expires_at,revoked_at) VALUES(?,?,?,?,?,?,?,NULL)',row.id,workspaceId,role,hash,requestHash,row.issued_at,row.expires_at);
      return {principal:this.principal(row,grant),token,replayed:false,revoked:false};
    });
  }
  revoke(workspaceId:string,identity:HumanAccessIdentity,role:TrialCredentialRole) {
    this.owner(workspaceId,identity);
    if(!['agent','reviewer'].includes(role))throw new ApiError(400,'TRIAL_CREDENTIAL_ROLE','Choose agent or reviewer.');
    this.storage.sql.exec('UPDATE trial_credentials SET revoked_at=coalesce(revoked_at,?) WHERE workspace_id=? AND role=?',Math.floor(this.now()/1000),workspaceId,role);
    return {revoked:true};
  }
  async authenticate(token:string):Promise<TrialCredentialPrincipal> {
    if(typeof token!=='string'||!/^pgt1_[a-f0-9]{64}$/.test(token))throw failure();
    const hash=await digest(token),row=this.storage.sql.exec<Row>('SELECT * FROM trial_credentials WHERE token_hash=?',hash).toArray()[0];
    if(!row)throw failure();
    const grant=this.grant(row.workspace_id),principal=this.principal(row,grant);
    this.authorize(principal);return principal;
  }
  authorize(principal:TrialCredentialPrincipal):TrialGrant {
    if(!principal||principal.provider!=='trial-credential'||!['agent','reviewer'].includes(principal.kind))throw failure();
    const row=this.storage.sql.exec<Row>('SELECT * FROM trial_credentials WHERE id=?',principal.credentialId).toArray()[0];
    if(!row||row.revoked_at!==null||row.expires_at<=Math.floor(this.now()/1000))throw failure();
    const grant=this.grant(row.workspace_id);
    const expected=this.principal(row,grant);
    for(const key of ['provider','kind','issuer','id','workspaceId','issuedAt','expiresAt','credentialId'] as const)
      if(principal[key]!==expected[key])throw failure();
    return grant;
  }
  active(workspaceId:string) {
    const grant=this.grant(workspaceId);
    return this.storage.sql.exec<Row>('SELECT * FROM trial_credentials WHERE workspace_id=? AND revoked_at IS NULL AND expires_at>? ORDER BY role',workspaceId,Math.floor(this.now()/1000)).toArray().map(row=>this.principal(row,grant));
  }
  purge(workspaceId:string):void {
    const grant=trialGrant({ok:true,grant:this.grantFor(workspaceId)});
    if(grant.workspaceId!==workspaceId)throw new ApiError(403,'WORKSPACE_FORBIDDEN','Credential cleanup targets a different trial.');
    if(grant.closedAt===null&&this.now()<grant.expiresAt)throw new ApiError(409,'TRIAL_CLEANUP_NOT_DUE','Active trial credentials cannot be purged by cleanup.');
    this.storage.sql.exec('DELETE FROM trial_credentials WHERE workspace_id=?',workspaceId);
  }
}
