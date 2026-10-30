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
import { shiftForSale } from '../shifts';
import { staffForSale } from '../staff';
import type { Env } from '../env';
import { json } from '../http';
import { errorJson, providerErrorJson } from '../errors';
import { broadcastPaymentEvent, notifyTabChanged } from '../devicehub-client';
import { getDecryptedPaymentCredential } from '../organizations/payment-credentials';
import { deviceCaller } from '../device-keys';
import { callDeviceHub } from '../devicehub-client';
import { extractCaller, refuseUnlessOrgMember, requireOrgRole } from '../organizations/auth';
import { createSumupReaderCheckout, findSumupTransaction, getSumupReaderCheckoutStatus, SumupCloudApiError, listSumupReaders, pairSumupReader, removeSumupReader, terminateSumupReaderCheckout } from './sumup-cloud-api';
import { BANCONTACT_TERMINAL_STATUSES, cancelBancontactCharge, getBancontactPaymentStatus } from './bancontact';
import { createCharge, getCharge, parseTipCents, setChargeProviderRef, resolveCharge, type ChargeRecord } from './charges';
import { ensureChargePolling } from './charge-poller-client';
import { customerOrder, isPendingTabChargeConflict, prepareTabCharge } from '../tabs';
import { newTapToken, notifyTapPhone } from '../tap-to-pay';

// Called by the settings page to populate the "SumUp Solo-readers" panel
// with the org's actual paired readers, fetched live from SumUp — nothing is
// cached locally, so a reader removed from the SumUp account just disappears
// here too on next refresh.
export async function listSumupReadersForOrg(request: Request, env: Env): Promise<Response> {
  const orgId = new URL(request.url).searchParams.get('org_id');
  if (!orgId) return json({ error: 'org_id is required' }, 400);
  const refused = await refuseUnlessOrgMember(request, env, orgId);
  if (refused) return refused;

  const credential = await getDecryptedPaymentCredential(env, orgId, 'sumup');
  const merchantId = credential?.merchantId ? String(credential.merchantId) : '';
  const apiKey = credential?.apiKey ? String(credential.apiKey) : '';
  if (!merchantId || !apiKey) {
    return json({ configured: false, readers: [], tapToPay: false });
  }
  // Tap to Pay through the SumUp app: an affiliate key is set.
  const tapToPay = Boolean(credential?.affiliateKey);

  try {
    const readers = await listSumupReaders(merchantId, apiKey);
    return json({ configured: true, readers, tapToPay });
  } catch (err) {
    return providerErrorJson('sumup_readers_failed', err instanceof SumupCloudApiError ? err.message : null, 502, { configured: true, readers: [], tapToPay });
  }
}

// The console's Toestellen page: pair a reader by its code, or unpair one —
// an admin of the org only. Nothing is stored here either: the list above
// shows the result on its next fetch.
async function sumupAccountForAdmin(request: Request, env: Env, orgId: string): Promise<Response | { merchantId: string; apiKey: string }> {
  const caller = extractCaller(request);
  if (!caller) return json({ error: 'Unauthorized' }, 401);
  if (!(await requireOrgRole(env, orgId, caller, ['admin']))) return json({ error: 'Forbidden' }, 403);
  const credential = await getDecryptedPaymentCredential(env, orgId, 'sumup');
  const merchantId = credential?.merchantId ? String(credential.merchantId) : '';
  const apiKey = credential?.apiKey ? String(credential.apiKey) : '';
  if (!merchantId || !apiKey) return errorJson('sumup_not_configured', 409);
  return { merchantId, apiKey };
}

