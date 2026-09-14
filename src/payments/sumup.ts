// SumUp: dispatches a charge to a specific Solo reader via the Cloud API
// (see sumup-cloud-api.ts) and tracks it in the shared `charges` table (see
// charges.ts) — same tracking mechanism Bancontact uses. Resolution is
// callback-driven (postSumupCallback below); the ChargePoller DO
// (payments/poller.ts) is only a fallback for a missed callback, not the
// primary path.
//
// /sumup/charge, /sumup/status/:id and /sumup/confirm are called by the
// webapp via the BFF (session-checked, same trust model as /payments).
// /callback/sumup/:chargeId/:token is called by SumUp itself — no session,
// authorized instead by the random per-charge token embedded in the
// callback URL (SumUp's webhook isn't documented as signed, unlike
// Bancontact's).
//
// No more local pending-queue/claim flow: that only ever existed for the
// iOS SumUp Air bridge, which is retired (SumUp Air itself is gone; a
// specific Solo reader is targeted directly now, chosen in Instellingen).
import type { Env } from '../env';
import { json } from '../http';
import { broadcastPaymentEvent } from '../devicehub-client';
import { getDecryptedPaymentCredential } from '../organizations/payment-credentials';
import { createSumupReaderCheckout, SumupCloudApiError, listSumupReaders } from './sumup-cloud-api';
import { createCharge, getCharge, setChargeProviderRef, resolveCharge, type ChargeRecord } from './charges';
import { ensureChargePolling } from './charge-poller-client';

// Called by the settings page to populate the "SumUp Solo-readers" panel
// with the org's actual paired readers, fetched live from SumUp — nothing is
// cached locally, so a reader removed from the SumUp account just disappears
// here too on next refresh.
export async function listSumupReadersForOrg(request: Request, env: Env): Promise<Response> {
  const orgId = new URL(request.url).searchParams.get('org_id');
  if (!orgId) return json({ error: 'org_id is required' }, 400);

  const credential = await getDecryptedPaymentCredential(env, orgId, 'sumup');
  const merchantId = credential?.merchantId ? String(credential.merchantId) : '';
  const apiKey = credential?.apiKey ? String(credential.apiKey) : '';
  if (!merchantId || !apiKey) {
    return json({ configured: false, readers: [] });
  }

  try {
    const readers = await listSumupReaders(merchantId, apiKey);
    return json({ configured: true, readers });
  } catch (err) {
    const message = err instanceof SumupCloudApiError ? err.message : 'Kon SumUp readers niet ophalen';
    return json({ configured: true, readers: [], error: message }, 502);
  }
}

interface CreateChargeBody {
  amount?: number;
  description?: string;
  posTerminalId?: string;
  method?: string;
  items?: Record<string, unknown>;
  slotId?: string;
  deviceId?: string;
  deviceName?: string;
  orgId?: string;
  // Set when this POS has a real SumUp Solo reader selected in Instellingen
  // — routes the charge through the Cloud API instead of just sitting
  // 'pending' for a manual confirm (cash always takes that path; sumup does
  // too when no reader is linked, e.g. testing via the simulator).
  readerId?: string;
}

export async function createSumupCharge(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as CreateChargeBody;
  const amountCents = Number(body.amount);

  if (!Number.isInteger(amountCents) || amountCents < 1) {
    return json({ error: 'amount (in cents, integer) is required' }, 400);
  }
  if (!body.orgId) {
    return json({ error: 'orgId is required' }, 400);
  }

  const posTerminalId = body.posTerminalId ? String(body.posTerminalId) : null;
  // Reused for any "manual confirm" method (cash included), not just sumup —
  // it's just a generic tracked-payment record under a sumup-shaped name.
  const method = (body.method ? String(body.method) : 'sumup') as ChargeRecord['method'];
  const orgId = String(body.orgId);

  const charge = await createCharge(env, {
    orgId,
    method,
    amountCents,
    description: body.description ? String(body.description).slice(0, 140) : '',
    posTerminalId,
    items: body.items || {},
    slotId: body.slotId ? String(body.slotId) : null,
    deviceId: body.deviceId ? String(body.deviceId) : null,
    deviceName: body.deviceName ? String(body.deviceName) : null,
    // From the BFF's session (serviceProxy.ts's setIdentityHeaders) — not
    // from the client body, since the client could claim to be anyone.
    userName: request.headers.get('X-User-Name') || null,
    userEmail: request.headers.get('X-User-Email') || null,
  });

  if (method === 'sumup' && body.readerId) {
    await dispatchToReader(env, charge, String(body.readerId));
  }

  // Unconditional — not just on a successful reader dispatch. This is what
  // actually makes expireStaleCharges' time-out backstop apply to every
  // charge: the DO's alarm only ever runs if something arms it, and a cash
  // charge, or a sumup charge that never dispatches (no reader selected, or
  // the dispatch call fails before setChargeProviderRef), previously had
  // nothing that ever poked it — meaning no backstop at all, contradicting
  // the "nothing stays pending forever" guarantee. Cheap and idempotent
  // (ensureChargePolling no-ops if an alarm is already scheduled), so no
  // reason to gate it.
  await ensureChargePolling(env);

  if (posTerminalId) {
    await broadcastPaymentEvent(env, posTerminalId, 'payment_updated', { payment_id: charge.id, method });
  }

  return json({ chargeId: charge.id }, 201);
}

