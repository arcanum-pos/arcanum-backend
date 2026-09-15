// Dependency-light resolution helpers shared across org-scoped config types
// (identity providers, SMTP credentials) and invite reconciliation
// (invite-reconciliation.ts). Deliberately separate from
// identity-providers.ts / smtp-credentials.ts: those depend on
// organizations.ts (for DEK unwrapping), and organizations.ts depends on
// invite-reconciliation.ts — so that file must not depend on either of
// those, or the import graph cycles. (members.ts itself is fine to depend
// on organizations.ts/smtp-credentials.ts — it's invite-reconciliation.ts,
// split out specifically to avoid this, that can't.)
import type { Env } from '../env';
import type { IdentityProviderRow } from './types';
import { generateDataKey, wrapDataKey } from './crypto';

export const DEFAULT_ORG_ID = 'default';

// Idempotent: creates the platform-default organization row (with its own
// DEK) the first time anything needs it. Shared by identity-providers.ts
// and smtp-credentials.ts — both attach org-scoped, DEK-encrypted config
// to this same 'default' org, so both need the row to exist before they
// can seed their own config onto it. Safe under concurrent first-calls
// (ON CONFLICT DO NOTHING); callers that go on to encrypt something for
// this org should re-read whichever DEK actually won via getOrgDataKey
// rather than assuming it was the one generated here.
export async function ensureDefaultOrganizationRow(env: Env): Promise<void> {
  const existing = await env.DB.prepare('SELECT id FROM organizations WHERE id = ?').bind(DEFAULT_ORG_ID).first();
  if (existing) return;

  const now = new Date().toISOString();
  const dek = generateDataKey();
  const wrapped = await wrapDataKey(dek, env.ENCRYPTION_KEY);

  await env.DB.prepare(
    `INSERT INTO organizations (id, name, logo_url, theme, dek_ciphertext, dek_iv, created_at, created_by_sub)
     VALUES (?, ?, NULL, NULL, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`
  )
    .bind(DEFAULT_ORG_ID, 'Platform default', wrapped.ciphertext, wrapped.iv, now, 'system')
    .run();
}

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
