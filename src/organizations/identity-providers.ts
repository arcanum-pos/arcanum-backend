// The instance's login provider: ONE identity provider per installation —
// the `default` identity_providers row, seeded from DEFAULT_IDP_* — used by
// every org on it (HOSTING_PLAN.md §5). Per-org identity providers and
// per-org custom domains are gone (phase 6); the identity_providers table
// keeps its org_id key, but only the 'default' row is ever read.
//
// The one place the plaintext client secret ever leaves the DB is
// handleResolveIdentityProviderForAuth, for arcanum-bff to drive a login.
import type { Env } from '../env';
import { json } from '../http';
import { getOrgDataKey } from './organizations';
import { encryptWithKey, decryptWithKey } from './crypto';
import { resolveOidcDiscovery, ensureDefaultOrganizationRow, DEFAULT_ORG_ID, type OidcEndpoints } from './idp-resolution';
import type { IdentityProviderRow } from './types';

// Idempotent: creates the platform-default organization + its identity
// provider row, from DEFAULT_IDP_* secrets, the first time it's needed.
// A cheap existence check makes every call after the first a no-op.
export async function ensureDefaultOrganization(env: Env): Promise<void> {
  const alreadySeeded = await env.DB.prepare('SELECT org_id FROM identity_providers WHERE org_id = ?')
    .bind(DEFAULT_ORG_ID)
    .first();
  if (alreadySeeded) return;

  if (!env.DEFAULT_IDP_ISSUER_URL || !env.DEFAULT_IDP_CLIENT_ID || !env.DEFAULT_IDP_CLIENT_SECRET) {
    throw new Error('Default identity provider is not configured (DEFAULT_IDP_* secrets missing)');
  }

  const endpoints = await resolveOidcDiscovery(env.DEFAULT_IDP_ISSUER_URL);
  if (!endpoints) {
    throw new Error('DEFAULT_IDP_ISSUER_URL is unreachable, or missing device_authorization_endpoint');
  }

  await ensureDefaultOrganizationRow(env);
  const now = new Date().toISOString();

  // Re-read whichever DEK actually won the row-creation above — never
  // assume it was ours, so a concurrent first call can't encrypt the
  // secret below under a DEK that doesn't match the org row that ended up
  // persisted.
  const actualDek = await getOrgDataKey(env, DEFAULT_ORG_ID);
  if (!actualDek) throw new Error('Failed to seed default organization');

  const encryptedSecret = await encryptWithKey(env.DEFAULT_IDP_CLIENT_SECRET, actualDek);
  // Optional, for providers that need them (Google: no `offline_access`
  // scope, and a separate "Web application" client for browser login next
  // to the "TVs and Limited Input" client used for the kassa's device login).
  // The browser-login client only counts with its secret.
  const authCodeClientId = env.DEFAULT_IDP_AUTH_CODE_CLIENT_ID && env.DEFAULT_IDP_AUTH_CODE_CLIENT_SECRET ? env.DEFAULT_IDP_AUTH_CODE_CLIENT_ID : null;
  const authCodeSecret = authCodeClientId ? await encryptWithKey(env.DEFAULT_IDP_AUTH_CODE_CLIENT_SECRET!, actualDek) : null;

  await env.DB.prepare(
    `INSERT INTO identity_providers (
       org_id, connection_name, issuer_url, client_id, client_secret_ciphertext, client_secret_iv,
       authorization_endpoint, token_endpoint, userinfo_endpoint, device_authorization_endpoint, end_session_endpoint,
       scopes, auth_code_client_id, auth_code_client_secret_ciphertext, auth_code_client_secret_iv, updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(org_id) DO NOTHING`
  )
    .bind(
      DEFAULT_ORG_ID,
      env.DEFAULT_IDP_CONNECTION_NAME || null,
      env.DEFAULT_IDP_ISSUER_URL,
      env.DEFAULT_IDP_CLIENT_ID,
      encryptedSecret.ciphertext,
      encryptedSecret.iv,
      endpoints.authorization_endpoint,
      endpoints.token_endpoint,
      endpoints.userinfo_endpoint,
      endpoints.device_authorization_endpoint,
      endpoints.end_session_endpoint,
      env.DEFAULT_IDP_SCOPES?.trim() || null,
      authCodeClientId,
      authCodeSecret?.ciphertext ?? null,
      authCodeSecret?.iv ?? null,
      now
    )
    .run();
}

// What arcanum-bff needs to drive a login — the contract of
// GET /identity-provider/resolve?purpose=authcode|device. No org, no
// domain: the bff always redirects back to its own FRONTEND_URL.
export interface ResolvedIdpSettings {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  connectionName: string | null;
  scopes: string | null;
  endpoints: OidcEndpoints;
}

