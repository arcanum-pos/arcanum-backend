// A kassa's Tap to Pay phone (tap-to-pay.ts): paired with a code for one
// kassa, it gets the kassa's Tap to Pay payment — over its page, and as a
// notification while it's locked — and the kassa's QR does the same for any
// phone, by the charge's own token. SumUp's record decides, as for the
// waiter; a cancel at the kassa asks SumUp first. devicehub, SumUp and the
// push service stubbed.
import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiWith, createTab, DEVICE, getTab, line, rows, seedOrg, storePaymentConfig, type TestOrg } from './helpers';
import { b64url } from '../src/web-push';

interface Device {
  terminal_id: string;
  org_id: string;
  role: string;
  linked_to: string | null;
  name: string | null;
}
let registry: Map<string, Device>;
let transaction: () => Response;
let pushed: { endpoint: string; body: Uint8Array }[];

beforeEach(() => {
  registry = new Map();
  pushed = [];
  transaction = () => Response.json({ detail: 'Not found' }, { status: 404 });
  vi.spyOn(env.ARCANUM_DEVICEHUB_SERVICE, 'fetch').mockImplementation(async (input: any, init?: any) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body = (request.method === 'GET' ? null : await request.json().catch(() => null)) as any;
    const p = url.pathname;
    if (p === '/devices/register') {
      registry.set(body.terminal_id, { terminal_id: body.terminal_id, org_id: body.org_id, role: body.role, linked_to: null, name: body.name ?? null });
      return Response.json(registry.get(body.terminal_id));
    }
    if (p === '/devices/remove') {
      registry.delete(body.terminal_id);
      return Response.json({ ok: true });
    }
    if (p === '/devices/link') {
      registry.get(body.terminal_id)!.linked_to = body.pos_terminal_id;
      return Response.json(registry.get(body.terminal_id));
    }
    if (p === '/devices/unlink') {
      registry.get(body.terminal_id)!.linked_to = null;
      return Response.json({ ok: true });
    }
    let m = p.match(/^\/devices\/(.+)\/linked$/);
    if (m) return Response.json([...registry.values()].find((d) => d.role === url.searchParams.get('role') && d.linked_to === decodeURIComponent(m![1])) ?? null);
    m = p.match(/^\/devices\/([^/]+)$/);
    if (m && request.method === 'GET') return registry.has(decodeURIComponent(m[1])) ? Response.json(registry.get(decodeURIComponent(m[1]))) : Response.json({ error: 'Unknown terminal_id' }, { status: 404 });
    return Response.json({ ok: true });
  });
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname === 'api.sumup.com') {
      if (url.pathname === '/v2.1/merchants/MSANDBOX1/transactions') return transaction();
      return Response.json({ merchant_code: 'MSANDBOX1' });
    }
    if (url.hostname === 'fcm.googleapis.com') {
      pushed.push({ endpoint: request.url, body: new Uint8Array(await request.arrayBuffer()) });
      return new Response(null, { status: 201 });
    }
    return realFetch(input, init);
  });
});
afterEach(() => vi.restoreAllMocks());

async function vapidKey(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  return btoa(String.fromCharCode(...new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer)));
}

async function subscription() {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const p256dh = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer);
  return { endpoint: 'https://fcm.googleapis.com/fcm/send/tap-phone', keys: { p256dh: b64url(p256dh), auth: b64url(crypto.getRandomValues(new Uint8Array(16))) } };
}

let ENV: Record<string, string>;

// A request as arcanum-bff sends it for a device: no person, its key.
const asPhone = (key: string | null, method: string, path: string, body?: unknown) =>
  apiWith(ENV, method, path, { body, headers: { 'CF-Connecting-IP': '203.0.113.9', ...(key ? { 'X-Device-Key': key } : {}) } });

