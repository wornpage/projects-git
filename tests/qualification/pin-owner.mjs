import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {decodeJwt} from 'jose';
import {AccessVerifier} from '../../src/cloudflare/access.ts';
import {readSetup} from './setup.mjs';

// Explicit operator setup using the already approved application and email.
// This is never an HTTP endpoint or first-caller owner enrollment.
const path=process.argv[2];if(!path)throw new Error('Supply the recorded Access application configuration.');
const setup=await readSetup(path);
assert.match(setup.hostname,/^[a-z0-9.-]+$/);assert.match(setup.audience,/^[a-f0-9]{64}$/);
const tokenPath=join(homedir(),'.cloudflared',setup.hostname+'-'+setup.audience+'-token');
const token=(await readFile(tokenPath,'utf8')).trim();
const candidate=decodeJwt(token).sub;
assert.ok(typeof candidate==='string'&&candidate.length>0,'Owner login must have a subject.');
const principal=await new AccessVerifier().authenticate(new Request('https://'+setup.hostname,{headers:{'Cf-Access-Jwt-Assertion':token}}),{
  issuer:setup.issuer,audience:setup.audience,ownerSubject:candidate,workspaceId:setup.workspace,agentClientIds:[],
});
assert.equal(principal.kind,'owner');assert.equal(principal.displayName,setup.ownerEmail);
assert.ok(!setup.ownerSubject||setup.ownerSubject===principal.id,'Previously pinned owner cannot change.');
setup.ownerSubject=principal.id;setup.ownerVerifiedAt=new Date().toISOString();
setup.ownerSession={issuedAt:principal.issuedAt,expiresAt:principal.expiresAt};
await writeFile(path,JSON.stringify(setup,null,2));
console.log(JSON.stringify({ownerSubject:setup.ownerSubject,ownerEmail:setup.ownerEmail,issuer:setup.issuer,audience:setup.audience,workspace:setup.workspace,ownerVerifiedAt:setup.ownerVerifiedAt,session:setup.ownerSession},null,2));
