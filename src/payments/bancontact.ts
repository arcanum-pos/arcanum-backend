// Bancontact: a thin proxy to Bancontact's own v3 API. No local tracking —
// the webapp polls this directly and records its own transaction once it
// sees SUCCEEDED (see transactions.ts's createTransaction). Unlike SumUp/
// cash, this domain doesn't need a Durable Object: Bancontact's API is
// itself the source of truth, we're not coordinating between two callers.
//
// Credentials (API key + environment) are per-organization, configured in
// the admin portal and stored encrypted in payment_provider_credentials —
// not a worker-wide secret. There's no local record of which org created a
// given paymentId (stateless proxy, see above), so both createPayment and
// getPayment need orgId supplied on every call, not just at creation.
import type { Env } from '../env';
import { json } from '../http';
import { getDecryptedPaymentCredential } from '../organizations/payment-credentials';

export const BASE_URLS: Record<string, string> = {
  preprod: 'https://merchant.api.preprod.bancontact.net',
  prod: 'https://merchant.api.bancontact.net',
};

interface BancontactCredential {
  apiKey: string;
  environment: 'preprod' | 'prod';
}

async function resolveCredential(env: Env, orgId: string): Promise<BancontactCredential | null> {
  const credential = await getDecryptedPaymentCredential(env, orgId, 'bancontact');
  const apiKey = credential?.apiKey ? String(credential.apiKey) : '';
  const environment = credential?.environment === 'preprod' || credential?.environment === 'prod' ? credential.environment : null;
  if (!apiKey || !environment) return null;
  return { apiKey, environment };
}

function bancontactHeaders(env: Env, apiKey: string): Record<string, string> {
  const authValue = env.AUTH_SCHEME ? `${env.AUTH_SCHEME} ${apiKey}` : apiKey;
  return {
    'Content-Type': 'application/json',
    Authorization: authValue,
  };
}

export async function createPayment(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as {
    amount?: number;
    description?: string;
    reference?: string;
    orgId?: string;
  };
  const amountCents = Number(body.amount);

  if (!Number.isInteger(amountCents) || amountCents < 1) {
    return json({ error: 'amount (in cents, integer) is required' }, 400);
  }
  if (!body.orgId) {
    return json({ error: 'orgId is required' }, 400);
  }

  const credential = await resolveCredential(env, String(body.orgId));
  if (!credential) {
    return json({ error: 'Bancontact niet geconfigureerd voor deze organisatie' }, 400);
  }

  const baseUrl = BASE_URLS[credential.environment];
  const payload: Record<string, unknown> = { amount: amountCents, currency: 'EUR' };
  if (body.description) payload.description = String(body.description).slice(0, 140);
  if (body.reference) payload.reference = String(body.reference).slice(0, 35);

  const response = await fetch(`${baseUrl}/v3/payments`, {
    method: 'POST',
    headers: bancontactHeaders(env, credential.apiKey),
    body: JSON.stringify(payload),
  });

  const data = (await response.json().catch(() => ({}))) as Record<string, any>;

  if (!response.ok) {
    return json({ error: 'Bancontact API error', details: data }, response.status);
  }

  return json(
    {
      paymentId: data.paymentId,
      status: data.status,
      createdAt: data.createdAt,
      expiresAt: data.expiresAt,
      amount: data.amount,
      currency: data.currency,
      qrCodeUrl: data._links?.qrcode?.href,
      deeplinkUrl: data._links?.deeplink?.href,
      selfUrl: data._links?.self?.href,
    },
    201
  );
}

export async function getPayment(paymentId: string, orgId: string | null, env: Env): Promise<Response> {
  if (!orgId) {
    return json({ error: 'org_id is required' }, 400);
  }

  const credential = await resolveCredential(env, orgId);
  if (!credential) {
    return json({ error: 'Bancontact niet geconfigureerd voor deze organisatie' }, 400);
  }

  const baseUrl = BASE_URLS[credential.environment];

  const response = await fetch(`${baseUrl}/v3/payments/${paymentId}`, {
    method: 'GET',
    headers: bancontactHeaders(env, credential.apiKey),
  });

  const data = (await response.json().catch(() => ({}))) as Record<string, any>;

  if (!response.ok) {
    return json({ error: 'Bancontact API error', details: data }, response.status);
  }

  return json({
    paymentId: data.paymentId,
    status: data.status,
    succeededAt: data.succeededAt,
    expireAt: data.expireAt,
    amount: data.amount,
    currency: data.currency,
  });
}