// An org with SumUp and Tap to Pay, a kassa, and its phone paired by code.
async function setup() {
  ENV = { WEB_PUSH_KEY: await vapidKey() };
  const org = await seedOrg();
  await storePaymentConfig(org, 'sumup', { merchantId: 'MSANDBOX1', apiKey: 'sup_sk_test', confirmedAt: '2026-10-16T00:00:00Z', affiliateKey: 'sup_afk_test123', appId: 'be.example.pos' });
  const kassa = `pos-${crypto.randomUUID()}`;
  registry.set(kassa, { terminal_id: kassa, org_id: org.orgId, role: 'pos', linked_to: null, name: 'Kassa toog' });
  const made = await apiWith(ENV, 'POST', `/organizations/${org.orgId}/device-pairings`, { user: org.admin, body: { role: 'tap', name: 'Telefoon toog', linkTo: kassa } });
  expect(made.status).toBe(201);
  const paired = await asPhone(null, 'POST', '/public/pair', { code: made.body.code });
  expect(paired.status).toBe(201);
  expect(paired.body).toMatchObject({ role: 'tap', linkedTo: kassa });
  return { org, kassa, phone: paired.body.terminalId as string, key: paired.body.deviceKey as string };
}

async function kassaCharge(org: TestOrg, kassa: string) {
  const tab = await createTab(org, { lines: [line('COLA', 'Cola', 300, 2)] });
  const res = await apiWith(ENV, 'POST', '/sumup/charge', { user: org.cashier, body: { orgId: org.orgId, method: 'sumup', app: true, tabId: tab.id, amount: 600, posTerminalId: kassa, ...DEVICE } });
  expect(res.status).toBe(201);
  return { tab, chargeId: res.body.chargeId as string, token: res.body.tapToken as string };
}

async function waitForPush(n = 1) {
  for (let i = 0; i < 100 && pushed.length < n; i++) await new Promise((r) => setTimeout(r, 10));
  return pushed;
}

const paid = () => Response.json({ status: 'SUCCESSFUL', amount: 6, currency: 'EUR', transaction_code: 'TAPK4W2K' });

