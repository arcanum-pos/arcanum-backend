// Which Bancontact account a key pays out to. Bancontact's merchant API
// authenticates with an API key alone — no OAuth — so a key handed out for
// the wrong merchant (it happened to another organisation: a key of someone
// else's account, noticed only after many payments) would go unnoticed.
// Every payment Bancontact creates names its `creditor` (merchant id, the
// name customers see, the IBAN the money goes to), so:
//
//   - saving a key (payment-credentials.ts) makes a test payment of €0.01,
//     cancels it at once, and shows the admin that account to confirm —
//     the key is only kept once they did;
//   - every payment afterwards is checked against the confirmed merchant
//     (bancontact.ts): another one, and the payment is cancelled and refused;
//   - the console shows the account under Betalingen.
import type { Env } from '../env';
import { BASE_URLS, bancontactHeaders } from './bancontact';

export interface BancontactAccount {
  merchantId: string;
  name: string | null;
  // The IBAN with all but its country and last four digits hidden.
  iban: string | null;
}

export const maskIban = (iban: unknown): string | null => {
  if (typeof iban !== 'string' || iban.length < 8) return null;
  const clean = iban.replace(/\s+/g, '').toUpperCase();
  return `${clean.slice(0, 2)}•• •••• •••• ${clean.slice(-4)}`;
};

export function accountOf(creditor: unknown): BancontactAccount | null {
  const c = (creditor && typeof creditor === 'object' ? creditor : {}) as { merchantId?: unknown; name?: unknown; iban?: unknown };
  if (typeof c.merchantId !== 'string' || !c.merchantId) return null;
  return { merchantId: c.merchantId, name: typeof c.name === 'string' ? c.name : null, iban: maskIban(c.iban) };
}

// Cancels a payment that was never meant to be paid (best effort: an
// uncancelled one expires by itself).
export async function cancelBancontactPayment(env: Env, environment: 'preprod' | 'prod', apiKey: string, paymentId: string): Promise<void> {
  await fetch(`${BASE_URLS[environment]}/v3/payments/${encodeURIComponent(paymentId)}`, { method: 'DELETE', headers: bancontactHeaders(env, apiKey) }).catch(() => null);
}

// The account behind a key: a test payment of €0.01, read and cancelled.
export async function checkBancontactKey(
  env: Env,
  apiKey: string,
  environment: 'preprod' | 'prod'
): Promise<{ ok: true; account: BancontactAccount } | { ok: false; code: 'bancontact_key_refused' | 'bancontact_no_account'; detail: string }> {
  const reference = `check${crypto.randomUUID().replace(/-/g, '').slice(0, 26)}`;
  const res = await fetch(`${BASE_URLS[environment]}/v3/payments`, {
    method: 'POST',
    headers: bancontactHeaders(env, apiKey),
    body: JSON.stringify({ amount: 1, currency: 'EUR', description: 'Arcanum: controle van de sleutel', reference }),
  }).catch((err) => err as Error);
  if (res instanceof Error) return { ok: false, code: 'bancontact_key_refused', detail: res.message };
  const data = (await res.json().catch(() => ({}))) as { paymentId?: string; creditor?: unknown; message?: string; code?: string };
  if (!res.ok) return { ok: false, code: 'bancontact_key_refused', detail: `${res.status}${data.code ? ` ${data.code}` : ''}${data.message ? `: ${data.message}` : ''}` };
  if (data.paymentId) await cancelBancontactPayment(env, environment, apiKey, data.paymentId);
  const account = accountOf(data.creditor);
  return account ? { ok: true, account } : { ok: false, code: 'bancontact_no_account', detail: 'no creditor in the answer' };
}
