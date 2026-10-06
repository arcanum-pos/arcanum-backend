// Thin client for SumUp's Cloud API (https://developer.sumup.com/api/readers),
// used to dispatch a payment request straight to a paired Solo reader and
// poll for its result — as opposed to a charge without a reader, which
// stays pending in sumup.ts until the cashier confirms it on the kassa.
// Pairing and unpairing readers (the console's Toestellen) too. Schema
// confirmed against sumup/sumup-openapi (2026-09).
const SUMUP_API_BASE = 'https://api.sumup.com';

export class SumupCloudApiError extends Error {
  code?: string;
  status: number;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function sumupFetch(path: string, apiKey: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(`${SUMUP_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    },
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      errors?: { detail?: string; type?: string }; // reader-checkout endpoints
      detail?: string; // RFC7807 Problem — everything else (e.g. List Readers)
      type?: string;
    };
    const detail = body.errors?.detail || body.detail;
    const code = body.errors?.type || body.type;
    throw new SumupCloudApiError(detail || `SumUp API error (${response.status})`, response.status, code);
  }

  return response;
}

export interface SumupReader {
  id: string;
  name: string;
  status: string; // unknown | processing | paired | expired
  model: string | null; // solo | virtual-solo
}

export async function listSumupReaders(merchantCode: string, apiKey: string): Promise<SumupReader[]> {
  const response = await sumupFetch(`/v0.1/merchants/${encodeURIComponent(merchantCode)}/readers`, apiKey);
  const data = (await response.json()) as { items: Array<{ id: string; name: string; status: string; device?: { model?: string } }> };

  return data.items.map((r) => ({ id: r.id, name: r.name, status: r.status, model: r.device?.model || null }));
}

// Pairs a reader with the merchant account: the 8–9 character code a Solo
// (or the Virtual Solo, virtual-solo.sumup.com) shows after "pair" is
// chosen on it. SumUp answers with the reader in 'processing' until the
// device confirms, then 'paired'.
export async function pairSumupReader(merchantCode: string, apiKey: string, pairingCode: string, name: string): Promise<SumupReader> {
  const response = await sumupFetch(`/v0.1/merchants/${encodeURIComponent(merchantCode)}/readers`, apiKey, {
    method: 'POST',
    body: JSON.stringify({ pairing_code: pairingCode, name }),
  });
  const r = (await response.json()) as { id: string; name: string; status: string; device?: { model?: string } };
  return { id: r.id, name: r.name, status: r.status, model: r.device?.model || null };
}

// Unpairs it: the reader leaves the merchant account (on the device itself
// it has to be paired again to be used).
export async function removeSumupReader(merchantCode: string, apiKey: string, readerId: string): Promise<void> {
  await sumupFetch(`/v0.1/merchants/${encodeURIComponent(merchantCode)}/readers/${encodeURIComponent(readerId)}`, apiKey, { method: 'DELETE' });
}

export interface SumupReaderCheckout {
  checkoutId: string;
  clientTransactionId: string;
}

export async function createSumupReaderCheckout(params: {
  merchantCode: string;
  apiKey: string;
  readerId: string;
  amountCents: number;
  currency: string;
  description: string;
  returnUrl: string;
}): Promise<SumupReaderCheckout> {
  const response = await sumupFetch(
    `/v0.1/merchants/${encodeURIComponent(params.merchantCode)}/readers/${encodeURIComponent(params.readerId)}/checkout`,
    params.apiKey,
    {
      method: 'POST',
      body: JSON.stringify({
        total_amount: { currency: params.currency, minor_unit: 2, value: params.amountCents },
        description: params.description || undefined,
        return_url: params.returnUrl,
      }),
    }
  );

  const data = (await response.json()) as { data: { checkout_id: string; client_transaction_id: string } };
  return { checkoutId: data.data.checkout_id, clientTransactionId: data.data.client_transaction_id };
}

export interface SumupReaderCheckoutStatus {
  status: 'pending' | 'successful' | 'failed' | 'cancelled';
  paymentFailureReason: string | null;
}

export async function getSumupReaderCheckoutStatus(params: {
  merchantCode: string;
  apiKey: string;
  readerId: string;
  checkoutId: string;
}): Promise<SumupReaderCheckoutStatus> {
  const response = await sumupFetch(
    `/v0.1/merchants/${encodeURIComponent(params.merchantCode)}/readers/${encodeURIComponent(params.readerId)}/checkout/${encodeURIComponent(params.checkoutId)}`,
    params.apiKey,
    { method: 'GET' }
  );

  const data = (await response.json()) as { data: { status: SumupReaderCheckoutStatus['status']; payment_failure_reason: string | null } };
  return { status: data.data.status, paymentFailureReason: data.data.payment_failure_reason || null };
}
