// Dependency-light identity-provider resolution helpers, shared by the admin
// CRUD (identity-providers.ts) and invite reconciliation (members.ts).
// Deliberately separate from identity-providers.ts: that file depends on
// organizations.ts (for DEK unwrapping), and organizations.ts depends on
// members.ts (for reconcilePendingInvites) — so members.ts must not depend
// on identity-providers.ts, or the import graph cycles.
import type { Env } from '../env';
import type { IdentityProviderRow } from './types';

export const DEFAULT_ORG_ID = 'default';

export interface OidcEndpoints {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  device_authorization_endpoint: string;
  end_session_endpoint: string | null;
}

// Fetches and validates an issuer's discovery document. Returns null if
// unreachable, malformed, or missing device_authorization_endpoint — the
// feasibility gate, since an IdP without device-grant support can't drive
// the kiosk (POS/CFD) login flow at all. Called once, at admin-save time
// (or default-org seed time) — never on the login hot path.
export async function resolveOidcDiscovery(issuerUrl: string): Promise<OidcEndpoints | null> {
  const base = issuerUrl.replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/.well-known/openid-configuration`);
    if (!res.ok) return null;

    const doc = (await res.json()) as Record<string, unknown>;
    const { authorization_endpoint, token_endpoint, userinfo_endpoint, device_authorization_endpoint, end_session_endpoint } = doc;

    if (
      typeof authorization_endpoint !== 'string' ||
      typeof token_endpoint !== 'string' ||
      typeof userinfo_endpoint !== 'string' ||
      typeof device_authorization_endpoint !== 'string'
    ) {
      return null;
    }

    return {
      authorization_endpoint,
      token_endpoint,
      userinfo_endpoint,
      device_authorization_endpoint,
      end_session_endpoint: typeof end_session_endpoint === 'string' ? end_session_endpoint : null,
    };
  } catch {
    return null;
  }
}

// The issuer an org's members are expected to authenticate against: that
// org's own configured issuer if it has one, otherwise the platform
// default's. Never decrypts anything — issuer_url isn't secret. Used by
// members.ts to decide whether to trust an authenticated email claim when
// reconciling a pending invite (an org-controlled IdP asserting an email
// that matches a DIFFERENT org's pending invite must not be trusted).
export async function resolveConfiguredIssuerUrl(env: Env, orgId: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT issuer_url FROM identity_providers WHERE org_id = ?')
    .bind(orgId)
    .first<Pick<IdentityProviderRow, 'issuer_url'>>();
  if (row?.issuer_url) return row.issuer_url;
  if (orgId === DEFAULT_ORG_ID) return null;

  const defaultRow = await env.DB.prepare('SELECT issuer_url FROM identity_providers WHERE org_id = ?')
    .bind(DEFAULT_ORG_ID)
    .first<Pick<IdentityProviderRow, 'issuer_url'>>();
  return defaultRow?.issuer_url ?? null;
}
