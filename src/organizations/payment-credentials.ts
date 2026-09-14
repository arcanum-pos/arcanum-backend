// Payment provider credentials (Bancontact API key, SumUp merchant/affiliate
// id + key, etc.) per organization. The whole provider-specific config is
// encrypted as one JSON blob rather than one column per field — adding a
// field for an existing provider, or a new provider entirely, doesn't need a
// schema migration, just a different JSON shape.
import type { Env } from '../env';
import { json } from '../http';
import { extractCaller, requireOrgRole } from './auth';
import { getOrgDataKey } from './organizations';
import { encryptWithKey, decryptWithKey } from './crypto';
import type { PaymentProvider, PaymentProviderCredentialRow } from './types';

const VALID_PROVIDERS = new Set<PaymentProvider>(['bancontact', 'sumup']);

function isValidProvider(value: string): value is PaymentProvider {
  return VALID_PROVIDERS.has(value as PaymentProvider);
}

export async function listPaymentCredentials(request: Request, env: Env, orgId: string): Promise<Response> {
  const caller = extractCaller(request);
  if (!caller) return json({ error: 'Unauthorized' }, 401);

  const membership = await requireOrgRole(env, orgId, caller, ['admin']);
  if (!membership) return json({ error: 'Forbidden' }, 403);

  const { results } = await env.DB.prepare('SELECT provider, updated_at FROM payment_provider_credentials WHERE org_id = ?')
    .bind(orgId)
    .all<{ provider: PaymentProvider; updated_at: string }>();

  // Never returns the decrypted config — just which providers are configured.
  return json((results || []).map((r) => ({ provider: r.provider, configured: true, updatedAt: r.updated_at })));
}

export async function setPaymentCredential(request: Request, env: Env, orgId: string, provider: string): Promise<Response> {
  if (!isValidProvider(provider)) return json({ error: "provider must be 'bancontact' or 'sumup'" }, 400);

  const caller = extractCaller(request);
  if (!caller) return json({ error: 'Unauthorized' }, 401);

  const membership = await requireOrgRole(env, orgId, caller, ['admin']);
  if (!membership) return json({ error: 'Forbidden' }, 403);

  const config = await request.json().catch(() => null);
  if (!config || typeof config !== 'object') return json({ error: 'A config object is required' }, 400);

  const dek = await getOrgDataKey(env, orgId);
  if (!dek) return json({ error: 'Unknown organization' }, 404);

  const encrypted = await encryptWithKey(JSON.stringify(config), dek);
  const now = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO payment_provider_credentials (org_id, provider, config_ciphertext, config_iv, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(org_id, provider) DO UPDATE SET
       config_ciphertext = excluded.config_ciphertext,
       config_iv = excluded.config_iv,
       updated_at = excluded.updated_at`
  )
    .bind(orgId, provider, encrypted.ciphertext, encrypted.iv, now)
    .run();

  return json({ provider, configured: true, updatedAt: now });
}

// Internal use only (e.g. by payment processing when it needs the actual
// credentials to call out to a provider on this org's behalf) — never
// exposed directly over the API.
export async function getDecryptedPaymentCredential(
  env: Env,
  orgId: string,
  provider: PaymentProvider
): Promise<Record<string, unknown> | null> {
  const row = await env.DB.prepare('SELECT * FROM payment_provider_credentials WHERE org_id = ? AND provider = ?')
    .bind(orgId, provider)
    .first<PaymentProviderCredentialRow>();
  if (!row) return null;

  const dek = await getOrgDataKey(env, orgId);
  if (!dek) return null;

  const configJson = await decryptWithKey({ ciphertext: row.config_ciphertext, iv: row.config_iv }, dek);
  return JSON.parse(configJson);
}
