import type {HostedSnapshot} from '../../src/cloudflare/controller.ts';
// Private fault control: select the retained source run for base updates, and
// the assigned/result run for other operations. An observed attempt can pin it.
export function expireQualificationOperation(snapshot: HostedSnapshot,runId:string,attemptId?:string):boolean {
  let changed=false;
  for(const operation of Object.values(snapshot.operations))if(operation.state==='pending'
    &&(operation.itemId===runId||operation.sourceRunId===runId)&&(!attemptId||operation.attemptId===attemptId)){
    operation.leaseUntil=0;changed=true;
  }
  return changed;
}
