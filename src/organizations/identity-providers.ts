// Lets an organization use its own OIDC identity provider instead of the
// platform default. Two code paths:
//  - admin CRUD (getIdentityProvider/setIdentityProvider): what an org's
//    admin sees/edits over the API. Never returns the decrypted secret.
//  - auth resolution (resolveIdentityProviderForAuth, ensureDefaultOrganization):
//    what questo-bff calls, pre-authentication, to actually drive a login.
//    This is the one place the plaintext client secret ever leaves the DB.
//    No caller-identity check — safe by construction, since `worker` has no
//    public HTTP ingress (workers_dev: false); the only path here is the
//    BFF's service binding.
import type { Env } from '../env';
import { json } from '../http';
import { extractCaller, requireOrgRole } from './auth';
import { getOrgDataKey } from './organizations';
import { encryptWithKey, decryptWithKey } from './crypto';
import { resolveOidcDiscovery, ensureDefaultOrganizationRow, DEFAULT_ORG_ID, type OidcEndpoints } from './idp-resolution';
import type { IdentityProviderRow } from './types';

// Never returns the decrypted client secret — only whether one is set.
function rowToPublicIdp(row: IdentityProviderRow | null) {
  if (!row) {
    return { connectionName: null, issuerUrl: null, clientId: null, hasClientSecret: false, updatedAt: null };
  }
  return {
    connectionName: row.connection_name,
    issuerUrl: row.issuer_url,
    clientId: row.client_id,
    hasClientSecret: Boolean(row.client_secret_ciphertext),
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

  const now = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO identity_providers (
       org_id, connection_name, issuer_url, client_id, client_secret_ciphertext, client_secret_iv,
       authorization_endpoint, token_endpoint, userinfo_endpoint, device_authorization_endpoint, end_session_endpoint,
       updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
       updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      now
    )
    .run();
}

export interface ResolvedIdpSettings {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  connectionName: string | null;
  endpoints: OidcEndpoints;
}

// Resolves the settings questo-bff needs to actually drive a login for
// orgId — that org's own configured IdP if it has one, otherwise the
// platform default's. The one place the plaintext client secret leaves
// the DB.
export async function resolveIdentityProviderForAuth(env: Env, orgId: string): Promise<ResolvedIdpSettings | null> {
  await ensureDefaultOrganization(env);

  let row = await env.DB.prepare('SELECT * FROM identity_providers WHERE org_id = ?').bind(orgId).first<IdentityProviderRow>();
  let effectiveOrgId = orgId;
  if (!row?.issuer_url) {
    row = await env.DB.prepare('SELECT * FROM identity_providers WHERE org_id = ?').bind(DEFAULT_ORG_ID).first<IdentityProviderRow>();
    effectiveOrgId = DEFAULT_ORG_ID;
  }

  if (!row || !row.issuer_url || !row.client_id || !row.client_secret_ciphertext || !row.client_secret_iv) return null;
  if (!row.authorization_endpoint || !row.token_endpoint || !row.userinfo_endpoint || !row.device_authorization_endpoint) return null;

  const dek = await getOrgDataKey(env, effectiveOrgId);
  if (!dek) return null;

  const clientSecret = await decryptWithKey({ ciphertext: row.client_secret_ciphertext, iv: row.client_secret_iv }, dek);

  return {
    issuerUrl: row.issuer_url,
    clientId: row.client_id,
    clientSecret,
    connectionName: row.connection_name,
    endpoints: {
      authorization_endpoint: row.authorization_endpoint,
      token_endpoint: row.token_endpoint,
      userinfo_endpoint: row.userinfo_endpoint,
      device_authorization_endpoint: row.device_authorization_endpoint,
      end_session_endpoint: row.end_session_endpoint,
    },
  };
}

// Gated by BFF_INTERNAL_KEY (the same shared-secret pattern questo-devicehub
// uses for its own internal routes, just a separate, independently
// rotatable secret from INTERNAL_API_KEY), NOT by caller identity — there
// is deliberately no logged-in user yet at this point in the login flow.
// This is NOT optional: `worker` having no public ingress only blocks
// *direct* internet access — questo-bff's own generic `/api/organizations/*`
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
// route wiring.
export async function handleResolveIdentityProviderForAuth(request: Request, env: Env, orgId: string): Promise<Response> {
  if (!hasValidInternalKey(request, env)) return json({ error: 'Unauthorized' }, 401);

  const resolved = await resolveIdentityProviderForAuth(env, orgId);
  if (!resolved) return json({ error: 'No identity provider configured' }, 404);
  return json(resolved);
}
