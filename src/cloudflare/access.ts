import { createLocalJWKSet, jwtVerify } from 'jose';
import type { JSONWebKeySet } from 'jose';
import { ApiError } from './security.ts';

export interface AccessPolicy { issuer: string; audience: string; workspaceId: string; ownerSubject: string; agentClientIds: string[]; reviewerClientIds?: string[]; reviewerSubjects?: string[] }
export interface AccessPrincipal { provider: 'cloudflare-access'; kind: 'owner' | 'agent' | 'reviewer'; issuer: string; id: string; workspaceId: string; displayName: string; issuedAt: number; expiresAt: number }
export interface SystemPrincipal { provider: 'internal'; kind: 'system'; issuer: string; id: 'workspace-alarm'; workspaceId: string; displayName: 'Workspace alarm' }
export interface HostedAuthority { policy: AccessPolicy; principal: AccessPrincipal | SystemPrincipal; forbiddenSecrets?: string[] }
export interface AccessEnvironment { ACCESS_TEAM_DOMAIN?: string; ACCESS_AUD?: string; ACCESS_OWNER_SUB?: string; ACCESS_AGENT_CLIENT_IDS?: string; ACCESS_REVIEWER_CLIENT_IDS?: string; ACCESS_REVIEWER_SUBJECTS?: string; WORKSPACE_ID?: string }

export function accessPolicy(env: AccessEnvironment): AccessPolicy {
  const issuer = env.ACCESS_TEAM_DOMAIN ?? '', audience = env.ACCESS_AUD ?? '', ownerSubject = env.ACCESS_OWNER_SUB ?? '', workspaceId = env.WORKSPACE_ID ?? '';
  if (!/^https:\/\/[a-z0-9][a-z0-9-]*\.cloudflareaccess\.com$/.test(issuer) || !/^[a-f0-9]{64}$/.test(audience)
    || !/^[A-Za-z0-9_.:@-]{1,200}$/.test(ownerSubject) || !/^[A-Za-z0-9_.-]{1,100}$/.test(workspaceId)) {
    throw new ApiError(503, 'AUTH_NOT_CONFIGURED', 'Configure the Access team, application audience, verified owner subject and workspace.');
  }
  let ids: unknown;
  try { ids = JSON.parse(env.ACCESS_AGENT_CLIENT_IDS ?? '[]'); } catch { throw new ApiError(503, 'AUTH_NOT_CONFIGURED', 'Agent client IDs must be a JSON array.'); }
  if (!Array.isArray(ids) || ids.length > 100 || ids.some(id => typeof id !== 'string' || !/^[a-f0-9]{32}\.access$/.test(id)) || new Set(ids).size !== ids.length) {
    throw new ApiError(503, 'AUTH_NOT_CONFIGURED', 'Configure distinct Access service client IDs.');
  }
  let reviewers: unknown;
  try { reviewers = JSON.parse(env.ACCESS_REVIEWER_CLIENT_IDS ?? '[]'); } catch { throw new ApiError(503, 'AUTH_NOT_CONFIGURED', 'Reviewer client IDs must be a JSON array.'); }
  if (!Array.isArray(reviewers) || reviewers.length > 100 || reviewers.some(id => typeof id !== 'string' || !/^[a-f0-9]{32}\.access$/.test(id) || ids.includes(id)) || new Set(reviewers).size !== reviewers.length) {
    throw new ApiError(503, 'AUTH_NOT_CONFIGURED', 'Reviewers must use distinct service identities that are not builder identities.');
  }
  let reviewerSubjects: unknown;
  try { reviewerSubjects = JSON.parse(env.ACCESS_REVIEWER_SUBJECTS ?? '[]'); } catch { throw new ApiError(503, 'AUTH_NOT_CONFIGURED', 'Human reviewer subjects must be a JSON array.'); }
  if (!Array.isArray(reviewerSubjects) || reviewerSubjects.length > 100 || reviewerSubjects.some(id =>
    typeof id !== 'string' || !/^[A-Za-z0-9_.:@-]{1,200}$/.test(id) || id === ownerSubject || ids.includes(id) || reviewers.includes(id))
    || new Set(reviewerSubjects).size !== reviewerSubjects.length) {
    throw new ApiError(503, 'AUTH_NOT_CONFIGURED', 'Configure distinct human reviewer subjects outside owner, builder, and service reviewer identities.');
  }
  return { issuer, audience, ownerSubject, workspaceId, agentClientIds: ids, reviewerClientIds: reviewers, reviewerSubjects };
}

