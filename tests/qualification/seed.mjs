import {execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir,access} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {git} from './git.mjs';
import {credentialDirectory,readSetup} from './setup.mjs';
const setup=await readSetup(),directory=credentialDirectory();await mkdir(directory,{recursive:true});
const privateReceipt=join(directory,'seed-created.json'),namespace=setup.artifactsNamespace,repository=setup.repository;
let raw;try{raw=await readFile(privateReceipt,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;
  raw=execFileSync(process.execPath,['node_modules/wrangler/bin/wrangler.js','artifacts','repos','create',repository,'--namespace',namespace,'--default-branch','main','--description','Private identity/concurrency qualification fixture','--json'],{encoding:'utf8',windowsHide:true,timeout:60000});await writeFile(privateReceipt,raw,{flag:'wx',mode:0o600});}
const repo=JSON.parse(raw);if(!repo.remote||!repo.token)throw Error('Unexpected repository creation result; inspect the private receipt without repeating creation.');
const checkout=resolve('qa/identity-concurrency/seed');await mkdir(checkout,{recursive:true});await mkdir('qa/identity-concurrency/empty-hooks',{recursive:true});
let present=true;try{await access(join(checkout,'.git'));}catch{present=false;}
if(!present){await git(['init','-b','main'],checkout);await git(['config','user.name','Scripted qualification'],checkout);await git(['config','user.email','qualification@example.invalid'],checkout);
  await writeFile(join(checkout,'checkout.mjs'),await readFile('fixtures/checkout.mjs'));
  await writeFile(join(checkout,'README.md'),'# Private qualification fixture\n\nScripted agents and model fixtures. No user source or provider inference.\n');
  await git(['add','.'],checkout);await git(['commit','-m','Seed private identity and concurrency fixture'],checkout);}
const head=await git(['rev-parse','HEAD'],checkout);await git(['push',repo.remote,'HEAD:main'],checkout,{remote:repo.remote,token:repo.token});
const remote=await git(['ls-remote',repo.remote,'refs/heads/main'],checkout,{remote:repo.remote,token:repo.token});if(!remote.startsWith(head+'\t'))throw Error('Seed readback disagrees');
const receipt={namespace,repository,remote:repo.remote,head,at:new Date().toISOString(),scripted:true};await writeFile('qa/identity-concurrency/seed.json',JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt,null,2));
