import {approvedTrialResources} from './trial-policy.mjs';
import {join} from 'node:path';
import {gitHttpFixture} from './git-http.mjs';
import {fixture,index,policy} from './trial-http.mjs';
import {WorkspaceStore} from '../../src/cloudflare/workspace-store.ts';
import nodeFs from 'node:fs';
import iso from 'isomorphic-git';

// Artifacts control-plane fixture; Git objects/pushes and SQLite are real and
// local. No Cloudflare resource, provider credential or hosted endpoint is used.
export async function trialSampleFixture(t,{policyOverrides={}}={}) {
  const git=await gitHttpFixture(t),repositories=new Map(),calls=[];
  const hooks={};
  const artifacts={
    async delete(name){calls.push(['delete',name]);await hooks.beforeDelete?.(name);const deleted=repositories.delete(name);await hooks.afterDelete?.(name);return deleted;},
    async get(name){calls.push(['get',name]);const repo=repositories.get(name);if(!repo)throw Object.assign(Error('Not found'),{code:'NOT_FOUND'});return repo;},
    async create(name,options){
      calls.push(['create',name]);if(repositories.has(name))throw Object.assign(Error('Exists'),{code:'ALREADY_EXISTS'});
      await git.git(git.root,'init','--bare','--initial-branch=main',name+'.git');
      const directory=join(git.root,name+'.git');await git.git(directory,'config','http.receivepack','true');
      const data={id:crypto.randomUUID(),name,remote:'https://git.example.test/'+name+'.git',description:options.description,defaultBranch:options.setDefaultBranch,readOnly:options.readOnly};
      const tokens=new Map([['initial',{id:'initial',state:'active'}]]);
      const repo={data,tokens,directory,
        async info(){await hooks.info?.(repo);return {...data};},
        async listTokens(){calls.push(['tokens',name]);await hooks.listTokens?.(repo);return {tokens:[...tokens.values()].map(token=>({...token})),total:tokens.size};},
        async revokeToken(id){calls.push(['revoke',name,id]);await hooks.revoke?.(repo,id);const token=tokens.get(id);if(!token)return false;token.state='revoked';return true;},
        async createToken(scope,ttl){calls.push(['issue',name,scope,ttl]);const id=crypto.randomUUID();tokens.set(id,{id,state:'active'});await hooks.issue?.(repo);return {id,scope,plaintext:'local-sample-write-token',expiresAt:new Date(Date.now()+ttl*1000).toISOString()};},
        async log({ref='main',limit=50,offset=0}={}){try{const entries=await iso.log({fs:nodeFs,gitdir:directory,ref,depth:limit+offset});return entries.slice(offset).map(({oid,commit})=>({hash:oid,treeHash:commit.tree,parents:commit.parent,message:commit.message,author:commit.author,committer:commit.committer}));}catch{return[];}},
        async readCommit(hash){try{const [id,treeHash,parents]= (await git.git(directory,'show','-s','--format=%H%n%T%n%P',hash)).split('\n');return{hash:id,treeHash,parents:parents?.split(' ').filter(Boolean)??[]};}catch{return null;}},
        async readTree(hash){try{return (await iso.readTree({fs:nodeFs,gitdir:directory,oid:hash})).tree.map(item=>({name:item.path,hash:item.oid,type:item.type,mode:item.mode}));}catch{return null;}},
        async readBlob(hash){try{return new Blob([(await iso.readBlob({fs:nodeFs,gitdir:directory,oid:hash})).blob]);}catch{return null;}},
        async readFile({ref,path}){try{const oid=await iso.resolveRef({fs:nodeFs,gitdir:directory,ref});return new Blob([(await iso.readBlob({fs:nodeFs,gitdir:directory,oid,filepath:path})).blob]);}catch{return null;}},
        async fork(target,options){calls.push(['fork',target]);const result=await artifacts.create(target,{description:options.description,readOnly:options.readOnly,setDefaultBranch:data.defaultBranch});await git.git(directory,'push',repositories.get(target).directory,'--all');return result;},
        [Symbol.dispose](){},
      };
      repositories.set(name,repo);await hooks.create?.(repo);return {...data,token:'local-sample-initial-token'};
    },
  };
  const transport={async seedRepository(options){calls.push(['seed',options.name]);await hooks.beforeSeed?.(options);const head=await git.transport.seedRepository(options);await hooks.afterSeed?.(options,head);return head;},
    async commitCandidate(options){calls.push(['publish']);return git.transport.commitCandidate(options);},async merge(options){calls.push(['merge']);return git.transport.merge(options);}};
  const http=fixture({artifacts,git:transport,trialPolicy:{...policy,resources:approvedTrialResources,...policyOverrides}});
  t.after(()=>{http.sql.db.close();for(const context of http.contexts.values())context.db.close();});
  const store=workspaceId=>new WorkspaceStore(http.contexts.get(workspaceId).storage,workspaceId);
  const operation=workspaceId=>Object.values(store(workspaceId).read().operations).find(operation=>operation.kind==='repository-create');
  const restart=workspaceId=>{const context=http.contexts.get(workspaceId);const coordinator=new index.WorkspaceCoordinator(context.ctx,http.env);coordinator.gitTransport=()=>transport;context.coordinator=coordinator;};
  return {...http,artifacts,repositories,hooks,git,calls,store,operation,restart,count:kind=>calls.filter(call=>call[0]===kind).length};
}