// Cache only public signing material; no request, token or identity is cached.
export class AccessVerifier {
  private caches = new Map<string, { keys: ReturnType<typeof createLocalJWKSet>; expires: number; fetched: number }>();
  private fetchKeys: typeof fetch;
  private now: () => number;
  constructor(fetchKeys: typeof fetch = (input, init) => fetch(input, init), now: () => number = Date.now) { this.fetchKeys = fetchKeys; this.now = now; }

  private async keys(issuer: string, refresh = false): Promise<ReturnType<typeof createLocalJWKSet>> {
    const existing = this.caches.get(issuer), now = this.now();
    if (existing && existing.expires > now && (!refresh || now - existing.fetched < 30_000)) return existing.keys;
    const request = (async () => {
      // Workers supports manual redirects, not redirect:error. Reject every
      // non-2xx response below so keys never come from a redirected issuer.
      const response = await this.fetchKeys(issuer + '/cdn-cgi/access/certs', { redirect: 'manual', signal: AbortSignal.timeout(5000) });
      if (!response.ok || !response.body) throw new Error('Signing keys unavailable');
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      try { while (true) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength; if (size > 128 * 1024) { await reader.cancel(); throw new Error('Signing key response too large'); } chunks.push(item.value); } }
      finally { reader.releaseLock(); }
      const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const jwks = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)) as JSONWebKeySet;
      if (!Array.isArray(jwks.keys) || !jwks.keys.length || jwks.keys.length > 20) throw new Error('Invalid signing keys');
      const keys = createLocalJWKSet(jwks);
      if (this.caches.size >= 8 && !this.caches.has(issuer)) this.caches.delete(this.caches.keys().next().value!);
      this.caches.set(issuer, { keys, fetched: this.now(), expires: this.now() + 300_000 }); return keys;
    })();
    return request;
  }

  async authenticate(request: Request, policy: AccessPolicy): Promise<AccessPrincipal> {
    const token = request.headers.get('Cf-Access-Jwt-Assertion');
    if (!token || token.length > 16_384) throw new ApiError(401, 'UNAUTHORIZED', 'A valid Access application session is required.');
    try {
      const options = { issuer: policy.issuer, audience: policy.audience, algorithms: ['RS256'], requiredClaims: ['iss', 'aud', 'exp', 'iat', 'sub'], currentDate: new Date(this.now()), clockTolerance: 0 };
      let result;
      try { result = await jwtVerify(token, await this.keys(policy.issuer), options); }
      catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ERR_JWKS_NO_MATCHING_KEY')) throw error;
        result = await jwtVerify(token, await this.keys(policy.issuer, true), options);
      }
      const claims = result.payload;
      if (claims.type !== 'app' || !Number.isFinite(claims.iat) || Number(claims.iat) > Math.floor(this.now() / 1000)) throw new Error('Invalid application claims');
      if (claims.sub === policy.ownerSubject && typeof claims.email === 'string' && claims.email.length > 0 && claims.email.length <= 320 && !claims.common_name) {
        return { provider: 'cloudflare-access', kind: 'owner', issuer: policy.issuer, id: claims.sub, workspaceId: policy.workspaceId, displayName: claims.email, issuedAt: claims.iat!, expiresAt: claims.exp! };
      }
      if (typeof claims.sub === 'string' && policy.reviewerSubjects?.includes(claims.sub)
        && typeof claims.email === 'string' && claims.email.length > 0 && claims.email.length <= 320 && !claims.common_name) {
        return { provider: 'cloudflare-access', kind: 'reviewer', issuer: policy.issuer, id: claims.sub, workspaceId: policy.workspaceId, displayName: claims.email, issuedAt: claims.iat!, expiresAt: claims.exp! };
      }
      if (claims.sub === '' && typeof claims.common_name === 'string' && claims.email === undefined) {
        const builder = policy.agentClientIds.includes(claims.common_name), reviewer = policy.reviewerClientIds?.includes(claims.common_name) ?? false;
        if (builder && reviewer) throw new ApiError(503, 'AUTH_NOT_CONFIGURED', 'Builder and reviewer identities must be disjoint.');
        if (builder || reviewer) return { provider: 'cloudflare-access', kind: reviewer ? 'reviewer' : 'agent', issuer: policy.issuer, id: claims.common_name, workspaceId: policy.workspaceId, displayName: claims.common_name, issuedAt: claims.iat!, expiresAt: claims.exp! };
      }
      throw new ApiError(403, 'FORBIDDEN', 'This identity is not authorized for this workspace.');
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(401, 'UNAUTHORIZED', 'Access session validation failed.');
    }
  }
}