export async function pairSumupReaderForOrg(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { orgId?: unknown; pairingCode?: unknown; name?: unknown } | null;
  const orgId = typeof body?.orgId === 'string' ? body.orgId : '';
  if (!orgId) return json({ error: 'orgId is required' }, 400);
  const account = await sumupAccountForAdmin(request, env, orgId);
  if (account instanceof Response) return account;

  // As shown on the device (or a virtual reader's in SumUp's dashboard);
  // spaces, dashes and case don't matter to the person typing it. Only a
  // plain sanity check here — SumUp says whether it's a code (its reason is passed on).
  const pairingCode = typeof body?.pairingCode === 'string' ? body.pairingCode.replace(/[\s-]+/g, '').toUpperCase() : '';
  if (!/^[A-Z0-9]{4,16}$/.test(pairingCode)) return errorJson('sumup_pairing_code_invalid', 400);
  const name = (typeof body?.name === 'string' ? body.name.trim() : '').slice(0, 100) || 'Solo';

  try {
    const reader = await pairSumupReader(account.merchantId, account.apiKey, pairingCode, name);
    return json({ reader }, 201);
  } catch (err) {
    return providerErrorJson('sumup_pair_failed', err instanceof SumupCloudApiError ? err.message : null, 502);
  }
}

export async function removeSumupReaderForOrg(request: Request, env: Env, readerId: string): Promise<Response> {
  const orgId = new URL(request.url).searchParams.get('org_id');
  if (!orgId) return json({ error: 'org_id is required' }, 400);
  const account = await sumupAccountForAdmin(request, env, orgId);
  if (account instanceof Response) return account;
  try {
    await removeSumupReader(account.merchantId, account.apiKey, readerId);
    return json({ ok: true });
  } catch (err) {
    return providerErrorJson('sumup_remove_failed', err instanceof SumupCloudApiError ? err.message : null, 502);
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
  // too when no reader is linked: the cashier confirms it on the kassa).
  readerId?: string;
  // The tab this charge settles — see tabs.ts.
  tabId?: string;
  // Fooi, part of amount — see charges.ts parseTipCents.
  tipCents?: number;
  splitPart?: boolean;
  partial?: boolean;
  // Per item: [{ lineId, quantity }] — the units this payment covers.
  lines?: unknown;
  registerId?: unknown;
  // Tap to Pay on this phone through the SumUp app (see sumupApp below).
  app?: unknown;
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
  const refused = await refuseUnlessOrgMember(request, env, orgId);
  if (refused) return refused;
  // The person handling it on a shared kassa (staff.ts).
  const staff = await staffForSale(request, env, orgId);
  if (staff instanceof Response) return staff;
  // On a register: its open shift (none open: refused).
  const shiftId = await shiftForSale(env, orgId, body.registerId);
  if (shiftId instanceof Response) return shiftId;

  // Tap to Pay through the SumUp app: the org's affiliate key, for the link.
  const app = method === 'sumup' && body.app === true;
  let sumupApp: { affiliateKey: string; appId: string } | null = null;
  if (app) {
    const credential = await getDecryptedPaymentCredential(env, orgId, 'sumup');
    if (!credential?.apiKey || !credential.affiliateKey) return errorJson('sumup_app_not_configured', 409);
    sumupApp = { affiliateKey: String(credential.affiliateKey), appId: String(credential.appId ?? '') };
  }

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

  let charge;
  try {
    charge = await createCharge(env, {
      orgId,
      method,
      amountCents,
      description,
      posTerminalId,
      items,
      slotId: body.slotId ? String(body.slotId) : null,
      deviceId: body.deviceId ? String(body.deviceId) : null,
      deviceName: body.deviceName ? String(body.deviceName) : null,
      // From the BFF's session (serviceProxy.ts's setIdentityHeaders) — not
      // from the client body, since the client could claim to be anyone.
      userName: request.headers.get('X-User-Name') || null,
      userEmail: request.headers.get('X-User-Email') || null,
      staffId: staff?.id ?? null,
      staffName: staff?.name ?? null,
      shiftId,
      tabId,
      tipCents,
      splitPart: body.splitPart === true ? splitPart : 0,
      lines,
      // The waiter goes to the SumUp app and back: more time than at a reader.
      expiresAt: app ? new Date(Date.now() + APP_CHARGE_TTL_MS).toISOString() : null,
    });
  } catch (err) {
    if (isPendingTabChargeConflict(err)) return errorJson('tab_payment_already_pending', 409);
    throw err;
  }

  // A dispatch that fails resolves the charge (failed) right away, and
  // resolveCharge already tells the org's kassas about the tab then.
  const resolved = method === 'sumup' && body.readerId && !app ? await dispatchToReader(env, charge, String(body.readerId)) : false;
  // The charge's own id is the payment's foreign id at SumUp: the poller
  // looks it up there (provider_ref set: it's polled).
  // Its token: the kassa's QR for it, and its Tap to Pay phone's link (tap-to-pay.ts).
  const tapToken = app ? newTapToken() : null;
  if (app) await setChargeProviderRef(env, charge.id, charge.id, { app: true, tapToken });
  // At a kassa: a notification on its Tap to Pay phone.
  if (app && posTerminalId) notifyTapPhone(env, charge);
  if (tabId && !resolved) notifyTabChanged(env, orgId, tabId);

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

  return json({ chargeId: charge.id, ...(sumupApp ? { sumupApp, tapToken } : {}) }, 201);
}

const APP_CHARGE_TTL_MS = 10 * 60 * 1000;

// Tap to Pay through the SumUp app ("Payment Switch", developer.sumup.com):
// the waiter's page opens the app with the amount and our charge id as the
// foreign transaction id; the app takes the card and opens our page again
// with smp-status. That status is never believed by itself — SumUp's own
// record of the transaction decides (also what the poller does).
// `reportedFailed`: the app said it failed; with no transaction at SumUp
// at all, nothing was paid — the charge fails right away.
export async function checkSumupAppCharge(env: Env, charge: ChargeRecord, reportedFailed = false): Promise<void> {
  const credential = await getDecryptedPaymentCredential(env, charge.orgId, 'sumup');
  const merchantId = credential?.merchantId ? String(credential.merchantId) : '';
  const apiKey = credential?.apiKey ? String(credential.apiKey) : '';
  if (!merchantId || !apiKey) return;
  const tx = await findSumupTransaction(merchantId, apiKey, charge.id);
  if (!tx) {
    if (reportedFailed) await resolveCharge(env, charge.id, { success: false, providerStatus: 'failed', errorMessage: 'Niet betaald in de SumUp-app' });
    return;
  }
  if (tx.status === 'SUCCESSFUL') {
    const right = tx.amountCents === charge.amountCents && tx.currency === 'EUR';
    await resolveCharge(env, charge.id, {
      success: right,
      providerStatus: tx.status,
      transactionCode: tx.transactionCode,
      errorMessage: right ? null : `Bedrag bij SumUp (${tx.amountCents} cent ${tx.currency}) klopt niet met de betaling`,
    });
  } else if (tx.status === 'FAILED' || tx.status === 'CANCELLED') {
    await resolveCharge(env, charge.id, { success: false, providerStatus: tx.status, transactionCode: tx.transactionCode });
  }
}

// The waiter's page, back from the SumUp app: check it now rather than at
// the poller's next round. A member of the charge's org only.
export async function postSumupAppReturn(request: Request, env: Env): Promise<Response> {
  if (!extractCaller(request)) return json({ error: 'Unauthorized' }, 401);
  const body = (await request.json().catch(() => ({}))) as { chargeId?: unknown; status?: unknown };
  const charge = typeof body.chargeId === 'string' ? await getCharge(env, body.chargeId) : null;
  if (!charge || charge.method !== 'sumup' || !(charge.providerData as { app?: boolean }).app) return json({ error: 'Unknown chargeId' }, 404);
  const refused = await refuseUnlessOrgMember(request, env, charge.orgId);
  if (refused) return refused;
  if (charge.status === 'pending') {
    try {
      await checkSumupAppCharge(env, charge, body.status === 'failed');
    } catch (err) {
      // SumUp unreachable: the poller tries again.
      console.error(`Kon SumUp-transactie niet opvragen voor ${charge.id}`, err);
    }
  }
  const current = await getCharge(env, charge.id);
  return chargeStatusResponse(env, current ?? charge);
}

// True when the dispatch failed and the charge was resolved (as failed) here.
async function dispatchToReader(env: Env, charge: ChargeRecord, readerId: string): Promise<boolean> {
  const credential = await getDecryptedPaymentCredential(env, charge.orgId, 'sumup');
  const merchantId = credential?.merchantId ? String(credential.merchantId) : '';
  const apiKey = credential?.apiKey ? String(credential.apiKey) : '';
  if (!merchantId || !apiKey) {
    await resolveCharge(env, charge.id, { success: false, errorMessage: 'SumUp cloud-API niet geconfigureerd voor deze organisatie' });
    return true;
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
    return false;
  } catch (err) {
    const message = err instanceof SumupCloudApiError ? err.message : 'Kon betaling niet naar SumUp-reader sturen';
    await resolveCharge(env, charge.id, { success: false, errorMessage: message });
    return true;
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
// for a sumup charge with no reader linked, or cash.
// Only by a member of the charge's own org.
export async function confirmChargeFromPos(request: Request, env: Env): Promise<Response> {
  if (!extractCaller(request)) return json({ error: 'Unauthorized' }, 401);
  const body = (await request.json().catch(() => ({}))) as { chargeId?: string; success?: boolean; extraTipCents?: unknown };
  if (!body.chargeId) return json({ error: 'chargeId is required' }, 400);
  const extraTipCents = parseTipCents(body.extraTipCents);
  if (extraTipCents === null) return json({ error: 'extraTipCents must be an integer between 0 and 100000' }, 400);
  const charge = await getCharge(env, body.chargeId);
  if (!charge) return json({ error: 'Unknown chargeId' }, 404);
  const refused = await refuseUnlessOrgMember(request, env, charge.orgId);
  if (refused) return refused;

  // Tap to Pay: only SumUp says it's paid — never a tap on the kassa. A
  // cancel asks SumUp first: the guest may just have paid on the phone.
  if (charge.method === 'sumup' && (charge.providerData as { app?: boolean }).app) {
    if (body.success !== false) return errorJson('tap_payment_not_manual', 409);
    if (charge.status === 'pending') {
      try {
        await checkSumupAppCharge(env, charge, true);
      } catch (err) {
        console.error(`Kon SumUp-transactie niet opvragen voor ${charge.id}`, err);
      }
      await resolveCharge(env, charge.id, { success: false, providerStatus: 'cancelled', errorMessage: 'Geannuleerd aan de kassa' });
    }
    const current = await getCharge(env, charge.id);
    return json({ ok: true, chargeId: charge.id, status: current?.status ?? charge.status });
  }

  // Cancelled while a Bancontact QR or a SumUp reader is waiting: stopped at
  // the provider first, then its own word on how it ended — the customer
  // may have just paid (then it stays paid). Never marked failed on our side
  // alone while the provider could still take the payment.
  // The provider couldn't be reached: it stays pending (the customer could
  // still pay — that must never be lost) and the kassa says to try again;
  // the poller ends it once it expires.
  // Only one that reached the provider (a payment id there); one that never
  // did can't be paid, so it's simply cancelled below.
  if (body.success === false && charge.status === 'pending' && charge.providerRef && (charge.method === 'bancontact' || (charge.method === 'sumup' && (charge.providerData as { readerId?: string }).readerId))) {
    let stopped = false;
    try {
      stopped = await cancelAtProvider(env, charge);
    } catch (err) {
      console.error(`Kon betaling ${charge.id} niet annuleren bij de provider`, err);
    }
    const now = await getCharge(env, charge.id);
    if (now?.status === 'pending' && stopped) await resolveCharge(env, charge.id, { success: false, providerStatus: 'cancelled', errorMessage: 'Geannuleerd aan de kassa' });
    const current = await getCharge(env, charge.id);
    if (current?.status === 'pending') return errorJson('payment_cancel_unconfirmed', 409);
    return json({ ok: true, chargeId: charge.id, status: current?.status ?? charge.status });
  }

  // "Keep the change": only for cash, where the cashier holds the money.
  if (extraTipCents > 0 && (charge.method !== 'cash' || body.success === false)) return json({ error: 'extraTipCents is only for a confirmed cash payment' }, 400);
  if (charge.tipCents + extraTipCents > 100_000) return json({ error: 'The tip may not exceed 100000' }, 400);
  await resolveCharge(env, body.chargeId, { success: body.success !== false, extraTipCents });
  return json({ ok: true, chargeId: body.chargeId });
}

// Stops it at the provider, then takes the provider's own word on how it
// ended (resolved here when it says). True when the provider took the cancel.
async function cancelAtProvider(env: Env, charge: ChargeRecord): Promise<boolean> {
  if (charge.method === 'bancontact' && charge.providerRef) {
    const stopped = await cancelBancontactCharge(env, charge.orgId, charge.providerRef);
    const result = await getBancontactPaymentStatus(env, charge.orgId, charge.providerRef).catch(() => null);
    if (result && BANCONTACT_TERMINAL_STATUSES.has(result.status)) await resolveCharge(env, charge.id, { success: result.status === 'SUCCEEDED', providerStatus: result.status });
    return stopped;
  }
  const readerId = (charge.providerData as { readerId?: string }).readerId;
  if (charge.method !== 'sumup' || !charge.providerRef || !readerId) return false;
  const credential = await getDecryptedPaymentCredential(env, charge.orgId, 'sumup');
  const merchantCode = credential?.merchantId ? String(credential.merchantId) : '';
  const apiKey = credential?.apiKey ? String(credential.apiKey) : '';
  if (!merchantCode || !apiKey) return false;
  const stopped = await terminateSumupReaderCheckout({ merchantCode, apiKey, readerId });
  const result = await getSumupReaderCheckoutStatus({ merchantCode, apiKey, readerId, checkoutId: charge.providerRef }).catch(() => null);
  if (result && result.status !== 'pending') await resolveCharge(env, charge.id, { success: result.status === 'successful', providerStatus: result.status, errorMessage: result.paymentFailureReason });
  return stopped;
}

// The kassa and the customer display follow a charge here —
// a member of the charge's own org only.
export async function getSumupStatus(request: Request, chargeId: string, env: Env): Promise<Response> {
  if (extractCaller(request)) {
    const charge = await getCharge(env, chargeId);
    if (!charge) return json({ error: 'Unknown chargeId' }, 404);
    const refused = await refuseUnlessOrgMember(request, env, charge.orgId);
    if (refused) return refused;
    return chargeStatusResponse(env, charge);
  }
  // A customer display with its own key (device-keys.ts): only a charge of
  // the kassa it's linked to.
  const device = await deviceCaller(request, env);
  if (!device) return json({ error: 'Unauthorized' }, 401);
  const charge = await getCharge(env, chargeId);
  if (!charge || device.role !== 'cfd' || charge.orgId !== device.orgId || !charge.posTerminalId) return json({ error: 'Forbidden' }, 403);
  const self = await callDeviceHub(env, `/devices/${encodeURIComponent(device.terminalId)}`, {});
  const linkedTo = self.ok ? ((await self.json()) as { linked_to?: string | null }).linked_to : null;
  if (linkedTo !== charge.posTerminalId) return json({ error: 'Forbidden' }, 403);
  return chargeStatusResponse(env, charge);
}

async function chargeStatusResponse(env: Env, charge: NonNullable<Awaited<ReturnType<typeof getCharge>>>): Promise<Response> {
  return json({
    status: charge.status,
    providerStatus: charge.providerStatus,
    amountCents: charge.amountCents,
    tipCents: charge.tipCents,
    transactionCode: charge.transactionCode,
    errorMessage: charge.errorMessage,
    method: charge.method,
    // Only ever set for bancontact — see createPayment in bancontact.ts.
    qrCodeUrl: (charge.providerData as { qrCodeUrl?: string | null }).qrCodeUrl || null,
    expiresAt: charge.expiresAt,
    // The order being paid, for the customer display (null: not a tab charge).
    order: charge.tabId ? await customerOrder(env, charge.orgId, charge.tabId, charge.id) : null,
    // Which part of an equal split this payment is (null: not a part).
    splitPart: charge.splitPart || null,
  });
}
