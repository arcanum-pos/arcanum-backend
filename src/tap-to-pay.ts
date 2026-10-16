// A kassa's Tap to Pay phone (2026-10-16): a kassa without a SumUp reader
// takes cards through the SumUp app on a phone. The cashier picks "Tap to
// Pay" (an app charge, payments/sumup.ts); the kassa's own phone — a device
// with role 'tap', paired with a code for that kassa, like a customer
// display — gets the payment: live over its socket (devicehub sends it the
// kassa's payment events) or, while it's locked, as a notification (Web
// Push). One tap there opens the SumUp app with the amount. Paid or not is
// decided as for the waiter: SumUp's own record of the transaction.
//
// The kassa also shows the payment as a QR code (any phone with the SumUp
// app scans it — no pairing): it carries the charge's own random token.
//
//   GET    /organizations/:org/devices/:self/tap    the phone's key   { kassa, charge, push }
//   POST   /organizations/:org/devices/:self/push   the phone's key   { subscription }
//   DELETE /organizations/:org/devices/:self/push   the phone's key
//   GET    /public/tap/:charge/:token               the QR's link     the charge (amount, the SumUp app's link details)
//   POST   /public/tap/:charge/:token/return        { status }        back from the SumUp app: check it now
import { waitUntil } from 'cloudflare:workers';
import type { Env } from './env';
import { callDeviceHub } from './devicehub-client';
import { deviceCaller, type DeviceCaller } from './device-keys';
import { errorJson } from './errors';
import { json } from './http';
import { getDecryptedPaymentCredential } from './organizations/payment-credentials';
import { getCharge, type ChargeRecord } from './payments/charges';
import { checkSumupAppCharge } from './payments/sumup';
import { parseSubscription, sendPush, webPushPublicKey, type PushSubscriptionJson } from './web-push';

// A charge's token for the QR and the phone's link: 128 bits, base64url.
export function newTapToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const tapTokenOf = (charge: ChargeRecord): string | null => {
  const data = charge.providerData as { app?: boolean; tapToken?: string };
  return charge.method === 'sumup' && data.app && typeof data.tapToken === 'string' ? data.tapToken : null;
};

