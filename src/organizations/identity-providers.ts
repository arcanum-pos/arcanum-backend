// Lets an organization use its own OIDC identity provider instead of the
// platform default. Two code paths:
//  - admin CRUD (getIdentityProvider/setIdentityProvider): what an org's
//    admin sees/edits over the API. Never returns the decrypted secret.
//  - auth resolution (resolveIdentityProviderForAuth, ensureDefaultOrganization):
//    what arcanum-bff calls, pre-authentication, to actually drive a login.
//    This is the one place the plaintext client secret ever leaves the DB.
//    No caller-identity check — safe by construction, since `worker` has no
//    public HTTP ingress (workers_dev: false); the only path here is the
//    BFF's service binding.
import type { Env } from '../env';
import { json } from '../http';
import { extractCaller, requireOrgRole } from './auth';
import { getOrgDataKey, resolveOrgId } from './organizations';
import { encryptWithKey, decryptWithKey } from './crypto';
import { resolveOidcDiscovery, ensureDefaultOrganizationRow, DEFAULT_ORG_ID, type OidcEndpoints } from './idp-resolution';
import type { IdentityProviderRow } from './types';

// Never returns a decrypted client secret — only whether one is set.
function rowToPublicIdp(row: IdentityProviderRow | null) {
  if (!row) {
    return {
      connectionName: null,
      issuerUrl: null,
      clientId: null,
      hasClientSecret: false,
      scopes: null,
      authCodeClientId: null,
      hasAuthCodeClientSecret: false,
      updatedAt: null,
    };
  }
  return {
    connectionName: row.connection_name,
    issuerUrl: row.issuer_url,
    clientId: row.client_id,
    hasClientSecret: Boolean(row.client_secret_ciphertext),
    scopes: row.scopes,
    authCodeClientId: row.auth_code_client_id,
    hasAuthCodeClientSecret: Boolean(row.auth_code_client_secret_ciphertext),
    updatedAt: row.updated_at,
  };
}

export async function getIdentityProvider(request: Request, env: Env, orgId: string): Promise<Response> {
  const caller = extractCaller(request);
  if (!caller) return json({ error: 'Unauthorized' }, 401);

  const membership = await requireOrgRole(env, orgId, caller, ['admin']);
  if (!membership) return json({ error: 'Forbidden' }, 403);

  const row = await env.DB.prepare('SELECT * FROM identity_providers WHERE org_id = ?').bind(orgId).first<IdentityProviderRow>();
  return json(rowToPublicIdp(row));
}

