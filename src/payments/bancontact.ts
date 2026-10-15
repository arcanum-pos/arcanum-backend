// Bancontact: creates a payment via Bancontact's v3 API and tracks it in
// the shared `charges` table (see charges.ts) — same mechanism SumUp uses.
// Resolution is callback-driven (postBancontactCallback below); the
// ChargePoller DO (payments/poller.ts) is only a fallback for a missed
// callback, not the primary path. Previously this was a stateless proxy —
// the browser polled Bancontact's API directly every 2s; that's gone, the
// backend now owns tracking and pushes payment_updated the same way SumUp
// already does.
//
// Credentials (API key + environment) are per-organization, configured in
// the admin portal and stored encrypted in payment_provider_credentials.
import { shiftForSale } from '../shifts';
import { staffForSale } from '../staff';
import { refuseUnlessOrgMember } from '../organizations/auth';
import type { Env } from '../env';
import { json } from '../http';
import { errorJson } from '../errors';
import { broadcastPaymentEvent, notifyTabChanged } from '../devicehub-client';
import { getDecryptedPaymentCredential } from '../organizations/payment-credentials';
import { verifyBancontactCallback } from './bancontact-jws';
import { createCharge, getCharge, parseTipCents, resolveCharge, updateChargeProviderStatus } from './charges';
import { isPendingTabChargeConflict, prepareTabCharge } from '../tabs';
import { ensureChargePolling } from './charge-poller-client';
import { accountOf, cancelBancontactPayment } from './bancontact-account';

export const BASE_URLS: Record<string, string> = {
  preprod: 'https://merchant.api.preprod.bancontact.net',
  prod: 'https://merchant.api.bancontact.net',
};

// Bancontact's own terminal statuses (see webapp/src/lib/paymentLabels.ts's
// TERMINAL_BANCONTACT_STATUSES — kept in sync manually, small enough not to
// warrant sharing a single source of truth across the worker/webapp split).
const TERMINAL_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'AUTHORIZATION_FAILED', 'CANCELLED', 'EXPIRED', 'VOIDED']);

interface BancontactCredential {
  apiKey: string;
  environment: 'preprod' | 'prod';
  // The merchant the admin confirmed when saving the key (bancontact-account.ts) — null for a key saved before that check.
  merchantId: string | null;
}

async function resolveCredential(env: Env, orgId: string): Promise<BancontactCredential | null> {
  const credential = await getDecryptedPaymentCredential(env, orgId, 'bancontact');
  const apiKey = credential?.apiKey ? String(credential.apiKey) : '';
  const environment = credential?.environment === 'preprod' || credential?.environment === 'prod' ? credential.environment : null;
  if (!apiKey || !environment) return null;
  return { apiKey, environment, merchantId: typeof credential?.merchantId === 'string' ? credential.merchantId : null };
}

export function bancontactHeaders(env: Env, apiKey: string): Record<string, string> {
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
    orgId?: string;
    posTerminalId?: string;
    items?: Record<string, unknown>;
    slotId?: string;
    deviceId?: string;
    deviceName?: string;
    tabId?: string;
    tipCents?: number;
    splitPart?: boolean;
    partial?: boolean;
    lines?: unknown;
    registerId?: unknown;
  };
  const amountCents = Number(body.amount);

  if (!Number.isInteger(amountCents) || amountCents < 1) {
    return json({ error: 'amount (in cents, integer) is required' }, 400);
  }
  if (!body.orgId) {
    return json({ error: 'orgId is required' }, 400);
  }
  const orgId = String(body.orgId);
  const refused = await refuseUnlessOrgMember(request, env, orgId);
  if (refused) return refused;
  // The person handling it on a shared kassa (staff.ts).
  const staff = await staffForSale(request, env, orgId);
  if (staff instanceof Response) return staff;
  // On a register: its open shift (none open: refused).
  const shiftId = await shiftForSale(env, orgId, body.registerId);
  if (shiftId instanceof Response) return shiftId;

  // Checked before calling Bancontact, so a refused tab payment never leaves
  // a provider-side payment behind (see tabs.ts's prepareTabCharge).
  const tipCents = parseTipCents(body.tipCents);
  if (tipCents === null || tipCents > amountCents) return json({ error: 'tipCents must be an integer between 0 and 100000, and not more than the amount' }, 400);
  const tabId = body.tabId ? String(body.tabId) : null;
  let items = body.items || {};
  let description = body.description ? String(body.description).slice(0, 140) : '';
  let splitPart = 0;
  let lines: { lineId: string; quantity: number }[] = [];
  if (tabId) {
    const prepared = await prepareTabCharge(request, env, orgId, tabId, amountCents, tipCents, { splitPart: body.splitPart === true, partial: body.partial === true, lines: body.lines });
    if (!prepared.ok) return prepared.response;
    items = prepared.context.items;
    description = description || prepared.context.description;
    splitPart = prepared.context.splitPart;
    lines = prepared.context.lines;
  }

  return startBancontactPayment(env, {
    orgId,
    amountCents,
    tipCents,
    description,
    items,
    tabId,
    splitPart: body.splitPart === true ? splitPart : 0,
    lines,
    posTerminalId: body.posTerminalId ? String(body.posTerminalId) : null,
    slotId: body.slotId ? String(body.slotId) : null,
    deviceId: body.deviceId ? String(body.deviceId) : null,
    deviceName: body.deviceName ? String(body.deviceName) : null,
    userName: request.headers.get('X-User-Name') || null,
    userEmail: request.headers.get('X-User-Email') || null,
    staffId: staff?.id ?? null,
    staffName: staff?.name ?? null,
    shiftId,
    returnUrl: null,
  });
}