function sameToken(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// What the phone needs for one payment: the amount, and what goes into the
// SumUp app's link (the affiliate key isn't a secret: it's in every link).
async function tapCharge(env: Env, charge: ChargeRecord, token: string) {
  const credential = charge.status === 'pending' ? await getDecryptedPaymentCredential(env, charge.orgId, 'sumup') : null;
  const org = await env.DB.prepare('SELECT name FROM organizations WHERE id = ?').bind(charge.orgId).first<{ name: string }>();
  return {
    chargeId: charge.id,
    token,
    status: charge.status,
    amountCents: charge.amountCents,
    title: (charge.description || org?.name || 'Tap to Pay').slice(0, 60),
    errorMessage: charge.errorMessage,
    sumupApp: credential?.affiliateKey ? { affiliateKey: String(credential.affiliateKey), appId: String(credential.appId ?? '') } : null,
  };
}

// --- The paired phone ---

async function phoneOf(request: Request, env: Env, orgId: string, terminalId: string): Promise<DeviceCaller | Response> {
  const device = await deviceCaller(request, env);
  if (!device) return json({ error: 'Unauthorized' }, 401);
  if (device.role !== 'tap' || device.orgId !== orgId || device.terminalId !== terminalId) return json({ error: 'Forbidden' }, 403);
  return device;
}

async function deviceRow(env: Env, terminalId: string): Promise<{ org_id: string | null; linked_to: string | null; name: string | null } | null> {
  const res = await callDeviceHub(env, `/devices/${encodeURIComponent(terminalId)}`, {});
  return res.ok ? ((await res.json()) as { org_id: string | null; linked_to: string | null; name: string | null } | null) : null;
}

// Its kassa, the payment waiting there (if any) and its notifications.
async function tapState(request: Request, env: Env, orgId: string, terminalId: string): Promise<Response> {
  const phone = await phoneOf(request, env, orgId, terminalId);
  if (phone instanceof Response) return phone;
  const self = await deviceRow(env, terminalId);
  const kassa = self?.linked_to ? await deviceRow(env, self.linked_to) : null;
  let charge = null;
  if (self?.linked_to && kassa?.org_id === orgId) {
    const row = await env.DB.prepare(
      "SELECT id FROM charges WHERE org_id = ? AND pos_terminal_id = ? AND status = 'pending' AND method = 'sumup' ORDER BY created_at DESC LIMIT 1"
    )
      .bind(orgId, self.linked_to)
      .first<{ id: string }>();
    const pending = row ? await getCharge(env, row.id) : null;
    const token = pending ? tapTokenOf(pending) : null;
    if (pending && token) charge = await tapCharge(env, pending, token);
  }
  const publicKey = await webPushPublicKey(env);
  const subscribed = publicKey ? !!(await env.DB.prepare('SELECT 1 FROM device_push_subscriptions WHERE terminal_id = ?').bind(terminalId).first()) : false;
  return json({
    name: self?.name ?? null,
    kassa: self?.linked_to && kassa?.org_id === orgId ? { terminalId: self.linked_to, name: kassa.name } : null,
    charge,
    push: publicKey ? { publicKey, subscribed } : null,
  });
}

async function setTapPush(request: Request, env: Env, orgId: string, terminalId: string, remove: boolean): Promise<Response> {
  const phone = await phoneOf(request, env, orgId, terminalId);
  if (phone instanceof Response) return phone;
  if (remove) {
    await env.DB.prepare('DELETE FROM device_push_subscriptions WHERE terminal_id = ?').bind(terminalId).run();
    return json({ ok: true });
  }
  if (!(await webPushPublicKey(env))) return errorJson('push_unavailable', 409);
  const body = (await request.json().catch(() => null)) as { subscription?: unknown } | null;
  const subscription = parseSubscription(body?.subscription);
  if (!subscription) return errorJson('push_subscription_invalid', 400);
  await env.DB.prepare('INSERT OR REPLACE INTO device_push_subscriptions (terminal_id, org_id, subscription, updated_at) VALUES (?, ?, ?, ?)')
    .bind(terminalId, orgId, JSON.stringify(subscription), new Date().toISOString())
    .run();
  return json({ ok: true });
}

function euros(cents: number): string {
  return `€${Math.floor(cents / 100)},${String(cents % 100).padStart(2, '0')}`;
}

export function tapPushText(locale: string, o: { amountCents: number; kassa: string }): string {
  const amount = euros(o.amountCents);
  if (locale === 'fr') return `${amount} à payer à ${o.kassa} — touchez pour Tap to Pay.`;
  if (locale === 'en') return `${amount} to pay at ${o.kassa} — tap for Tap to Pay.`;
  return `${amount} te betalen aan ${o.kassa} — tik voor Tap to Pay.`;
}

// A Tap to Pay payment just started at a kassa: a notification on its
// phone, in the background (the kassa doesn't wait for it). Its open page
// hears it over its socket anyway; this is for the phone in a pocket.
export function notifyTapPhone(env: Env, charge: ChargeRecord): void {
  if (!env.WEB_PUSH_KEY || !charge.posTerminalId) return;
  const posTerminalId = charge.posTerminalId;
  const work = (async () => {
    const linked = await callDeviceHub(env, `/devices/${encodeURIComponent(posTerminalId)}/linked?role=tap`, {});
    const phone = linked.ok ? ((await linked.json()) as { terminal_id?: string } | null) : null;
    if (!phone?.terminal_id) return;
    const row = await env.DB.prepare('SELECT subscription FROM device_push_subscriptions WHERE terminal_id = ? AND org_id = ?')
      .bind(phone.terminal_id, charge.orgId)
      .first<{ subscription: string }>();
    if (!row) return;
    const [kassa, org] = await Promise.all([
      deviceRow(env, posTerminalId),
      env.DB.prepare('SELECT name, locale FROM organizations WHERE id = ?').bind(charge.orgId).first<{ name: string; locale: string | null }>(),
    ]);
    const result = await sendPush(env, JSON.parse(row.subscription) as PushSubscriptionJson, {
      title: org?.name ?? 'Tap to Pay',
      body: tapPushText(org?.locale || 'nl', { amountCents: charge.amountCents, kassa: kassa?.name || 'de kassa' }),
      url: '/tap.html',
      tag: 'tap-to-pay',
    });
    if (!result.ok) {
      console.error(`Push naar Tap to Pay-telefoon mislukt: ${result.error}`);
      if (result.gone) await env.DB.prepare('DELETE FROM device_push_subscriptions WHERE terminal_id = ?').bind(phone.terminal_id).run();
    }
  })().catch((err) => console.error('Push naar Tap to Pay-telefoon mislukt', err));
  try {
    waitUntil(work);
  } catch {
    // Outside a request context: it still runs, just unguarded.
  }
}

// --- The QR's link (and the phone's): the charge and its token ---

async function chargeByToken(env: Env, chargeId: string, token: string): Promise<ChargeRecord | null> {
  const charge = await getCharge(env, chargeId);
  const expected = charge ? tapTokenOf(charge) : null;
  return charge && expected && sameToken(expected, token) ? charge : null;
}

async function publicTapCharge(env: Env, chargeId: string, token: string): Promise<Response> {
  const charge = await chargeByToken(env, chargeId, token);
  if (!charge) return errorJson('tap_payment_not_found', 404);
  return json(await tapCharge(env, charge, token));
}

// Back from the SumUp app: SumUp's own record decides, now rather than at
// the poller's next round.
async function publicTapReturn(request: Request, env: Env, chargeId: string, token: string): Promise<Response> {
  const charge = await chargeByToken(env, chargeId, token);
  if (!charge) return errorJson('tap_payment_not_found', 404);
  const body = (await request.json().catch(() => ({}))) as { status?: unknown };
  if (charge.status === 'pending') {
    try {
      await checkSumupAppCharge(env, charge, body.status === 'failed');
    } catch (err) {
      // SumUp unreachable: the poller tries again.
      console.error(`Kon SumUp-transactie niet opvragen voor ${charge.id}`, err);
    }
  }
  return json(await tapCharge(env, (await getCharge(env, charge.id)) ?? charge, token));
}

export async function dispatchPublicTapRoute(request: Request, env: Env, pathname: string): Promise<Response | null> {
  const match = pathname.match(/^\/public\/tap\/([^/]+)\/([^/]+)(\/return)?$/);
  if (!match) return null;
  const [, chargeId, token, back] = match;
  if (back) return request.method === 'POST' ? publicTapReturn(request, env, chargeId, decodeURIComponent(token)) : null;
  return request.method === 'GET' ? publicTapCharge(env, chargeId, decodeURIComponent(token)) : null;
}

export async function dispatchTapDeviceRoute(request: Request, env: Env, pathname: string): Promise<Response | null> {
  const match = pathname.match(/^\/organizations\/([^/]+)\/devices\/([^/]+)\/(tap|push)$/);
  if (!match) return null;
  const [, orgId, id, action] = match;
  const terminalId = decodeURIComponent(id);
  if (action === 'tap') return request.method === 'GET' ? tapState(request, env, orgId, terminalId) : null;
  if (request.method === 'POST' || request.method === 'DELETE') return setTapPush(request, env, orgId, terminalId, request.method === 'DELETE');
  return null;
}
