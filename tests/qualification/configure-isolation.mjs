import {readFile,writeFile} from 'node:fs/promises';
const config=JSON.parse(await readFile('qa/identity-concurrency/hosted.wrangler.jsonc','utf8'));
config.name+='-second';config.workers_dev=false;config.preview_urls=false;config.vars.WORKSPACE_ID+='-isolation';config.vars.ACCESS_AGENT_CLIENT_IDS='[]';
config.services=config.services.map(binding=>binding.binding==='CURRENT_POLICY'?{...binding,service:config.name}:binding);
config.vars.ACCESS_REVIEWER_CLIENT_IDS='[]';
config.vars.ACCESS_REVIEWER_SUBJECTS='[]';
// Owner-only and private-binding-only: the first workspace's agent credentials
// do not gain access to this independent capacity qualification workspace.
await writeFile('qa/identity-concurrency/second.wrangler.jsonc',JSON.stringify(config,null,2));
const driver=JSON.parse(await readFile('qa/identity-concurrency/driver.wrangler.jsonc','utf8'));
driver.services=driver.services.filter(s=>!s.binding.startsWith('SECOND'));
driver.services.push({binding:'SECOND',service:config.name,remote:true},{binding:'SECOND_CONTROL',service:config.name,entrypoint:'QualificationControl',remote:true});
await writeFile('qa/identity-concurrency/driver.wrangler.jsonc',JSON.stringify(driver,null,2));
console.log(JSON.stringify({worker:config.name,workspace:config.vars.WORKSPACE_ID,publicHostname:false,agentAccess:false}));