async function dispatchToReader(env: Env, charge: ChargeRecord, readerId: string): Promise<void> {
  const credential = await getDecryptedPaymentCredential(env, charge.orgId, 'sumup');
  const merchantId = credential?.merchantId ? String(credential.merchantId) : '';
  const apiKey = credential?.apiKey ? String(credential.apiKey) : '';
  if (!merchantId || !apiKey) {
    await resolveCharge(env, charge.id, { success: false, errorMessage: 'SumUp cloud-API niet geconfigureerd voor deze organisatie' });
    return;
  }

  const callbackToken = crypto.randomUUID();

  try {
    const checkout = await createSumupReaderCheckout({
      merchantCode: merchantId,
      apiKey,
      readerId,
      amountCents: charge.amountCents,
      currency: 'EUR',
      description: charge.description,
      returnUrl: `${env.PUBLIC_BASE_URL}/api/callback/sumup/${charge.id}/${callbackToken}`,
    });
    await setChargeProviderRef(env, charge.id, checkout.checkoutId, { readerId, callbackToken });
    await ensureChargePolling(env); // fallback sweep in case the callback above never arrives
  } catch (err) {
    const message = err instanceof SumupCloudApiError ? err.message : 'Kon betaling niet naar SumUp-reader sturen';
    await resolveCharge(env, charge.id, { success: false, errorMessage: message });
  }
}

// Called by SumUp itself when a reader checkout resolves. No session —
// authorized by the random token embedded in the callback URL at dispatch
// time (see dispatchToReader above), checked against what's stored on the
// charge's provider_data.
export async function postSumupCallback(request: Request, env: Env, chargeId: string, token: string): Promise<Response> {
  const charge = await getCharge(env, chargeId);
  if (!charge || charge.method !== 'sumup') return json({ error: 'Unknown charge' }, 404);

  const expectedToken = (charge.providerData as { callbackToken?: string }).callbackToken;
  if (!expectedToken || expectedToken !== token) return json({ error: 'Unauthorized' }, 401);

  const body = (await request.json().catch(() => ({}))) as {
    payload?: { status?: string; failure_reason?: string | null };
  };
  const status = body.payload?.status;

  // SumUp's documented statuses are 'successful' | 'failed' — anything else
  // (an event type we don't recognize) is acknowledged without acting, so
  // SumUp doesn't keep retrying a delivery we can't do anything with anyway.
  if (status !== 'successful' && status !== 'failed') {
    return json({ ok: true });
  }

  await resolveCharge(env, chargeId, {
    success: status === 'successful',
    providerStatus: status,
    errorMessage: body.payload?.failure_reason || null,
  });

  return json({ ok: true });
}

// Called by the webapp itself (reached via the BFF, session-checked) when
// the cashier taps "confirm" on a manual cash/SumUp payment — the fallback
// for a sumup charge with no reader linked (e.g. the simulator), or cash.
export async function confirmChargeFromPos(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { chargeId?: string; success?: boolean };
  if (!body.chargeId) return json({ error: 'chargeId is required' }, 400);

  await resolveCharge(env, body.chargeId, { success: body.success !== false });
  return json({ ok: true, chargeId: body.chargeId });
}

export async function getSumupStatus(chargeId: string, env: Env): Promise<Response> {
  const charge = await getCharge(env, chargeId);
  if (!charge) return json({ error: 'Unknown chargeId' }, 404);

  return json({
    status: charge.status,
    providerStatus: charge.providerStatus,
    amountCents: charge.amountCents,
    transactionCode: charge.transactionCode,
    errorMessage: charge.errorMessage,
    method: charge.method,
    // Only ever set for bancontact — see createPayment in bancontact.ts.
    qrCodeUrl: (charge.providerData as { qrCodeUrl?: string | null }).qrCodeUrl || null,
    expiresAt: charge.expiresAt,
  });
}
