import {readFile} from 'node:fs/promises';
import {isAbsolute,relative,resolve,sep} from 'node:path';

export const setupPath='qa/identity-concurrency/access-setup.json';
export function credentialDirectory(env=process.env,root=process.cwd()) {
  const value=env.PROJECTS_QUALIFICATION_CREDENTIAL_DIR;
  if(!value||!isAbsolute(value))throw Error('Set PROJECTS_QUALIFICATION_CREDENTIAL_DIR to an absolute directory outside the source checkout.');
  const directory=resolve(value),fromRoot=relative(resolve(root),directory);
  if(!fromRoot||(!isAbsolute(fromRoot)&&fromRoot!=='..'&&!fromRoot.startsWith('..'+sep)))throw Error('Qualification credentials must stay outside the source checkout.');
  return directory;
}
export async function readSetup(path=setupPath) {
  const setup=JSON.parse(await readFile(path,'utf8'));
  const fields={account:/^[a-f0-9]{32}$/,workerName:/^[a-z0-9][a-z0-9-]{0,49}$/,artifactsNamespace:/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/,repository:/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/,hostname:/^[a-z0-9.-]+$/,issuer:/^https:\/\/[a-z0-9][a-z0-9-]*\.cloudflareaccess\.com$/,audience:/^[a-f0-9]{64}$/,workspace:/^[A-Za-z0-9_.-]{1,100}$/,ownerEmail:/^[^\s@]+@[^\s@]+$/};
  for(const [field,pattern]of Object.entries(fields))if(typeof setup[field]!=='string'||!pattern.test(setup[field]))throw Error('Configure a valid qualification '+field+' in '+path+'.');
  if(setup.accessApplicationId!==undefined&&setup.accessApplicationId!==''
    &&(typeof setup.accessApplicationId!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(setup.accessApplicationId)))
    throw Error('Configure a valid qualification accessApplicationId in '+path+'.');
  if(setup.reviewerSubjects!==undefined&&(!Array.isArray(setup.reviewerSubjects)||setup.reviewerSubjects.length>100
    ||setup.reviewerSubjects.some(id=>typeof id!=='string'||!(/^[A-Za-z0-9_.:@-]{1,200}$/).test(id)||id===setup.ownerSubject)
    ||new Set(setup.reviewerSubjects).size!==setup.reviewerSubjects.length))throw Error('Configure distinct verified human reviewer subjects outside the owner.');
  return setup;
}
