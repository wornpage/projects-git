// Opt-in model evaluation. The expected answers are never put in model messages.
import {mkdir,rename,writeFile,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {chatProvider} from '../../src/core/agent.mjs';
import {runFreshReview} from '../../src/reviewer/run.mjs';
import {reviewerProviderOptions} from '../../src/reviewer/provider.mjs';
import {scoreReviews} from '../../src/reviewer/evaluate.mjs';
import {cases} from './reviewer-cases.mjs';

const args=process.argv.slice(2),option=name=>{
 const index=args.indexOf('--'+name);
 if(index<0||!args[index+1]||args[index+1].startsWith('--'))throw new Error('Supply --'+name+' explicitly.');
 return args[index+1];
};
const optional=name=>args.includes('--'+name)?option(name):null;
const providerKind=option('provider'),model=option('model'),maxCases=Number(option('max-cases')),
 limits={maxInputBytes:Number(option('max-input-bytes')),maxOutputTokens:Number(option('max-output-tokens')),timeoutMs:Number(option('timeout-ms'))};
if(!Number.isInteger(maxCases)||maxCases<1||maxCases>cases.length)throw new Error('Choose one to '+cases.length+' explicitly bounded cases.');
if(!['openai','workers-ai'].includes(providerKind))throw new Error('Choose an explicit OpenAI or Workers AI provider.');
const requestedIds=option('case-ids').split(',');
if(requestedIds.length!==maxCases||new Set(requestedIds).size!==requestedIds.length
  ||requestedIds.some(id=>!cases.some(item=>item.id===id)))throw new Error('Name each distinct scheduled case exactly once.');
const selected=requestedIds.map(id=>cases.find(item=>item.id===id));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const casesSha256=sha(await readFile(new URL('./reviewer-cases.mjs',import.meta.url)));
const runnerSha256=sha(await readFile(new URL('../../src/reviewer/run.mjs',import.meta.url)));
const priorPath=optional('prior-report'),priorBytes=priorPath?await readFile(resolve(priorPath)):null;
const prior=priorBytes?JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(priorBytes)):null;
if(prior&&(prior.format!=='projects-review-quality-run/v1'||prior.provider!==providerKind||prior.model!==model
  ||JSON.stringify(prior.limits)!==JSON.stringify(limits)||prior.casesSha256!==casesSha256||prior.runnerSha256!==runnerSha256
  ||!Array.isArray(prior.attempts)||prior.attempts.some(item=>!cases.some(test=>test.id===item.caseId))
  ||new Set(prior.attempts.map(item=>item.caseId)).size!==prior.attempts.length))
  throw new Error('The retained report does not match this exact suite, runner, model and budget.');
if(requestedIds.some(id=>prior?.attempts.some(item=>item.caseId===id)))
  throw new Error('An already attempted case cannot be sent to the provider again.');
const directory=resolve('qa/review-workflow/evaluations',randomUUID());
const sourceCommit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim();
const evaluatorSha256=sha(await readFile(new URL(import.meta.url)));
const report={format:'projects-review-quality-run/v1',provider:providerKind,model,limits,
  configuredCases:(prior?.attempts.length??0)+selected.length,suiteCases:cases.length,scheduledCaseIds:requestedIds,
  priorReport:priorPath?{path:resolve(priorPath),sha256:sha(priorBytes)}:null,sourceCommit,evaluatorSha256,casesSha256,runnerSha256,
  startedAt:new Date().toISOString(),attempts:structuredClone(prior?.attempts??[]),score:scoreReviews(cases,prior?.attempts??[])};
if(args.includes('--dry-run')){
  console.log(JSON.stringify({status:'dry-run',scheduledCaseIds:requestedIds,priorAttempted:prior?.attempts.length??0,
    totalAfterRun:report.configuredCases,casesSha256,runnerSha256}));process.exit(0);
}
const simulateInterruption=args.includes('--simulate-interruption-after-reservation');
if(simulateInterruption&&selected.length!==1)throw new Error('Interrupt only one reserved case in a controlled test.');
if(!simulateInterruption&&execFileSync('git',['status','--porcelain'],{encoding:'utf8',windowsHide:true}).trim())
  throw new Error('Commit and clean the source before a billable reviewer evaluation.');
if(!process.env.REVIEW_MODEL_API_KEY||!process.env.REVIEW_MODEL_ENDPOINT)throw new Error('Provide REVIEW_MODEL_API_KEY and REVIEW_MODEL_ENDPOINT privately.');
const transport=chatProvider({endpoint:process.env.REVIEW_MODEL_ENDPOINT,apiKey:process.env.REVIEW_MODEL_API_KEY,model,
  ...reviewerProviderOptions({kind:providerKind,endpoint:process.env.REVIEW_MODEL_ENDPOINT})});
await mkdir(directory,{recursive:true});
async function persist(){const next=join(directory,'report.json.tmp'),final=join(directory,'report.json');
  await writeFile(next,JSON.stringify(report,null,2)+'\n',{mode:0o600});await rename(next,final);}
await persist();
for(const item of selected){
 let initialized=false,providerSaved=false;
 const path=join(directory,item.id+'.json'),providerPath=join(directory,item.id+'.provider.json');
 const attempt={caseId:item.id,status:'reserved',receipt:path,providerReceipt:null};
 report.attempts.push(attempt);report.score=scoreReviews(cases,report.attempts);
 await persist(); // A crash after this point still prevents a second provider request for this case.
 if(simulateInterruption){console.log(JSON.stringify({status:'interrupted-after-reservation',report:join(directory,'report.json'),caseId:item.id}));process.exit(0);}
 const save=async receipt=>{const next=path+'.tmp',content=JSON.stringify(receipt,null,2)+'\n';
  if(!initialized){await writeFile(path,content,{flag:'wx',mode:0o600});initialized=true;return;}
  await writeFile(next,content,{mode:0o600});await rename(next,path);};
 try{
  const result=await runFreshReview({mode:'evaluate',runId:item.packet.context.runId,model,limits,
    readContext:async()=>item.packet,provider:async request=>{
      const response=await transport(request);
      const content=typeof response.content==='string'&&new TextEncoder().encode(response.content).byteLength<=131072?response.content:null;
      await writeFile(providerPath,JSON.stringify({content,contentSha256:typeof response.content==='string'?sha(response.content):null,
        finishReason:response.finishReason,usage:response.usage},null,2)+'\n',{flag:'wx',mode:0o600});providerSaved=true;
      return response;
    },save});
  Object.assign(attempt,{status:result.receipt.status,assessment:result.assessment,providerReceipt:providerPath});
 }catch(error){Object.assign(attempt,{status:'failed',error:String(error?.message??error).slice(0,2000),
   providerReceipt:providerSaved?providerPath:null});
   report.score=scoreReviews(cases,report.attempts);await persist();break;}
 report.score=scoreReviews(cases,report.attempts);await persist();
}
report.finishedAt=new Date().toISOString();await persist();
console.log(JSON.stringify({report:join(directory,'report.json'),cases:report.score.cases,blockingFindings:report.score.blockingFindings,verdicts:report.score.verdicts}));
