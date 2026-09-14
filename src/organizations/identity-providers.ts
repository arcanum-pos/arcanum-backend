// Lets an organization use its own Auth0 connection (or, for a fuller
// external OIDC setup, its own issuer/client) instead of the platform
// default. This models the data an org can register; actually wiring a new
// Auth0 connection at login time (via Auth0's Management API) is separate,
// larger follow-up work, not part of this data layer.
import type { Env } from '../env';
import { json } from '../http';
import { extractCaller, requireOrgRole } from './auth';
import { getOrgDataKey } from './organizations';
import { encryptWithKey } from './crypto';
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

  const membership = await requireOrgRole(env, orgId, caller.sub, ['admin']);
  if (!membership) return json({ error: 'Forbidden' }, 403);

  const row = await env.DB.prepare('SELECT * FROM identity_providers WHERE org_id = ?').bind(orgId).first<IdentityProviderRow>();
  return json(rowToPublicIdp(row));
}

export async function setIdentityProvider(request: Request, env: Env, orgId: string): Promise<Response> {
  const caller = extractCaller(request);
  if (!caller) return json({ error: 'Unauthorized' }, 401);

  const membership = await requireOrgRole(env, orgId, caller.sub, ['admin']);
  if (!membership) return json({ error: 'Forbidden' }, 403);

  const body = (await request.json().catch(() => ({}))) as {
    connectionName?: string;
    issuerUrl?: string;
    clientId?: string;
    clientSecret?: string;
  };

  const dek = await getOrgDataKey(env, orgId);
  if (!dek) return json({ error: 'Unknown organization' }, 404);

  let secretCiphertext: string | null = null;
  let secretIv: string | null = null;
  // Only re-encrypt the secret if a new one was actually sent — an admin
  // updating just the connection name shouldn't have to resupply the secret.
  if (body.clientSecret) {
    const encrypted = await encryptWithKey(body.clientSecret, dek);
    secretCiphertext = encrypted.ciphertext;
    secretIv = encrypted.iv;
  }

  const existing = await env.DB.prepare('SELECT * FROM identity_providers WHERE org_id = ?').bind(orgId).first<IdentityProviderRow>();
  const now = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO identity_providers (org_id, connection_name, issuer_url, client_id, client_secret_ciphertext, client_secret_iv, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(org_id) DO UPDATE SET
       connection_name = excluded.connection_name,
       issuer_url = excluded.issuer_url,
       client_id = excluded.client_id,
       client_secret_ciphertext = COALESCE(excluded.client_secret_ciphertext, identity_providers.client_secret_ciphertext),
       client_secret_iv = COALESCE(excluded.client_secret_iv, identity_providers.client_secret_iv),
       updated_at = excluded.updated_at`
  )
    .bind(
      orgId,
      body.connectionName ?? existing?.connection_name ?? null,
      body.issuerUrl ?? existing?.issuer_url ?? null,
      body.clientId ?? existing?.client_id ?? null,
      secretCiphertext,
      secretIv,
      now
    )
    .run();

  const row = await env.DB.prepare('SELECT * FROM identity_providers WHERE org_id = ?').bind(orgId).first<IdentityProviderRow>();
  return json(rowToPublicIdp(row));
}
