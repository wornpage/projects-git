import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {credentialDirectory,readSetup} from './setup.mjs';
import {verifyAccessReceipt} from './access-preflight.mjs';
const source={commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim(),
  tree:execFileSync('git',['rev-parse','HEAD^{tree}'],{encoding:'utf8',windowsHide:true}).trim(),
  clean:!execFileSync('git',['status','--porcelain'],{encoding:'utf8',windowsHide:true}).trim()};
if(!source.clean)throw Error('Hosted qualification requires a clean, committed source snapshot.');
export const setup=await readSetup();
export const privateDirectory=credentialDirectory();
export const agents=JSON.parse(await readFile(join(privateDirectory,'agents.json'),'utf8'));
export const reviewers=JSON.parse(await readFile(join(privateDirectory,'reviewers.json'),'utf8'));
const preflight=JSON.parse(await readFile('qa/identity-concurrency/access-preflight.json','utf8'));
verifyAccessReceipt({receipt:preflight,setup,agents,reviewers,source});
const driverKey=(await readFile('qa/identity-concurrency/.dev.vars','utf8')).match(/^HARNESS_KEY=(.+)$/m)?.[1]?.trim();
if(!driverKey)throw Error('Local harness credential is missing.');
export async function ownerToken(){return (await readFile(join(homedir(),'.cloudflared',setup.hostname+'-'+setup.audience+'-token'),'utf8')).trim();}
export const receipt={runtime:'real-cloudflare',startedAt:new Date().toISOString(),workspace:setup.workspace,hostname:setup.hostname,scenarios:[],requests:[],peakOccupied:0,limitations:'Scripted HTTP agents and model fixture. Real Access, Worker, Durable Objects, Artifacts, and container checks. No model-provider inference.'};
const secrets=[driverKey,...agents.map(a=>a.client_secret),...reviewers.map(reviewer=>reviewer.client_secret)];
export function rememberSecret(value){if(value){secrets.push(value);const prefix=value.split('?')[0];if(prefix!==value)secrets.push(prefix);}}
export function sanitize(value){let text=typeof value==='string'?value:JSON.stringify(value);for(const secret of secrets)if(secret)text=text.replaceAll(secret,'[redacted]');return text.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,'[redacted-jwt]');}
async function decode(response){const raw=await response.text();let result;try{result=JSON.parse(raw);}catch{result={nonJson:true,preview:sanitize(raw).slice(0,200)};}return {status:response.status,result};}
export async function control(path,body={}){return decode(await fetch('http://127.0.0.1:8819'+path,{method:'POST',headers:{'X-Qualification-Key':driverKey,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(145000)}));}
export async function request(principal,path,body,key=crypto.randomUUID(),headers={},workspace='primary'){
  const common={'Content-Type':'application/json','Idempotency-Key':key,...headers};let response;
  let token;
  if(principal==='owner')token=await ownerToken();
  else if(typeof principal==='string'&&/^reviewer:[01]$/.test(principal))
    token=(await readFile(join(privateDirectory,`reviewer-jwt-${principal.at(-1)}`),'utf8')).trim();
  else if(typeof principal==='object')token=principal.token;
  else if(agents[principal]){const sessions=JSON.parse(await readFile(join(privateDirectory,'requalification-agent-sessions.json'),'utf8'));token=sessions[principal].token;}
  response=await control('/direct',{workspace,path,method:body===undefined?'GET':'POST',headers:{...common,...(token?{'Cf-Access-Jwt-Assertion':token}:{})},body});
  receipt.requests.push({workspace,path,key,status:response.status,code:response.result?.code,principal:principal==='owner'?'owner':typeof principal==='string'&&/^reviewer:[01]$/.test(principal)?reviewers[Number(principal.at(-1))]?.client_id:typeof principal==='number'?agents[principal]?.client_id??'unauthenticated':'supplied-session',transport:'private-service-binding'});
  return response;
}
export async function ok(...args){const r=await request(...args);if(r.status<200||r.status>=300)throw Error('Request '+args[1]+' returned '+r.status+': '+sanitize(r.result));return r.result;}
export const passed=name=>{receipt.scenarios.push({name,status:'passed'});console.log('PASS '+name);};
export async function save(name,error){receipt.status=error?'failed':'passed';if(error)receipt.error=sanitize(error.message);receipt.finishedAt=new Date().toISOString();await mkdir('qa/identity-concurrency/hosted',{recursive:true});const path='qa/identity-concurrency/hosted/'+name+'-'+Date.now()+'.json';await writeFile(path,sanitize(receipt));console.log(JSON.stringify({path,status:receipt.status,passed:receipt.scenarios.length,error:receipt.error}));}
export async function waitFor(read,predicate,label,timeoutMs=60000){const end=Date.now()+timeoutMs;while(Date.now()<end){const value=await read();if(predicate(value))return value;await new Promise(resolve=>setTimeout(resolve,200));}throw Error('Deadline waiting for observed state: '+label);}
