import {cp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {prepareAccessFixture} from './access-fixture.mjs';

// Stage source and public fixture keys only. Account credentials and the private
// signing key never enter the Docker development container or its build context.
const id='identity-'+Date.now(),directory=resolve('qa/identity-concurrency',id);
const source=resolve(directory,'source'),port=Number(process.argv[2]??8793);
if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Choose an unprivileged local port.');
await mkdir(source,{recursive:true});
for(const entry of ['src','public','fixtures','containers','tests/runtime','migrations','scripts','package.json','package-lock.json','tsconfig.cloudflare.json']) {
  await cp(resolve(entry),resolve(source,entry),{recursive:true});
}
const fixture=await prepareAccessFixture(resolve(directory,'access-private.json'));
const config=JSON.parse(await readFile('tests/runtime/wrangler.jsonc','utf8'));
const image=execFileSync('docker',['image','inspect','projects-git-verifier:identity','--format','{{.Id}}'],{encoding:'utf8',windowsHide:true}).trim();
if(!/^sha256:[a-f0-9]{64}$/.test(image))throw new Error('Build containers/verification/Dockerfile as projects-git-verifier:identity first.');
Object.assign(config.vars,fixture.vars,{FIXTURE_VERIFIER_IMAGE:image});
await writeFile(resolve(source,'tests/runtime/wrangler.generated.json'),JSON.stringify(config,null,2));
const name='projects-agent-'+id;
const gateway=execFileSync('docker',['network','inspect','bridge','--format','{{(index .IPAM.Config 0).Gateway}}'],{encoding:'utf8',windowsHide:true}).trim();
if(!/^\d{1,3}(\.\d{1,3}){3}$/.test(gateway))throw new Error('Expected an IPv4 Docker bridge gateway.');
const command='mkdir -p /workspace && cp -a /seed/. /workspace/ && cd /workspace && npm ci --ignore-scripts && node node_modules/esbuild/install.js && node node_modules/workerd/install.js && node node_modules/wrangler/bin/wrangler.js d1 migrations apply projects-git-search-test --local --config tests/runtime/wrangler.generated.json && node node_modules/wrangler/bin/wrangler.js dev --local --config tests/runtime/wrangler.generated.json --ip '+gateway+' --port '+port;
// Workerd must bind Docker's gateway for its container transport. The server
// itself remains loopback-only; publishing a bridge port breaks that transport.
execFileSync('docker',['run','-d','--name',name,'--label','projects-purpose=identity-local-qualification','--network','host','--mount',`type=bind,source=${source},target=/seed,readonly`,'--mount','type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock','-e','WRANGLER_SEND_METRICS=false','projects-worker-dev:qa','sh','-c',command],{encoding:'utf8',windowsHide:true});
// Docker Desktop does not forward host-network loopback to Windows. A small
// bridge proxy exposes only the requested Windows loopback port, preserving Host.
const proxy=name+'-loopback';
const proxyCode=`const http=require('http');http.createServer((req,res)=>{const target=http.request({hostname:${JSON.stringify(gateway)},port:${port},path:req.url,method:req.method,headers:req.headers},reply=>{res.writeHead(reply.statusCode,reply.headers);reply.pipe(res)});target.on('error',()=>{res.writeHead(503);res.end('Local runtime starting')});req.pipe(target)}).listen(${port},'0.0.0.0');`;
execFileSync('docker',['run','-d','--name',proxy,'--label','projects-purpose=identity-local-qualification','-p',`127.0.0.1:${port}:${port}`,'projects-worker-dev:qa','node','-e',proxyCode],{encoding:'utf8',windowsHide:true});
const receipt={format:'projects-git-local-runtime/v1',id,directory,source,container:name,proxy,origin:`http://127.0.0.1:${port}`,fixtureKey:fixture.path,image,startedAt:new Date().toISOString(),limitations:'Local workerd with SQLite and containers; scripted Access and Artifacts fixtures. No hosted evidence.'};
await writeFile(resolve(directory,'runtime.json'),JSON.stringify(receipt,null,2));
console.log(JSON.stringify(receipt,null,2));