export async function setIdentityProvider(request: Request, env: Env, orgId: string): Promise<Response> {
  const caller = extractCaller(request);
  if (!caller) return json({ error: 'Unauthorized' }, 401);

  const membership = await requireOrgRole(env, orgId, caller, ['admin']);
  if (!membership) return json({ error: 'Forbidden' }, 403);

  const body = (await request.json().catch(() => ({}))) as {
    connectionName?: string;
    issuerUrl?: string;
    clientId?: string;
    clientSecret?: string;
    scopes?: string;
    authCodeClientId?: string;
    authCodeClientSecret?: string;
  };

  const dek = await getOrgDataKey(env, orgId);
  if (!dek) return json({ error: 'Unknown organization' }, 404);

  const existing = await env.DB.prepare('SELECT * FROM identity_providers WHERE org_id = ?').bind(orgId).first<IdentityProviderRow>();

  // Feasibility gate: only re-run discovery when the issuer is actually
  // being set/changed — fail here, at admin-save time, not at a cashier's
  // first login.
  let endpoints: OidcEndpoints | null = null;
  if (body.issuerUrl) {
    endpoints = await resolveOidcDiscovery(body.issuerUrl);
    if (!endpoints) {
      return json(
        {
          error:
            'Kon de issuer-URL niet bereiken, of deze ondersteunt geen apparaatcode-aanmelding (vereist voor de kassa-toestellen).',
        },
        400
      );
    }
  }

  let secretCiphertext: string | null = null;
  let secretIv: string | null = null;
  // Only re-encrypt the secret if a new one was actually sent — an admin
  // updating just the connection name shouldn't have to resupply the secret.
  if (body.clientSecret) {
    const encrypted = await encryptWithKey(body.clientSecret, dek);
    secretCiphertext = encrypted.ciphertext;
    secretIv = encrypted.iv;
  }

  let authCodeSecretCiphertext: string | null = null;
  let authCodeSecretIv: string | null = null;
  if (body.authCodeClientSecret) {
    const encrypted = await encryptWithKey(body.authCodeClientSecret, dek);
    authCodeSecretCiphertext = encrypted.ciphertext;
    authCodeSecretIv = encrypted.iv;
  }

  const now = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO identity_providers (
       org_id, connection_name, issuer_url, client_id, client_secret_ciphertext, client_secret_iv,
       authorization_endpoint, token_endpoint, userinfo_endpoint, device_authorization_endpoint, end_session_endpoint,
       scopes, auth_code_client_id, auth_code_client_secret_ciphertext, auth_code_client_secret_iv, updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(org_id) DO UPDATE SET
       connection_name = excluded.connection_name,
       issuer_url = excluded.issuer_url,
       client_id = excluded.client_id,
       client_secret_ciphertext = COALESCE(excluded.client_secret_ciphertext, identity_providers.client_secret_ciphertext),
       client_secret_iv = COALESCE(excluded.client_secret_iv, identity_providers.client_secret_iv),
       authorization_endpoint = excluded.authorization_endpoint,
       token_endpoint = excluded.token_endpoint,
       userinfo_endpoint = excluded.userinfo_endpoint,
       device_authorization_endpoint = excluded.device_authorization_endpoint,
       end_session_endpoint = excluded.end_session_endpoint,
       scopes = excluded.scopes,
       auth_code_client_id = excluded.auth_code_client_id,
       auth_code_client_secret_ciphertext = COALESCE(excluded.auth_code_client_secret_ciphertext, identity_providers.auth_code_client_secret_ciphertext),
       auth_code_client_secret_iv = COALESCE(excluded.auth_code_client_secret_iv, identity_providers.auth_code_client_secret_iv),
       updated_at = excluded.updated_at`
  )
    .bind(
      orgId,
      body.connectionName ?? existing?.connection_name ?? null,
      body.issuerUrl ?? existing?.issuer_url ?? null,
      body.clientId ?? existing?.client_id ?? null,
      secretCiphertext,
      secretIv,
      endpoints?.authorization_endpoint ?? existing?.authorization_endpoint ?? null,
      endpoints?.token_endpoint ?? existing?.token_endpoint ?? null,
      endpoints?.userinfo_endpoint ?? existing?.userinfo_endpoint ?? null,
      endpoints?.device_authorization_endpoint ?? existing?.device_authorization_endpoint ?? null,
      endpoints?.end_session_endpoint ?? existing?.end_session_endpoint ?? null,
      body.scopes ?? existing?.scopes ?? null,
      body.authCodeClientId ?? existing?.auth_code_client_id ?? null,
      authCodeSecretCiphertext,
      authCodeSecretIv,
      now
    )
    .run();

  const row = await env.DB.prepare('SELECT * FROM identity_providers WHERE org_id = ?').bind(orgId).first<IdentityProviderRow>();
  return json(rowToPublicIdp(row));
}

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
      null,
      null,
      null,
      null,
      now
    )
    .run();
}

export interface ResolvedIdpSettings {
  // The real id of the org actually being logged into — never a custom
  // domain (that's resolved to this before arcanum-bff ever sees it), so
  // arcanum-bff can store an actual id in session data instead of whatever
  // string the URL/Host happened to carry.
  orgId: string;
  // This org's own custom domain, if it has one — regardless of whether its
  // credentials below came from its own config or the platform-default
  // fallback. Lets arcanum-bff decide where to redirect back to.
  customDomain: string | null;
  // True when the credentials below are this org's OWN (not the
  // platform-default fallback) — only then is it safe/correct to use a
  // dynamic, this-org's-own-domain redirect_uri (see authroutes.ts): the
  // shared default IdP has exactly one registered callback and can't vary
  // per org.
  isOwnIdp: boolean;
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  connectionName: string | null;
  scopes: string | null;
  endpoints: OidcEndpoints;
}

// A plain `row is IdentityProviderRow` predicate wouldn't narrow the
// individual nullable fields below to non-null — this explicit shape does,
// so the rest of resolveIdentityProviderForAuth can use them without `!`.
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

// Used by custom-domain.ts to enforce the custom-domain/own-identity-provider
// pairing: an org may only set a custom domain once it has a complete IdP
// row of its own — see that file's header comment for why this pairing is
// mandatory now that login links carry no org identifier at all.
export async function hasCompleteIdentityProvider(env: Env, orgId: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT * FROM identity_providers WHERE org_id = ?').bind(orgId).first<IdentityProviderRow>();
  return isCompleteRow(row);
}

export type AuthPurpose = 'device' | 'authcode';

// Resolves the settings arcanum-bff needs to actually drive a login for
// orgId — that org's own configured IdP if it has one, otherwise the
// platform default's. The one place the plaintext client secret leaves
// the DB.
//
// Checks this org's own config *before* touching the default at all — an
// org with a fully configured IdP of its own must never fail just because
// the platform-wide default hasn't been seeded yet (or is misconfigured).
// ensureDefaultOrganization is only called, and only allowed to throw, on
// the fallback path (mirrors the same fix in smtp-credentials.ts's
// resolveSmtpCredentialsForSend — found as a real bug there first).
//
// `purpose` picks which client the authorization-code flow (browser /login,
// /:orgId/console) vs. the device grant (/:orgId/device) actually uses: some
// providers (Google) require a distinct OAuth client per flow — a device
// grant "TV and Limited Input" client can't do authorization-code, and a
// "Web application" client can't do the device grant — so an org can
// register auth_code_client_id/secret as an override, used only when
// purpose is 'authcode'. Unset (the common case — e.g. Auth0, where one
// Application does both), or purpose is 'device': always the primary
// client_id/client_secret.
export async function resolveIdentityProviderForAuth(
  env: Env,
  orgId: string,
  purpose: AuthPurpose
): Promise<ResolvedIdpSettings | null> {
  // Captured before any fallback substitution below — this org's own
  // custom_domain, regardless of whose credentials end up being used.
  const orgRow = await env.DB.prepare('SELECT custom_domain FROM organizations WHERE id = ?')
    .bind(orgId)
    .first<{ custom_domain: string | null }>();
  const customDomain = orgRow?.custom_domain ?? null;

  let row = await env.DB.prepare('SELECT * FROM identity_providers WHERE org_id = ?').bind(orgId).first<IdentityProviderRow>();
  let effectiveOrgId = orgId;

  if (!isCompleteRow(row)) {
    await ensureDefaultOrganization(env);
    row = await env.DB.prepare('SELECT * FROM identity_providers WHERE org_id = ?').bind(DEFAULT_ORG_ID).first<IdentityProviderRow>();
    effectiveOrgId = DEFAULT_ORG_ID;
  }

  if (!isCompleteRow(row)) return null;

  const dek = await getOrgDataKey(env, effectiveOrgId);
  if (!dek) return null;

  const useAuthCodeOverride =
    purpose === 'authcode' && row.auth_code_client_id && row.auth_code_client_secret_ciphertext && row.auth_code_client_secret_iv;

  const clientId = useAuthCodeOverride ? row.auth_code_client_id! : row.client_id;
  const clientSecret = useAuthCodeOverride
    ? await decryptWithKey({ ciphertext: row.auth_code_client_secret_ciphertext!, iv: row.auth_code_client_secret_iv! }, dek)
    : await decryptWithKey({ ciphertext: row.client_secret_ciphertext, iv: row.client_secret_iv }, dek);

  return {
    orgId,
    customDomain,
    isOwnIdp: effectiveOrgId === orgId,
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
// proxy still reaches this exact route for any ordinary logged-in session
// (it only checks *a* session exists, not that its owner administers this
// specific org), and this handler hands back a plaintext client secret. Only
// the BFF's own pre-auth device/login code (never the ordinary proxy path,
// which never sets this header) is meant to call it.
function hasValidInternalKey(request: Request, env: Env): boolean {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return Boolean(env.BFF_INTERNAL_KEY) && token === env.BFF_INTERNAL_KEY;
}

// HTTP wrapper for resolveIdentityProviderForAuth — see router.ts for the
// route wiring. `orgIdOrHost` is exactly that: the path segment arcanum-bff
// forwards from a /login or /device URL — either a real org id, or, for an
// unprefixed /login or /device/start, the request's own Host header
// (arcanum-bff's last resort before literal 'default'), letting a custom
// domain resolve to its org with no org identifier in the URL at all.
// resolveOrgId tries both; falls through to the raw value if neither match
// (e.g. 'default', or a stale/unknown id), leaving
// resolveIdentityProviderForAuth's own fallback-to-default and not-found
// handling unchanged.
export async function handleResolveIdentityProviderForAuth(request: Request, env: Env, orgIdOrHost: string): Promise<Response> {
  if (!hasValidInternalKey(request, env)) return json({ error: 'Unauthorized' }, 401);

  const purposeParam = new URL(request.url).searchParams.get('purpose');
  if (purposeParam !== 'device' && purposeParam !== 'authcode') {
    return json({ error: "Missing or invalid 'purpose' query param (expected 'device' or 'authcode')" }, 400);
  }

  const orgId = (await resolveOrgId(env, orgIdOrHost)) ?? orgIdOrHost;
  const resolved = await resolveIdentityProviderForAuth(env, orgId, purposeParam);
  if (!resolved) return json({ error: 'No identity provider configured' }, 404);
  return json(resolved);
}