// A Bancontact payment, once the caller has checked who may make it — a
// kassa (createPayment above) or a guest paying their own self-order
// (self-order.ts). `returnUrl`: where the Bancontact app sends a phone back
// after paying (the guest's "follow your order" page); none for a kassa.
export async function startBancontactPayment(
  env: Env,
  p: {
    orgId: string;
    amountCents: number;
    tipCents: number;
    description: string;
    items: Record<string, unknown>;
    tabId: string | null;
    splitPart: number;
    lines: { lineId: string; quantity: number }[];
    posTerminalId: string | null;
    slotId: string | null;
    deviceId: string | null;
    deviceName: string | null;
    userName: string | null;
    userEmail: string | null;
    staffId?: string | null;
    staffName?: string | null;
    shiftId?: string | null;
    returnUrl: string | null;
  }
): Promise<Response> {
  const { orgId, amountCents, tipCents, description, items, tabId, splitPart, lines, posTerminalId } = p;
  const credential = await resolveCredential(env, orgId);
  if (!credential) {
    return errorJson('bancontact_not_configured', 400);
  }

  // Generated up front — Bancontact needs it as `reference` in the create
  // call itself (their callback echoes it back unchanged, which is how we
  // correlate an incoming callback to this charge with no lookup needed).
  // Hyphens stripped: Bancontact's `reference` field has a hard 35-char
  // limit, one short of a canonical UUID's 36.
  const chargeId = crypto.randomUUID().replace(/-/g, '');

  const baseUrl = BASE_URLS[credential.environment];
  const payload = {
    amount: amountCents,
    currency: 'EUR',
    description: description || undefined,
    reference: chargeId,
    callbackUrl: `${env.PUBLIC_BASE_URL}/api/callback/bancontact`,
    ...(p.returnUrl ? { returnUrl: p.returnUrl } : {}),
  };

  const response = await fetch(`${baseUrl}/v3/payments`, {
    method: 'POST',
    headers: bancontactHeaders(env, credential.apiKey),
    body: JSON.stringify(payload),
  });

  const data = (await response.json().catch(() => ({}))) as Record<string, any>;

  if (!response.ok) {
    return json({ error: 'Bancontact API error', details: data }, response.status);
  }

  // The account it pays out to must be the one confirmed when the key was
  // saved — else it's cancelled and refused (a key of another merchant).
  const creditor = accountOf(data.creditor);
  if (credential.merchantId && creditor && creditor.merchantId !== credential.merchantId) {
    if (typeof data.paymentId === 'string') await cancelBancontactPayment(env, credential.environment, credential.apiKey, data.paymentId);
    console.error(`Bancontact: payment for merchant ${creditor.merchantId}, the key was confirmed for ${credential.merchantId} (org ${orgId})`);
    return errorJson('bancontact_wrong_account', 409);
  }

  let charge;
  try {
    charge = await createCharge(env, {
      id: chargeId,
      orgId,
      method: 'bancontact',
      amountCents,
      description,
      posTerminalId,
      items,
      slotId: p.slotId,
      deviceId: p.deviceId,
      deviceName: p.deviceName,
      userName: p.userName,
      userEmail: p.userEmail,
      staffId: p.staffId ?? null,
      staffName: p.staffName ?? null,
      shiftId: p.shiftId ?? null,
      tabId,
      tipCents,
      splitPart,
      lines,
      providerRef: data.paymentId || null,
      // Stored so a linked CFD — same-device or a genuinely separate one —
      // can render the actual QR code from the payment_updated push, not
      // just the plain "please pay" text cash/sumup get. See getSumupStatus.
      providerData: { qrCodeUrl: data._links?.qrcode?.href || null, deeplinkUrl: data._links?.deeplink?.href || null, checkoutUrl: data._links?.checkout?.href || null },
      expiresAt: data.expiresAt || null,
    });
  } catch (err) {
    // Lost the race against another kassa paying the same tab — the
    // Bancontact payment just created is never shown and simply expires.
    if (isPendingTabChargeConflict(err)) return errorJson('tab_payment_already_pending', 409);
    throw err;
  }

  await ensureChargePolling(env); // fallback sweep in case the callback above never arrives

  if (posTerminalId) {
    await broadcastPaymentEvent(env, posTerminalId, 'payment_updated', { payment_id: charge.id, method: 'bancontact' });
  }
  // Every kassa of the org: this tab now has a payment pending.
  if (tabId) notifyTabChanged(env, orgId, tabId);

  return json(
    {
      chargeId: charge.id,
      status: data.status,
      createdAt: data.createdAt,
      expiresAt: data.expiresAt,
      amount: data.amount,
      currency: data.currency,
      qrCodeUrl: data._links?.qrcode?.href,
      deeplinkUrl: data._links?.deeplink?.href,
      checkoutUrl: data._links?.checkout?.href,
    },
    201
  );
}