describe("a kassa's Tap to Pay phone", () => {
  it('is paired for one kassa only, and replaces its previous phone', async () => {
    const { org, kassa, phone } = await setup();
    const noKassa = await apiWith(ENV, 'POST', `/organizations/${org.orgId}/device-pairings`, { user: org.admin, body: { role: 'tap', name: 'Telefoon' } });
    expect(noKassa.body.code).toBe('tap_needs_kassa');
    const again = await apiWith(ENV, 'POST', `/organizations/${org.orgId}/device-pairings`, { user: org.admin, body: { role: 'tap', name: 'Nieuwe telefoon', linkTo: kassa } });
    const second = await asPhone(null, 'POST', '/public/pair', { code: again.body.code });
    expect(registry.get(second.body.terminalId)!.linked_to).toBe(kassa);
    expect(registry.get(phone)!.linked_to).toBeNull();
  });

  it('turns on notifications with its own key, and sees its kassa; nobody else can', async () => {
    const { org, kassa, phone, key } = await setup();
    const path = `/organizations/${org.orgId}/devices/${phone}`;
    const state = await asPhone(key, 'GET', `${path}/tap`);
    expect(state.body).toMatchObject({ name: 'Telefoon toog', kassa: { terminalId: kassa, name: 'Kassa toog' }, charge: null, push: { subscribed: false } });
    expect((await asPhone(null, 'GET', `${path}/tap`)).status).toBe(401);
    expect((await apiWith(ENV, 'GET', `${path}/tap`, { user: org.admin })).status).toBe(401);
    expect((await asPhone(key, 'POST', `${path}/push`, { subscription: { endpoint: 'https://evil.example/x', keys: {} } })).body.code).toBe('push_subscription_invalid');
    expect((await asPhone(key, 'POST', `${path}/push`, { subscription: await subscription() })).status).toBe(200);
    expect((await asPhone(key, 'GET', `${path}/tap`)).body.push.subscribed).toBe(true);
    // Another org's device key can't reach it.
    const other = await setup();
    expect((await asPhone(other.key, 'GET', `${path}/tap`)).status).toBe(403);
    expect((await asPhone(other.key, 'POST', `${path}/push`, { subscription: await subscription() })).status).toBe(403);
  });

  it('a Tap to Pay payment at its kassa: a notification on the phone, the payment on its page, paid when SumUp says so', async () => {
    const { org, kassa, phone, key } = await setup();
    const path = `/organizations/${org.orgId}/devices/${phone}`;
    await asPhone(key, 'POST', `${path}/push`, { subscription: await subscription() });
    const { tab, chargeId, token } = await kassaCharge(org, kassa);
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(await waitForPush()).toHaveLength(1);
    expect(pushed[0].endpoint).toBe('https://fcm.googleapis.com/fcm/send/tap-phone');

    const state = (await asPhone(key, 'GET', `${path}/tap`)).body;
    expect(state.charge).toMatchObject({ chargeId, token, status: 'pending', amountCents: 600, sumupApp: { affiliateKey: 'sup_afk_test123', appId: 'be.example.pos' } });

    // Back from the app: a "success" alone changes nothing; SumUp's record does.
    expect((await asPhone(null, 'POST', `/public/tap/${chargeId}/${token}/return`, { status: 'success' })).body.status).toBe('pending');
    transaction = paid;
    expect((await asPhone(null, 'POST', `/public/tap/${chargeId}/${token}/return`, { status: 'success' })).body.status).toBe('succeeded');
    expect((await getTab(org, tab.id)).status).toBe('closed');
    expect((await asPhone(key, 'GET', `${path}/tap`)).body.charge).toBeNull();
  });

  it("the kassa's QR: the charge by its token alone — a wrong token finds nothing", async () => {
    const { org, kassa } = await setup();
    const { chargeId, token } = await kassaCharge(org, kassa);
    const viaQr = await asPhone(null, 'GET', `/public/tap/${chargeId}/${token}`);
    expect(viaQr.body).toMatchObject({ chargeId, status: 'pending', amountCents: 600, sumupApp: { affiliateKey: 'sup_afk_test123' } });
    expect((await asPhone(null, 'GET', `/public/tap/${chargeId}/${token.slice(0, -1)}x`)).body.code).toBe('tap_payment_not_found');
    expect((await asPhone(null, 'POST', `/public/tap/${chargeId}/wrong/return`, { status: 'failed' })).body.code).toBe('tap_payment_not_found');
    // A cash charge has no such link.
    const cash = await createTab(org, { lines: [line('COLA', 'Cola', 300, 1)] });
    const c = await apiWith(ENV, 'POST', '/sumup/charge', { user: org.cashier, body: { orgId: org.orgId, method: 'cash', tabId: cash.id, amount: 300, ...DEVICE } });
    expect((await asPhone(null, 'GET', `/public/tap/${c.body.chargeId}/${token}`)).status).toBe(404);
  });

  it('never confirmed by hand at the kassa; a cancel asks SumUp first', async () => {
    const { org, kassa } = await setup();
    const confirm = (chargeId: string, success: boolean) => apiWith(ENV, 'POST', '/sumup/confirm', { user: org.cashier, body: { chargeId, success } });
    const first = await kassaCharge(org, kassa);
    expect((await confirm(first.chargeId, true)).body.code).toBe('tap_payment_not_manual');
    // Nothing at SumUp: cancelled.
    expect((await confirm(first.chargeId, false)).body.status).toBe('failed');
    expect((await getTab(org, first.tab.id)).status).toBe('open');
    // The guest just paid on the phone: the cancel finds it — paid after all.
    const second = await kassaCharge(org, kassa);
    transaction = paid;
    expect((await confirm(second.chargeId, false)).body.status).toBe('succeeded');
    expect((await getTab(org, second.tab.id)).status).toBe('closed');
  });

  it('removing the phone forgets its notifications and stops its key', async () => {
    const { org, phone, key } = await setup();
    const path = `/organizations/${org.orgId}/devices/${phone}`;
    await asPhone(key, 'POST', `${path}/push`, { subscription: await subscription() });
    expect((await apiWith(ENV, 'DELETE', path, { user: org.admin })).status).toBe(200);
    expect(await rows('SELECT * FROM device_push_subscriptions WHERE terminal_id = ?', phone)).toEqual([]);
    expect((await asPhone(key, 'GET', `${path}/tap`)).status).toBe(401);
  });
});
