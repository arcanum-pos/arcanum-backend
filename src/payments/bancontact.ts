// Bancontact: a thin proxy to Bancontact's own v3 API. No local tracking —
// the webapp polls this directly and records its own transaction once it
// sees SUCCEEDED (see transactions.ts's createTransaction). Unlike SumUp/
// cash, this domain doesn't need a Durable Object: Bancontact's API is
// itself the source of truth, we're not coordinating between two callers.
import type { Env } from '../env';
import { json } from '../http';

export const BASE_URLS: Record<string, string> = {
  preprod: 'https://merchant.api.preprod.bancontact.net',
  prod: 'https://merchant.api.bancontact.net',
};

function bancontactHeaders(env: Env): Record<string, string> {
  const authValue = env.AUTH_SCHEME ? `${env.AUTH_SCHEME} ${env.API_KEY}` : env.API_KEY;
  return {
    'Content-Type': 'application/json',
    Authorization: authValue,
  };
}

export async function createPayment(request: Request, env: Env): Promise<Response> {
  const baseUrl = BASE_URLS[env.BANCONTACT_ENVIRONMENT];
  const body = (await request.json().catch(() => ({}))) as {
    amount?: number;
    description?: string;
    reference?: string;
  };
  const amountCents = Number(body.amount);

  if (!Number.isInteger(amountCents) || amountCents < 1) {
    return json({ error: 'amount (in cents, integer) is required' }, 400);
  }

  const payload: Record<string, unknown> = { amount: amountCents, currency: 'EUR' };
  if (body.description) payload.description = String(body.description).slice(0, 140);
  if (body.reference) payload.reference = String(body.reference).slice(0, 35);

  const response = await fetch(`${baseUrl}/v3/payments`, {
    method: 'POST',
    headers: bancontactHeaders(env),
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

export async function getPayment(paymentId: string, env: Env): Promise<Response> {
  const baseUrl = BASE_URLS[env.BANCONTACT_ENVIRONMENT];

  const response = await fetch(`${baseUrl}/v3/payments/${paymentId}`, {
    method: 'GET',
    headers: bancontactHeaders(env),
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
