import {readFile,writeFile,appendFile,mkdir,readdir,rename} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const phases=['install','audit','images','tests','types','qualification-types','build'];
const path='qa/ci/receipt.json';
export function testTotals(log){
  const clean=log.replace(/\u001b\[[0-9;]*m/g,'');
  const totals={};
  for(const name of ['tests','pass','fail','cancelled','skipped','todo']){
    const matches=[...clean.matchAll(new RegExp('(?:^|\\n)\\s*[ℹ#]\\s*'+name+' (\\d+)\\s*(?=\\r?\\n|$)','g'))];
    if(!matches.length)throw Error('Test output lacks the '+name+' denominator.');
    totals[name]=Number(matches.at(-1)[1]);
  }
  if(totals.tests<1||totals.pass+totals.fail+totals.cancelled+totals.skipped!==totals.tests)throw Error('Test denominator disagrees with outcomes.');
  return totals;
}
export function checkOutcome(name,exitCode,log){
  if(!phases.includes(name)||!Number.isInteger(exitCode))throw Error('Unknown phase or exit code.');
  const result={status:exitCode===0?'passed':'failed',exitCode};
  if(name==='audit'){
    try{
      const counts=JSON.parse(log).metadata?.vulnerabilities;
      if(!counts||['info','low','moderate','high','critical','total'].some(field=>!Number.isSafeInteger(counts[field])||counts[field]<0)||counts.total!==counts.info+counts.low+counts.moderate+counts.high+counts.critical)throw Error('Audit output lacks valid vulnerability totals.');
      result.vulnerabilities=counts;
      if(counts.high||counts.critical)result.status='failed';
    }catch(error){result.status='failed';result.error=error.message;}
  }
  if(name==='tests'){
    try{
      result.totals=testTotals(log);
      if(result.totals.fail||result.totals.cancelled||result.totals.skipped||result.totals.todo)result.status='failed';
    }catch(error){result.status='failed';result.error=error.message;}
  }
  return result;
}
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const git=(...args)=>execFileSync('git',args,{encoding:'utf8',windowsHide:true}).trim();
async function save(receipt){await writeFile(path,JSON.stringify(receipt,null,2)+'\n');}
async function main(){
  const [command,name,code]=process.argv.slice(2);
  if(command==='init'){
    await mkdir('qa/ci',{recursive:true});
    const prior=(await readdir('qa/ci',{withFileTypes:true})).filter(item=>item.isFile()&&(item.name.endsWith('.log')||['receipt.json','summary.md'].includes(item.name)));
    if(prior.length){
      const retained='qa/ci/history/'+Date.now()+'-'+crypto.randomUUID();await mkdir(retained,{recursive:true});
      for(const item of prior)await rename('qa/ci/'+item.name,retained+'/'+item.name);
    }
    const head=git('rev-parse','HEAD');
    const receipt={format:'projects-git-ci-v1',status:'running',startedAt:new Date().toISOString(),source:{commit:head,tree:git('rev-parse','HEAD^{tree}'),trackedChanges:git('status','--porcelain','--untracked-files=no'),lockSha256:digest(await readFile('package-lock.json')),dockerfileSha256:digest(await readFile('containers/verification/Dockerfile'))},runner:{node:process.version,platform:process.platform,architecture:process.arch,runId:process.env.GITHUB_RUN_ID??null,attempt:process.env.GITHUB_RUN_ATTEMPT??null,event:process.env.GITHUB_EVENT_NAME??'local',eventCommit:process.env.GITHUB_SHA??null},runtime:null,checks:Object.fromEntries(phases.map(phase=>[phase,{status:'not-run'}])),limits:{executionSlots:4,verificationAttempts:2},scope:'Source and local Docker fixture proof; no real Access, hosted Durable Objects, model-provider inference, deployment or human acceptance.'};
    await save(receipt);return;
  }
  const receipt=JSON.parse(await readFile(path,'utf8'));
  if(receipt.source.commit!==git('rev-parse','HEAD'))throw Error('Source commit changed during CI.');
  if(command==='start'){
    if(!phases.includes(name)||receipt.checks[name].status!=='not-run')throw Error('Check phase already started or is unknown.');
    receipt.checks[name]={status:'running',startedAt:new Date().toISOString()};await save(receipt);return;
  }
  if(command==='image'){
    if(!/^sha256:[a-f0-9]{64}$/.test(name))throw Error('Runtime image must be immutable.');
    receipt.runtime={image:name,platform:'linux/amd64',environment:['PROJECTS_SANDBOX_TEST_IMAGE','PROJECTS_PYTHON_TEST_IMAGE','PROJECTS_HOSTED_TEST_IMAGE'],baseImages:(await readFile('containers/verification/Dockerfile','utf8')).split(/\r?\n/).filter(line=>line.startsWith('FROM ')).map(line=>line.split(' ')[1])};
    if(receipt.runtime.baseImages.some(image=>!/@sha256:[a-f0-9]{64}$/.test(image)))throw Error('Runtime base image is not pinned.');
    await save(receipt);return;
  }
  if(command==='record'){
    if(!phases.includes(name))throw Error('Unknown check phase.');
    const log=await readFile('qa/ci/'+name+'.log','utf8');
    const outcome=checkOutcome(name,Number(code),log);
    receipt.checks[name]={...receipt.checks[name],...outcome,finishedAt:new Date().toISOString(),logSha256:digest(log)};
    await save(receipt);if(outcome.status==='failed')process.exitCode=1;return;
  }
  if(command!=='finish')throw Error('Use init, start, image, record or finish.');
  for(const phase of phases)if(receipt.checks[phase].status==='running')receipt.checks[phase].status='interrupted';
  receipt.finishedAt=new Date().toISOString();
  receipt.source.finalTrackedChanges=git('status','--porcelain','--untracked-files=no');
  receipt.status=phases.every(phase=>receipt.checks[phase].status==='passed')&&receipt.runtime&&!receipt.source.trackedChanges&&!receipt.source.finalTrackedChanges?'passed':'failed';
  await save(receipt);
  const counts=receipt.checks.tests.totals;
  const audit=receipt.checks.audit.vulnerabilities;
  const auditSummary=audit?`Dependency audit: ${audit.total} findings (${audit.high} high, ${audit.critical} critical, ${audit.moderate} moderate, ${audit.low} low, ${audit.info} info).`:'Dependency audit: no validated counts.';
  const summary='# Private CI\n\nCommit: `'+receipt.source.commit+'`\n\nStatus: **'+receipt.status+'**\n\n| Check | Status |\n| --- | --- |\n'+phases.map(phase=>'| '+phase+' | '+receipt.checks[phase].status+' |').join('\n')+'\n\nTests: '+(counts?`${counts.pass}/${counts.tests} passed; ${counts.fail} failed; ${counts.skipped} skipped; ${counts.cancelled} cancelled; ${counts.todo} todo.`:'Not completed; no passing denominator.')+'\n\n'+receipt.scope+'\n';
  await writeFile('qa/ci/summary.md',summary+'\n'+auditSummary+'\n');
  if(process.env.GITHUB_STEP_SUMMARY)await appendFile(process.env.GITHUB_STEP_SUMMARY,summary+'\n'+auditSummary+'\n');
  console.log(JSON.stringify({commit:receipt.source.commit,status:receipt.status,tests:counts??null}));
  if(receipt.status!=='passed')process.exitCode=1;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