// A plain `row is IdentityProviderRow` predicate wouldn't narrow the
// individual nullable fields below to non-null — this explicit shape does.
type CompleteIdentityProviderRow = IdentityProviderRow & {
  issuer_url: string;
  client_id: string;
  client_secret_ciphertext: string;
  client_secret_iv: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  device_authorization_endpoint: string;
};

function isCompleteRow(row: IdentityProviderRow | null | undefined): row is CompleteIdentityProviderRow {
  return Boolean(
    row?.issuer_url &&
      row.client_id &&
      row.client_secret_ciphertext &&
      row.client_secret_iv &&
      row.authorization_endpoint &&
      row.token_endpoint &&
      row.userinfo_endpoint &&
      row.device_authorization_endpoint
  );
}

export type AuthPurpose = 'device' | 'authcode';

// The instance's identity provider, seeded on first use.
//
// `purpose` picks which client the authorization-code flow (browser /login)
// vs. the device grant (/device) uses: some providers (Google) require a
// distinct OAuth client per flow — a "TV and Limited Input" client can't do
// authorization-code, and a "Web application" client can't do the device
// grant — so auth_code_client_id/secret is an override used only when
// purpose is 'authcode'. Unset (the common case — Auth0, arcanum-auth), or
// purpose 'device': always the primary client_id/client_secret.
export async function resolveIdentityProviderForAuth(env: Env, purpose: AuthPurpose): Promise<ResolvedIdpSettings | null> {
  const load = () => env.DB.prepare('SELECT * FROM identity_providers WHERE org_id = ?').bind(DEFAULT_ORG_ID).first<IdentityProviderRow>();
  let row = await load();
  if (!isCompleteRow(row)) {
    await ensureDefaultOrganization(env);
    row = await load();
  }
  if (!isCompleteRow(row)) return null;

  const dek = await getOrgDataKey(env, DEFAULT_ORG_ID);
  if (!dek) return null;

  const useAuthCodeOverride =
    purpose === 'authcode' && row.auth_code_client_id && row.auth_code_client_secret_ciphertext && row.auth_code_client_secret_iv;

  const clientId = useAuthCodeOverride ? row.auth_code_client_id! : row.client_id;
  const clientSecret = useAuthCodeOverride
    ? await decryptWithKey({ ciphertext: row.auth_code_client_secret_ciphertext!, iv: row.auth_code_client_secret_iv! }, dek)
    : await decryptWithKey({ ciphertext: row.client_secret_ciphertext, iv: row.client_secret_iv }, dek);

  return {
    issuerUrl: row.issuer_url,
    clientId,
    clientSecret,
    connectionName: row.connection_name,
    scopes: row.scopes,
    endpoints: {
      authorization_endpoint: row.authorization_endpoint,
      token_endpoint: row.token_endpoint,
      userinfo_endpoint: row.userinfo_endpoint,
      device_authorization_endpoint: row.device_authorization_endpoint,
      end_session_endpoint: row.end_session_endpoint,
    },
  };
}

// Gated by BFF_INTERNAL_KEY (the same shared-secret pattern arcanum-devicehub
// uses for its own internal routes, just a separate, independently
// rotatable secret from INTERNAL_API_KEY), NOT by caller identity — there
// is deliberately no logged-in user yet at this point in the login flow.
// This is NOT optional: `worker` having no public ingress only blocks
// *direct* internet access — arcanum-bff's own generic `/api/organizations/*`
// proxy still reaches the legacy path below for any ordinary logged-in
// session, and this handler hands back a plaintext client secret. Only the
// BFF's own pre-auth login code (never the ordinary proxy path, which never
// sets this header) is meant to call it.
function hasValidInternalKey(request: Request, env: Env): boolean {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return Boolean(env.BFF_INTERNAL_KEY) && token === env.BFF_INTERNAL_KEY;
}

// GET /identity-provider/resolve?purpose=authcode|device → ResolvedIdpSettings.
//
// `legacy`: the pre-phase-6 path, /organizations/:orgIdOrHost/identity-
// provider/resolve, still answered (the org/host segment is ignored) so a
// bff deployed before this backend keeps logging people in during a
// rollout; it also gets the three fields that bff still reads, fixed to
// "the instance's IdP, no custom domain". Remove once every installation
// runs a bff that calls the new path.
export async function handleResolveIdentityProviderForAuth(request: Request, env: Env, legacy = false): Promise<Response> {
  if (!hasValidInternalKey(request, env)) return json({ error: 'Unauthorized' }, 401);

  const purposeParam = new URL(request.url).searchParams.get('purpose');
  if (purposeParam !== 'device' && purposeParam !== 'authcode') {
    return json({ error: "Missing or invalid 'purpose' query param (expected 'device' or 'authcode')" }, 400);
  }

  const resolved = await resolveIdentityProviderForAuth(env, purposeParam);
  if (!resolved) return json({ error: 'No identity provider configured' }, 404);
  return json(legacy ? { orgId: DEFAULT_ORG_ID, customDomain: null, isOwnIdp: false, ...resolved } : resolved);
}
