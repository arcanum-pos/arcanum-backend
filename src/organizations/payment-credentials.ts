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
import { errorJson } from '../errors';
import { checkBancontactKey } from '../payments/bancontact-account';
import { checkSumupAccount } from '../payments/sumup-cloud-api';

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

  // Never returns a key — which providers are configured, and for
  // Bancontact the account its key pays out to (null: saved before that was
  // checked).
  const out = [];
  for (const r of results || []) {
    const base = { provider: r.provider, configured: true, updatedAt: r.updated_at };
    if (r.provider !== 'bancontact') {
      out.push(base);
      continue;
    }
    const config = await getDecryptedPaymentCredential(env, orgId, 'bancontact');
    const account = typeof config?.merchantId === 'string' ? { merchantId: config.merchantId, name: (config.accountName as string) ?? null, iban: (config.accountIban as string) ?? null } : null;
    out.push({ ...base, environment: config?.environment ?? null, account });
  }
  // SumUp: the confirmed account (null: saved before that was checked).
  for (const item of out) {
    if (item.provider !== 'sumup') continue;
    const config = await getDecryptedPaymentCredential(env, orgId, 'sumup');
    Object.assign(item, { account: config?.confirmedAt ? { merchantId: String(config.merchantId), name: (config.accountName as string) ?? null, sandbox: typeof config.sandbox === 'boolean' ? config.sandbox : null } : null });
  }
  return json(out);
}

export async function setPaymentCredential(request: Request, env: Env, orgId: string, provider: string): Promise<Response> {
  if (!isValidProvider(provider)) return json({ error: "provider must be 'bancontact' or 'sumup'" }, 400);

  const caller = extractCaller(request);
  if (!caller) return json({ error: 'Unauthorized' }, 401);

  const membership = await requireOrgRole(env, orgId, caller, ['admin']);
  if (!membership) return json({ error: 'Forbidden' }, 403);

  let config = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!config || typeof config !== 'object') return json({ error: 'A config object is required' }, 400);

  // Bancontact: which account the key pays out to — shown to confirm first
  // (409 with the account), kept only once confirmed (bancontact-account.ts).
  if (provider === 'bancontact') {
    const apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : '';
    const environment = config.environment === 'preprod' ? 'preprod' : config.environment === 'prod' ? 'prod' : null;
    if (!apiKey || !environment) return json({ error: 'apiKey and environment (prod or preprod) are required' }, 400);
    const checked = await checkBancontactKey(env, apiKey, environment);
    if (!checked.ok) return errorJson(checked.code, 400, { detail: checked.detail });
    if (config.confirmMerchantId !== checked.account.merchantId) return errorJson('bancontact_confirm_account', 409, { account: checked.account });
    config = { apiKey, environment, merchantId: checked.account.merchantId, accountName: checked.account.name, accountIban: checked.account.iban, confirmedAt: new Date().toISOString() };
  }

  // SumUp: the key must work for the merchant code, and the account's name
  // is shown to confirm (409) before it's kept — like Bancontact's.
  if (provider === 'sumup') {
    const merchantId = typeof config.merchantId === 'string' ? config.merchantId.trim().toUpperCase() : '';
    const apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : '';
    if (!merchantId || !apiKey) return json({ error: 'merchantId and apiKey are required' }, 400);
    const checked = await checkSumupAccount(merchantId, apiKey);
    if (!checked.ok) return errorJson('sumup_key_refused', 400, { detail: checked.detail });
    if (config.confirmMerchantId !== merchantId) return errorJson('sumup_confirm_account', 409, { account: { merchantId, name: checked.account.name, sandbox: checked.account.sandbox } });
    config = { merchantId, apiKey, accountName: checked.account.name, sandbox: checked.account.sandbox, confirmedAt: new Date().toISOString() };
  }

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
