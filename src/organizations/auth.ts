// Identity for the organizations/admin-portal API comes from the same
// BFF-forwarded headers the rest of the worker already trusts (see
// serviceProxy.ts's setIdentityHeaders) — X-User-Sub is the actual identity;
// email/name are for display and for reconciling pending invites.
import type { Env } from '../env';
import type { CallerIdentity, MembershipRow, OrgRole } from './types';

export function extractCaller(request: Request): CallerIdentity | null {
  const sub = request.headers.get('X-User-Sub');
  if (!sub) return null;
  return {
    sub,
    email: request.headers.get('X-User-Email') || '',
    name: request.headers.get('X-User-Name') || '',
  };
}

// Returns the caller's active membership in this org if it has one of the
// allowed roles, otherwise null. Callers decide what to do with null (403).
export async function requireOrgRole(
  env: Env,
  orgId: string,
  userSub: string,
  allowedRoles: OrgRole[]
): Promise<MembershipRow | null> {
  const row = await env.DB.prepare(
    "SELECT * FROM memberships WHERE org_id = ? AND user_sub = ? AND status = 'active'"
  )
    .bind(orgId, userSub)
    .first<MembershipRow>();

  if (!row || !allowedRoles.includes(row.role)) return null;
  return row;
}
