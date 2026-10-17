import type {Project, Workspace} from './workflow.mjs';
export type RepositoryPermission = 'read' | 'build' | 'review';
export interface RepositoryGrant {id:string;issuer:string;kind:'member'|'agent'|'reviewer';role:RepositoryPermission}
export interface RepositoryAccess {version:number;grants:RepositoryGrant[];updatedAt:string;updatedBy:string}
export interface RepositoryActor {kind:string;id:string;issuer:string}
export interface RepositoryIdentityPolicy {issuer:string;agentClientIds:string[];reviewerClientIds?:string[];reviewerSubjects?:string[];memberSubjects?:string[]}
export function configuredRepositoryIdentity(policy:RepositoryIdentityPolicy,kind:string,id:string):boolean;
export function repositoryAccess(project:Project):{version:number;grants:RepositoryGrant[];configured:boolean;updatedAt?:string;updatedBy?:string};
export function hasRepositoryPermission(project:Project,actor:RepositoryActor,policy:RepositoryIdentityPolicy,permission:RepositoryPermission):boolean;
export function requireRepositoryPermission(project:Project|undefined,actor:RepositoryActor,policy:RepositoryIdentityPolicy,permission:RepositoryPermission):void;
export function setRepositoryAccess(project:Project,input:Record<string,unknown>,actor:RepositoryActor,policy:RepositoryIdentityPolicy,now?:string):RepositoryAccess;
export function repositoryWorkspace(workspace:Workspace,actor:RepositoryActor,policy:RepositoryIdentityPolicy):Workspace;
