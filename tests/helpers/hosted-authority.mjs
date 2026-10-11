export const AGENT_CLIENT = '1'.repeat(32) + '.access';
export const REVIEWER_CLIENT = '9'.repeat(32) + '.access';
const issuedAt = Math.floor(Date.now()/1000), expiresAt = issuedAt + 3600;
export function testAuthority(workspaceId = 'mock-workspace', clientId) {
  const policy = {issuer:'https://fixture.cloudflareaccess.com',audience:'a'.repeat(64),ownerSubject:'fixture-owner',workspaceId,
    agentClientIds:Array.from({length:8},(_,index)=>(index+1).toString(16).repeat(32)+'.access'),reviewerClientIds:[REVIEWER_CLIENT],reviewerSubjects:[]};
  return {policy,principal:{provider:'cloudflare-access',kind:clientId?'agent':'owner',issuer:policy.issuer,id:clientId??policy.ownerSubject,workspaceId,displayName:clientId??'owner@example.test',issuedAt,expiresAt},forbiddenSecrets:['test-control-token-'+'x'.repeat(40)]};
}
export function testReviewerAuthority(workspaceId='mock-workspace') {
  const authority=testAuthority(workspaceId);authority.principal={...authority.principal,kind:'reviewer',id:REVIEWER_CLIENT,displayName:REVIEWER_CLIENT};return authority;
}
