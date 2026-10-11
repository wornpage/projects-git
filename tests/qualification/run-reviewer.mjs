// Private qualification entrypoint. Do not run without an approved model,
// explicit limits, a current reviewer JWT, and the harness private binding.
import {mkdir,rename,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {chatProvider} from '../../src/core/agent.mjs';
import {runFreshReview} from '../../src/reviewer/run.mjs';
import {reviewerProviderOptions} from '../../src/reviewer/provider.mjs';
import {readSetup} from './setup.mjs';

const args=process.argv.slice(2),option=name=>{
  const index=args.indexOf('--'+name);
  if(index<0 || !args[index+1] || args[index+1].startsWith('--'))throw new Error('Supply --'+name+' explicitly.');
  return args[index+1];
};
const runId=option('run-id'),model=option('model'),providerKind=option('provider');
const limits={maxInputBytes:Number(option('max-input-bytes')),maxOutputTokens:Number(option('max-output-tokens')),
  timeoutMs:Number(option('timeout-ms'))};
if(!process.env.REVIEW_MODEL_API_KEY || !process.env.REVIEW_MODEL_ENDPOINT)throw new Error('Provide REVIEW_MODEL_API_KEY and REVIEW_MODEL_ENDPOINT in the private operator environment.');
const setup=await readSetup();
const source={commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim(),
  tree:execFileSync('git',['rev-parse','HEAD^{tree}'],{encoding:'utf8',windowsHide:true}).trim()};
if(execFileSync('git',['status','--porcelain'],{encoding:'utf8',windowsHide:true}).trim())
  throw new Error('Commit the exact reviewer source before a billable run.');
const provider=chatProvider({endpoint:process.env.REVIEW_MODEL_ENDPOINT,apiKey:process.env.REVIEW_MODEL_API_KEY,model,
  ...reviewerProviderOptions({kind:providerKind,endpoint:process.env.REVIEW_MODEL_ENDPOINT,account:setup.account})});
const {readContext,reserveReview,submitAssessment}=await import('./reviewer-transport.mjs');
const directory=resolve('qa/review-workflow/attempts');await mkdir(directory,{recursive:true});
const path=join(directory,runId+'-'+randomUUID()+'.json');
let initialized=false;
const save=async receipt=>{
  const temporary=path+'.tmp';
  const record={...receipt,provider:providerKind,workspace:setup.workspace,source};
  if(!initialized){await writeFile(path,JSON.stringify(record,null,2)+'\n',{flag:'wx',mode:0o600});initialized=true;return;}
  await writeFile(temporary,JSON.stringify(record,null,2)+'\n',{mode:0o600});await rename(temporary,path);
};
const result=await runFreshReview({runId,model,limits,provider,save,
  readContext,reserveReview,submitAssessment});
console.log(JSON.stringify({status:result.receipt.status,runId,assessmentId:result.assessment.id,receipt:path}));
