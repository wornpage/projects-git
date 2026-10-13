// Local-only provider fixture. Production coordinator, SQL store and API dispatch
// run unchanged; repository metadata and commits are explicitly synthetic.
import {RpcTarget,WorkerEntrypoint} from 'cloudflare:workers';
import {WorkspaceCoordinator} from '../../src/cloudflare/index.ts';
export class PickerCoordinator extends WorkspaceCoordinator {
  read(){return this.store.read();}
}
class Repository extends RpcTarget {
  constructor(name){super();this.name=name;}
  info(){return {name:this.name,defaultBranch:'release/next',remote:'https://fixture.invalid/secret-remote',token:'fixture-secret'};}
  log({ref,limit}){if(ref!=='release/next'||limit!==1)throw Error('Unexpected branch lookup');return this.name==='empty'?[]:[{hash:'a'.repeat(40)}];}
}
export class RepositoryService extends WorkerEntrypoint {
  list({limit,cursor}){if(limit!==20)throw Error('Unbounded list');return {repos:[{name:cursor?'empty':'starter',remote:'never-return',token:'never-return'}],total:2,...(!cursor?{cursor:'page-two'}:{})};}
  get(name){if(!['starter','empty'].includes(name))throw Error('Unknown fixture repository');return new Repository(name);}
}
export default {async fetch(request,env){
  const coordinator=env.WORKSPACES.getByName('picker');
  if(new URL(request.url).pathname==='/snapshot')return Response.json(await coordinator.read());
  return coordinator.api(await request.json());
}};
