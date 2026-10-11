// Read-only Cloudflare Access preflight. Requires a temporary account-scoped
// administrator API token but never prints it or writes service secrets.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {credentialDirectory,readSetup} from './setup.mjs';
import {fetchAccessInventory,verifyAccessBoundary} from './access-preflight.mjs';

const setup=await readSetup();
const apiToken=process.env.CLOUDFLARE_API_TOKEN;
if(!apiToken)throw new Error('Supply the temporary Access administrator API token privately.');
if(!/^[a-f0-9-]{36}$/.test(setup.accessApplicationId??''))
  throw new Error('Record the qualification Access application ID before preflight.');
const privateDirectory=credentialDirectory();
const agents=JSON.parse(await readFile(join(privateDirectory,'agents.json'),'utf8'));
const reviewers=JSON.parse(await readFile(join(privateDirectory,'reviewers.json'),'utf8'));
const source={commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim(),
  tree:execFileSync('git',['rev-parse','HEAD^{tree}'],{encoding:'utf8',windowsHide:true}).trim()};
if(execFileSync('git',['status','--porcelain'],{encoding:'utf8',windowsHide:true}).trim())
  throw new Error('Commit the exact source before checking the hosted Access boundary.');
const receipt={format:'projects-review-access-preflight/v1',startedAt:new Date().toISOString(),
  account:setup.account,workspace:setup.workspace,source,status:'failed'};
const output='qa/identity-concurrency/access-preflight.json';
try{
  const {application,policies,tokens}=await fetchAccessInventory({account:setup.account,
    applicationId:setup.accessApplicationId,apiToken});
  receipt.observation=verifyAccessBoundary({setup,agents,reviewers,
    application,policies,tokens,now:Date.now()});
  receipt.status='passed';
}catch(error){
  receipt.error=String(error?.message??error).slice(0,500);
  throw error;
}finally{
  receipt.finishedAt=new Date().toISOString();
  await mkdir('qa/identity-concurrency',{recursive:true});
  await writeFile(output,JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({status:receipt.status,receipt:output,serviceTokenCount:receipt.observation?.serviceTokens.length??0}));
}
