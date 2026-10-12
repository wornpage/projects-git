import {readFile,writeFile} from 'node:fs/promises';import {join,resolve} from 'node:path';import {randomBytes} from 'node:crypto';
import {credentialDirectory,readSetup,setupPath} from './setup.mjs';
const setup=await readSetup();
if(!setup.ownerSubject||!setup.ownerVerifiedAt)throw Error('Pin a verified owner session before configuring workspace resources.');
const agents=JSON.parse(await readFile(join(credentialDirectory(),'agents.json'),'utf8'));
const tokenId=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
if(!Array.isArray(agents)||agents.length!==8||agents.some(agent=>!tokenId.test(agent?.id)
  ||agent.duration!=='24h'||typeof agent.client_id!=='string'||!agent.client_id.trim()
  ||typeof agent.client_secret!=='string'||!agent.client_secret.trim())
  ||new Set(agents.map(agent=>agent.id)).size!==8||new Set(agents.map(agent=>agent.client_id)).size!==8)
  throw Error('Eight distinct individually approved 24-hour credentials are required.');
const reviewers=JSON.parse(await readFile(join(credentialDirectory(),'reviewers.json'),'utf8'));
if(!Array.isArray(reviewers)||reviewers.length!==2||reviewers.some(reviewer=>!tokenId.test(reviewer?.id)
  ||!/^([a-f0-9]{32})\.access$/.test(reviewer.client_id)
  ||agents.some(agent=>agent.client_id===reviewer.client_id||agent.id===reviewer.id)||reviewer.duration!=='24h'
  ||typeof reviewer.client_secret!=='string'||!reviewer.client_secret.trim())
  ||new Set(reviewers.map(reviewer=>reviewer.id)).size!==2
  ||new Set(reviewers.map(reviewer=>reviewer.client_id)).size!==2)
  throw Error('Two distinct approved 24-hour reviewer service credentials are required outside the builder list.');
const config={name:setup.workerName,account_id:setup.account,main:'../../tests/qualification/worker.ts',compatibility_date:'2026-10-05',compatibility_flags:['nodejs_compat'],workers_dev:false,preview_urls:false,routes:[],
  assets:{directory:'../../public',binding:'ASSETS',run_worker_first:true},
  vars:{WORKSPACE_ID:setup.workspace,ACCESS_TEAM_DOMAIN:setup.issuer,ACCESS_AUD:setup.audience,ACCESS_OWNER_SUB:setup.ownerSubject,ACCESS_AGENT_CLIENT_IDS:JSON.stringify(agents.map(agent=>agent.client_id)),MODEL:'scripted-qualification-fixture',MODEL_REPOSITORY:setup.repository,MODEL_ENDPOINT:'',SEARCH_EMBEDDINGS_ENABLED:'false'},
  services:[{binding:'CURRENT_POLICY',service:setup.workerName,entrypoint:'WorkspacePolicy'}],
  worker_loaders:[{binding:'LOADER'}],artifacts:[{binding:'ARTIFACTS',namespace:setup.artifactsNamespace}],
  containers:[{class_name:'RepositoryCheckContainer',scheduling_policy:'durable_object',images:{verifier:{dockerfile:'../../containers/verification/Dockerfile'}}}],
  durable_objects:{bindings:[{name:'WORKSPACES',class_name:'WorkspaceCoordinator'},{name:'REPOSITORY_CHECKS',class_name:'RepositoryCheckContainer'},{name:'GATES',class_name:'QualificationGates'}]},
  migrations:[{tag:'v1',new_sqlite_classes:['WorkspaceCoordinator','RepositoryCheckContainer','QualificationGates']}],observability:{enabled:false}};
config.vars.ACCESS_REVIEWER_CLIENT_IDS=JSON.stringify(reviewers.map(reviewer=>reviewer.client_id));
const reviewerSubjects=setup.reviewerSubjects??[];
if(reviewerSubjects.some(id=>agents.some(agent=>agent.client_id===id)||reviewers.some(reviewer=>reviewer.client_id===id)))throw Error('Human reviewer subjects must be distinct from builder and service identities.');
config.vars.ACCESS_REVIEWER_SUBJECTS=JSON.stringify(reviewerSubjects);
await writeFile('qa/identity-concurrency/hosted.wrangler.jsonc',JSON.stringify(config,null,2));
const driver={name:setup.workerName+'-local-driver',main:'../../tests/qualification/driver.ts',compatibility_date:'2026-10-05',compatibility_flags:['nodejs_compat'],workers_dev:false,preview_urls:false,
  services:[{binding:'TARGET',service:config.name,remote:true},{binding:'CONTROL',service:config.name,entrypoint:'QualificationControl',remote:true}]};
await writeFile('qa/identity-concurrency/driver.wrangler.jsonc',JSON.stringify(driver,null,2));
try{await readFile('qa/identity-concurrency/.dev.vars');}catch(error){if(error.code!=='ENOENT')throw error;await writeFile('qa/identity-concurrency/.dev.vars','HARNESS_KEY='+randomBytes(32).toString('hex')+'\n',{flag:'wx',mode:0o600});}
setup.agentCredentialsCreated=8;setup.agentClientIds=agents.map(({id,name,client_id,duration})=>({id,name,clientId:client_id,duration}));
await writeFile(setupPath,JSON.stringify(setup,null,2));
console.log(JSON.stringify({configuration:resolve('qa/identity-concurrency/hosted.wrangler.jsonc'),workspace:setup.workspace,agentCount:agents.length,reviewerCount:reviewers.length,fixtureModel:true,providerCalls:0}));