// Called by Bancontact itself. No session — authorized by the JWS signature
// in the `Signature` header (see bancontact-jws.ts), verified against the
// org's own environment (preprod/prod) once the charge (and so the org)
// it's about is known.
export async function postBancontactCallback(request: Request, env: Env): Promise<Response> {
  const signature = request.headers.get('Signature');
  const rawBody = await request.text();
  if (!signature) return json({ error: 'Missing signature' }, 401);

  let payload: {
    reference?: string;
    status?: string;
    failureReason?: string;
  };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json({ error: 'Invalid payload' }, 400);
  }

  const chargeId = payload.reference;
  if (!chargeId) return json({ error: 'Missing reference' }, 400);

  const charge = await getCharge(env, chargeId);
  if (!charge || charge.method !== 'bancontact') return json({ error: 'Unknown charge' }, 404);

  const credential = await resolveCredential(env, charge.orgId);
  if (!credential) return json({ error: 'Bancontact niet geconfigureerd' }, 400);

  const verified = await verifyBancontactCallback(signature, rawBody, credential.environment);
  if (!verified) return json({ error: 'Invalid signature' }, 401);

  const status = payload.status || '';
  if (!TERMINAL_STATUSES.has(status)) {
    // Intermediate state (IDENTIFIED/AUTHORIZED/PENDING_MERCHANT_ACKNOWLEDGEMENT/...)
    // — reflect it for the UI (same rich labels the old direct-polling flow
    // showed) without resolving the charge yet.
    await updateChargeProviderStatus(env, chargeId, status);
    return json({});
  }

  await resolveCharge(env, chargeId, {
    success: status === 'SUCCEEDED',
    providerStatus: status,
  });

  return json({});
}

export interface BancontactStatus {
  status: string;
  failureReason?: string | null;
}

// Used only by ChargePoller's fallback sweep — the primary resolution path
// is postBancontactCallback above.
export async function getBancontactPaymentStatus(env: Env, orgId: string, paymentId: string): Promise<BancontactStatus | null> {
  const credential = await resolveCredential(env, orgId);
  if (!credential) return null;

  const baseUrl = BASE_URLS[credential.environment];
  const response = await fetch(`${baseUrl}/v3/payments/${paymentId}`, {
    method: 'GET',
    headers: bancontactHeaders(env, credential.apiKey),
  });
  if (!response.ok) return null;

  const data = (await response.json().catch(() => ({}))) as { status?: string };
  return data.status ? { status: data.status } : null;
}

export { TERMINAL_STATUSES as BANCONTACT_TERMINAL_STATUSES };
