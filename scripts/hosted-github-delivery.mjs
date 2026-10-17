import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {prepareHostedDelivery,openHostedDelivery,readHostedHandoff,withHostedDeliveryLock,hostedDeliveryLock} from '../src/local/hosted-github-delivery.mjs';
import {GitHubClient} from '../src/local/github-client.mjs';

const usage=`Operator-local GitHub delivery of a historical hosted merged candidate.
prepare --handoff ABSOLUTE_FILE --sha256 DIGEST --workspace ID --run UUID --base SHA --head SHA --tree SHA --source ABSOLUTE_GIT_REPOSITORY --directory NEW_ABSOLUTE_DIRECTORY --repository owner/private-repo
preview --directory ABSOLUTE_DIRECTORY --repository owner/private-repo
publish --directory ABSOLUTE_DIRECTORY --repository owner/private-repo --preview UUID --request UUID --approve APPROVAL_SHA256
refresh --directory ABSOLUTE_DIRECTORY --repository owner/private-repo --request UUID
resume --directory ABSOLUTE_DIRECTORY --repository owner/private-repo --request UUID --approve APPROVAL_SHA256
status --directory ABSOLUTE_DIRECTORY --repository owner/private-repo
lock --directory ABSOLUTE_DIRECTORY
release-lock --directory ABSOLUTE_DIRECTORY --lock UUID
prepare is offline. preview and refresh read GitHub. publish and resume require explicit approval; repository workflows may run. GitHub merge and deployment are separate.
The handoff checksum is not authenticated or current hosted authority. Credentials remain in the operator's gh account. See docs/github-publication.md.`;
const options={prepare:['handoff','sha256','workspace','run','base','head','tree','source','directory','repository'],
  preview:['directory','repository'],publish:['directory','repository','preview','request','approve'],refresh:['directory','repository','request'],
  resume:['directory','repository','request','approve'],status:['directory','repository'],lock:['directory'],'release-lock':['directory','lock']};
export function deliveryArguments(args){
  const [action,...rest]=args;if(action==='--help'&&rest.length===0)return {action:'help'};
  const names=options[action];if(!names)throw Error('Invalid command. Use --help.');const values={};
  for(let index=0;index<rest.length;index+=2){const key=rest[index].slice(2),value=rest[index+1];
    if(!rest[index].startsWith('--')||!names.includes(key)||Object.hasOwn(values,key)||!value||value.startsWith('--'))throw Error('Invalid options. Use --help.');values[key]=value;}
  if(names.some(key=>!Object.hasOwn(values,key)))throw Error('Missing options. Use --help.');return {action,...values};
}
export async function runDelivery(args,{providerFactory=repository=>new GitHubClient(repository)}={}){
  const input=deliveryArguments(args),{action}=input;if(action==='help')return {help:usage};
  if(action==='prepare')return prepareHostedDelivery({handoffText:await readHostedHandoff(input.handoff),source:input.source,directory:input.directory,repository:input.repository,
    expected:{workspaceId:input.workspace,runId:input.run,baseCommit:input.base,headCommit:input.head,tree:input.tree,handoffSha256:input.sha256}});
  if(action==='lock'||action==='release-lock')return hostedDeliveryLock(input.directory,input.lock);
  return withHostedDeliveryLock(input.directory,async()=>{
    const delivery=await openHostedDelivery(input.directory,providerFactory(input.repository));
    if(action==='preview')return delivery.preview();
    if(action==='publish')await delivery.publish({previewId:input.preview,requestId:input.request,approvalSha256:input.approve});
    if(action==='refresh')await delivery.refresh(input.request);
    if(action==='resume')await delivery.resume(input.request,input.approve);
    return delivery.receipt();
  });
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const result=await runDelivery(process.argv.slice(2));console.log(result.help??JSON.stringify(result,null,2));
    if(result.publication?.status==='needs_attention'||result.publication?.status==='changed')process.exitCode=1;
  }catch{console.error('Hosted delivery did not complete. No operation was automatically repeated. Inspect local status or its lock, preserve failed attempts, and use --help.');process.exitCode=2;}
}
