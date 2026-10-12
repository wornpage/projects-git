import {accessPolicy} from './access.ts';
import type {AccessPolicy} from './access.ts';
import {ApiError} from './security.ts';

export interface PolicySource {
  readPolicy(workspaceId: string, nonce: string): Promise<{nonce: string; policy: AccessPolicy}>;
}

// Always make a new private RPC. Never retain a policy or fall back to DO.env.
export async function currentPolicy(source: PolicySource | undefined, workspaceId: string): Promise<AccessPolicy> {
  if (!source) throw new ApiError(503, 'CURRENT_POLICY_UNAVAILABLE', 'Bind the private current-policy entrypoint before automatic integration.');
  const nonce = crypto.randomUUID();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reply = await Promise.race([
      source.readPolicy(workspaceId, nonce),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Policy deadline exceeded')), 5000); }),
    ]);
    if (!reply || reply.nonce !== nonce || reply.policy?.workspaceId !== workspaceId) throw new Error('Policy response does not match this request');
    const value = reply.policy;
    return accessPolicy({WORKSPACE_ID:value.workspaceId,ACCESS_TEAM_DOMAIN:value.issuer,ACCESS_AUD:value.audience,
      ACCESS_OWNER_SUB:value.ownerSubject,ACCESS_AGENT_CLIENT_IDS:JSON.stringify(value.agentClientIds),
      ACCESS_REVIEWER_CLIENT_IDS:JSON.stringify(value.reviewerClientIds),ACCESS_REVIEWER_SUBJECTS:JSON.stringify(value.reviewerSubjects)});
  } catch {
    throw new ApiError(503, 'CURRENT_POLICY_UNAVAILABLE', 'Current workspace authority could not be established. Automatic integration is stopped.');
  } finally { clearTimeout(timer); }
}
