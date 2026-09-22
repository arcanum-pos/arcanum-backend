// Identity for the organizations/admin-portal API comes from the same
// BFF-forwarded headers the rest of the worker already trusts (see
// serviceProxy.ts's setIdentityHeaders) — (X-User-Issuer, X-User-Sub)
// together are the actual identity; email/name are for display and for
// reconciling pending invites.
//
// A bare sub is only unique within the issuer that minted it — once an org
// can bring its own identity provider, a malicious org admin fully controls
// what `sub` (or `email`) their own IdP asserts, and could mint one matching
// a real member of a *different* org. Since some lookups here span every
// org a sub belongs to (listMyOrganizations/listMyMemberships), matching on
// bare sub alone is a cross-tenant impersonation path. issuer+sub together
// closes it.
import type { Env } from '../env';
import type { CallerIdentity, MembershipRow, OrgRole } from './types';

// Transitional fallback only: a request with no X-User-Issuer header predates
// arcanum-bff sending one, which — since no other issuer existed before this
// support shipped — can only mean it was authenticated against the
// platform's one original shared Auth0 tenant. Must match the literal value
// the 0002 migration backfilled onto every pre-existing membership row.
// Becomes dead code once every active session has been re-established
// post-rollout.
const LEGACY_SHARED_TENANT_ISSUER = 'https://auth.esvvzw.be/';

export function extractCaller(request: Request): CallerIdentity | null {
  const sub = request.headers.get('X-User-Sub');
  if (!sub) return null;
  const issuer = request.headers.get('X-User-Issuer') || LEGACY_SHARED_TENANT_ISSUER;
  return {
    sub,
    issuer,
    email: request.headers.get('X-User-Email') || '',
    name: request.headers.get('X-User-Name') || '',
  };
}

// Returns the caller's active membership in this org if it has one of the
// allowed roles, otherwise null. Callers decide what to do with null (403).
export async function requireOrgRole(
  env: Env,
  orgId: string,
  caller: CallerIdentity,
  allowedRoles: OrgRole[]
): Promise<MembershipRow | null> {
  const row = await env.DB.prepare(
    "SELECT * FROM memberships WHERE org_id = ? AND issuer = ? AND user_sub = ? AND status = 'active'"
  )
    .bind(orgId, caller.issuer, caller.sub)
    .first<MembershipRow>();

  if (!row || !allowedRoles.includes(row.role)) return null;
  return row;
}
