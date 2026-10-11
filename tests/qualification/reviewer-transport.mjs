// Reviewer-only private binding transport. Builder and owner credentials are not loaded.
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {credentialDirectory,readSetup} from './setup.mjs';

const setup=await readSetup(),privateDirectory=credentialDirectory();
const reviewerJWT=(await readFile(join(privateDirectory,'reviewer-jwt-0'),'utf8')).trim();
const harnessKey=(await readFile('qa/identity-concurrency/.dev.vars','utf8')).match(/^HARNESS_KEY=(.+)$/m)?.[1]?.trim();
if(!reviewerJWT||!harnessKey||!setup.workspace)throw new Error('Private reviewer transport is not configured.');

async function call(path,body,key){
  const response=await fetch('http://127.0.0.1:8819/direct',{method:'POST',redirect:'error',signal:AbortSignal.timeout(145000),
    headers:{'Content-Type':'application/json','X-Qualification-Key':harnessKey},
    body:JSON.stringify({workspace:'primary',path,method:body===undefined?'GET':'POST',
      headers:{'Cf-Access-Jwt-Assertion':reviewerJWT,'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{})},body})});
  if(!response.ok)throw new Error('Private review binding returned HTTP '+response.status+'.');
  let result;try{result=await response.json();}catch{throw new Error('Private review binding returned unreadable JSON.');}
  if(!Number.isInteger(result.status))throw new Error('Private review binding omitted its application status.');
  if(result.status<200||result.status>=300){const error=new Error('Review service refused the request.');error.status=result.status;error.code=result.result?.code;throw error;}
  return result.result;
}

export const readContext=runId=>call(`/api/runs/${runId}/review-context`);
export const reserveReview=(runId,reservation,key)=>call(`/api/runs/${runId}/review-inference`,reservation,key);
export const submitAssessment=(runId,assessment,key,reviewAttemptId)=>call(`/api/runs/${runId}/code-review`,{...assessment,reviewAttemptId},key);