export function assertAuthority(authority: HostedAuthority, workspaceId: string): void {
  const { principal, policy } = authority ?? {};
  if (!principal || !policy || principal.workspaceId !== workspaceId || policy.workspaceId !== workspaceId || principal.issuer !== policy.issuer) {
    throw new ApiError(403, 'WORKSPACE_FORBIDDEN', 'The authenticated identity does not belong to this workspace.');
  }
  const valid = principal.kind === 'system' ? principal.provider === 'internal' && principal.id === 'workspace-alarm'
    : principal.provider === 'cloudflare-access' && (principal.kind === 'owner' ? principal.id === policy.ownerSubject
      : principal.kind === 'agent' ? policy.agentClientIds.includes(principal.id) && !policy.reviewerClientIds?.includes(principal.id)
      : principal.kind === 'reviewer' && (Boolean(policy.reviewerClientIds?.includes(principal.id)) || Boolean(policy.reviewerSubjects?.includes(principal.id)))
        && !policy.agentClientIds.includes(principal.id));
  if (!valid) throw new ApiError(403, 'FORBIDDEN', 'The authenticated identity is not authorized.');
}

export function ownerBinding(policy: AccessPolicy) { return { provider: 'cloudflare-access' as const, issuer: policy.issuer, audience: policy.audience, subject: policy.ownerSubject, workspaceId: policy.workspaceId }; }
// Recheck against durable state after awaits, not just at the HTTP boundary.
// Signing-key validation alone cannot observe an Access session revocation.
export function assertSession(principal: AccessPrincipal | SystemPrincipal, validAfter = 0, now = Date.now()): void {
  if (!Number.isSafeInteger(validAfter) || validAfter < 0) throw new ApiError(503, 'INVALID_SESSION_POLICY', 'The retained workspace session policy needs operator repair.');
  if (principal.kind === 'system') return;
  const seconds = Math.floor(now / 1000);
  if (!Number.isSafeInteger(principal.issuedAt) || !Number.isSafeInteger(principal.expiresAt)
    || principal.issuedAt > seconds || principal.expiresAt <= seconds || principal.expiresAt <= principal.issuedAt) {
    throw new ApiError(401, 'SESSION_EXPIRED', 'A current Access application session is required.');
  }
  if (principal.issuedAt <= validAfter) throw new ApiError(401, 'SESSION_REVOKED', 'This workspace session was revoked. Sign in again through Access.');
}
export function systemAuthority(policy: AccessPolicy): HostedAuthority {
  return { policy, principal: { provider: 'internal', kind: 'system', issuer: policy.issuer, id: 'workspace-alarm', workspaceId: policy.workspaceId, displayName: 'Workspace alarm' } };
}

export function authorizeRoute(principal: AccessPrincipal, method: string, path: string): void {
  if (principal.kind === 'owner') return;
  if (principal.kind === 'reviewer') {
    if (method === 'GET' && (path === '/api/review-inbox' || /^\/api\/runs\/[a-f0-9-]{36}\/review-context$/.test(path))
      || method === 'POST' && /^\/api\/runs\/[a-f0-9-]{36}\/(code-review|review-inference)$/.test(path)) return;
    throw new ApiError(403, 'REVIEWER_READ_ONLY', 'Reviewers may only read candidate review context and record their own assessment.');
  }
  if (method === 'GET' && (path === '/api/workspace' || /^\/api\/projects\/[a-f0-9-]{36}\/(search|search-index)$/.test(path) || /^\/api\/tasks\/[a-f0-9-]{36}\/handoff$/.test(path))) return;
  if (method === 'POST' && (/^\/api\/projects\/[a-f0-9-]{36}\/claim$/.test(path) || /^\/api\/runs\/[a-f0-9-]{36}\/(start|submit|fail)$/.test(path))) return;
  throw new ApiError(403, 'OWNER_REQUIRED', 'Only the authenticated owner can perform this operation.');
}
