import {generateKeyPair,exportJWK,importJWK,SignJWT} from 'jose';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

export async function loadAccessFixture() {
  const path=process.env.PROJECTS_ACCESS_FIXTURE_KEY;
  if(!path)throw new Error('Set PROJECTS_ACCESS_FIXTURE_KEY to the locally generated fixture key file.');
  const fixture=JSON.parse(await readFile(path,'utf8'));
  if(fixture.format!=='projects-git-test-access/v1'||fixture.issuer!=='https://fixture.cloudflareaccess.com')throw new Error('Not a local Access fixture.');
  return fixture;
}

export async function fixtureToken(clientId,changes={}) {
  const f=await loadAccessFixture(),key=await importJWK(f.privateJwk,'RS256'),now=Math.floor(Date.now()/1000);
  return new SignJWT({type:'app',iss:f.issuer,aud:[f.audience],sub:clientId?'':f.ownerSubject,
    ...(clientId?{common_name:clientId}:{email:'owner@example.test'}),iat:now,exp:now+3600,...changes})
    .setProtectedHeader({alg:'RS256',kid:f.publicJwks.keys[0].kid}).sign(key);
}

export async function prepareAccessFixture(output) {
  const path=resolve(output),pair=await generateKeyPair('RS256',{extractable:true});
  const fixture={format:'projects-git-test-access/v1',issuer:'https://fixture.cloudflareaccess.com',audience:'a'.repeat(64),ownerSubject:'fixture-owner',workspaceId:'runtime-test',
    agentClientIds:Array.from({length:8},(_,index)=>(index+1).toString(16).repeat(32)+'.access'),
    reviewerClientIds:['9'.repeat(32)+'.access','a'.repeat(32)+'.access'],
    reviewerSubjects:['human-reviewer'],
    publicJwks:{keys:[{...await exportJWK(pair.publicKey),kid:crypto.randomUUID(),alg:'RS256',use:'sig'}]},privateJwk:await exportJWK(pair.privateKey)};
  await mkdir(dirname(path),{recursive:true});await writeFile(path,JSON.stringify(fixture),{encoding:'utf8',flag:'wx',mode:0o600});
  return {path,vars:{WORKSPACE_ID:fixture.workspaceId,ACCESS_TEAM_DOMAIN:fixture.issuer,ACCESS_AUD:fixture.audience,ACCESS_OWNER_SUB:fixture.ownerSubject,ACCESS_AGENT_CLIENT_IDS:JSON.stringify(fixture.agentClientIds),ACCESS_REVIEWER_CLIENT_IDS:JSON.stringify(fixture.reviewerClientIds),ACCESS_REVIEWER_SUBJECTS:JSON.stringify(fixture.reviewerSubjects),ACCESS_TEST_JWKS:JSON.stringify(fixture.publicJwks)}};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(process.argv[2]!=='--prepare'||!process.argv[3])throw new Error('Usage: node tests/runtime/access-fixture.mjs --prepare <ignored-fixture-key.json>');
  console.log(JSON.stringify(await prepareAccessFixture(process.argv[3]),null,2));
}
