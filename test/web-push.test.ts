// Web Push for self-ordering (ROADMAP §8b, release G'): the installation's
// key (WEB_PUSH_KEY), a browser subscribing on the order page, one
// notification per station as it turns ready — encrypted (RFC 8291) and
// signed (VAPID, RFC 8292) — and then no SMS; a browser gone: forgotten, the
// SMS after all. The push service is stubbed; the test decrypts what it got.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiWith, payCash, rows, seedOrg, type TestOrg } from './helpers';
import { b64url, encryptPayload, fromB64url, parseSubscription } from '../src/web-push';

// --- keys ---

async function vapidKey(): Promise<{ secret: string; publicKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const der = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer);
  return { secret: btoa(String.fromCharCode(...der)), publicKey: pair.publicKey };
}

// A browser: its ECDH key pair and auth secret, as a subscription.
async function browser(endpoint = 'https://fcm.googleapis.com/fcm/send/abc123') {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const p256dh = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { pair, subscription: { endpoint, keys: { p256dh: b64url(p256dh), auth: b64url(auth) } } };
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}
const te = (s: string) => new TextEncoder().encode(s);
const cat = (...p: Uint8Array[]) => {
  const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
  let i = 0;
  for (const x of p) (o.set(x, i), (i += x.length));
  return o;
};

// What the browser does (RFC 8291): the record decrypted with its own key.
async function decrypt(b: Awaited<ReturnType<typeof browser>>, body: Uint8Array): Promise<string> {
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const cipher = body.slice(21 + idlen);
  const asKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey, $public: asKey } as any, b.pair.privateKey, 256));
  const uaPublic = fromB64url(b.subscription.keys.p256dh);
  const ikm = await hkdf(fromB64url(b.subscription.keys.auth), secret, cat(te('WebPush: info\0'), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, te('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, te('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, aes, cipher));
  expect(plain.at(-1)).toBe(2);
  return new TextDecoder().decode(plain.slice(0, -1));
}

// --- the push service, stubbed ---

let pushed: { endpoint: string; headers: Record<string, string>; body: Uint8Array }[] = [];
let pushStatus = 201;
let sms: string[] = [];
function stubServices() {
  pushed = [];
  sms = [];
  pushStatus = 201;
  const realFetch = globalThis.fetch;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
    const request = new Request(input, init);
    const host = new URL(request.url).hostname;
    if (host === 'fcm.googleapis.com' || host.endsWith('push.apple.com')) {
      pushed.push({ endpoint: request.url, headers: Object.fromEntries(request.headers), body: new Uint8Array(await request.arrayBuffer()) });
      return new Response(null, { status: pushStatus });
    }
    if (host === 'api.twilio.com') {
      sms.push(new URLSearchParams(await request.text()).get('Body')!);
      return Response.json({ sid: 'SM1' }, { status: 201 });
    }
    return realFetch(input, init);
  });
}
afterEach(() => vi.restoreAllMocks());

const SMS = { MESSAGING_CONFIG: JSON.stringify({ provider: 'twilio', accountSid: 'AC1', authToken: 's', sender: 'KABOUTERS', countries: ['+32'], dailyCap: 300 }) };

// A venue: Frieten (Keuken), Pils (Bar); an event with one ordering mode on the QR.
async function venue(org: TestOrg, env: Record<string, string>) {
  const admin = async (method: string, path: string, body?: unknown) => {
    const res = await apiWith(env, method, `/organizations/${org.orgId}${path}`, { user: org.admin, body });
    if (res.status >= 300) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  };
  const kitchen = await admin('POST', '/catalog/stations', { name: 'Keuken' });
  const bar = await admin('POST', '/catalog/stations', { name: 'Bar' });
  const catalog = await admin('POST', '/catalogs', { name: 'Fuif' });
  const section = await admin('POST', `/catalogs/${catalog.id}/sections`, { name: 'Alles' });
  const add = async (name: string, priceCents: number, prepStationId: string) => {
    const product = await admin('POST', '/catalog/products', { name, prepStationId, variants: [{ name: '', code: name.toLowerCase() }] });
    await admin('POST', `/catalogs/${catalog.id}/entries`, { sectionId: section.id, variantId: product.variants[0].id, priceCents });
    return product.variants[0].id as string;
  };
  const frieten = await add('Frieten', 400, kitchen.id);
  const pils = await add('Pils', 250, bar.id);
  const event = await admin('POST', '/events', { name: 'Fuif', date: '2026-10-11' });
  const withMode = await admin('POST', `/events/${event.id}/modes`, { name: 'Take away', catalogId: catalog.id });
  const on = await admin('PATCH', `/events/${event.id}`, { selfOrderEnabled: true });
  return { admin, kitchen, bar, event, frieten, pils, modeId: withMode.modes[0].id as string, code: on.selfOrder.code as string };
}

const pub = (env: Record<string, string>, method: string, path: string, body?: unknown) => apiWith(env, method, `/public${path}`, { body });

async function placeAndPay(org: TestOrg, env: Record<string, string>, v: Awaited<ReturnType<typeof venue>>) {
  const placed = (await pub(env, 'POST', `/self-order/${v.code}/orders`, { lines: [{ variantId: v.frieten, quantity: 1 }, { variantId: v.pils, quantity: 1 }] })).body;
  const tabId = (await rows<{ id: string }>('SELECT id FROM tabs WHERE order_token = ?', placed.token))[0].id;
  await payCash(org, tabId, 650);
  return { ...placed, tabId };
}

async function ticketOf(org: TestOrg, env: Record<string, string>, stationId: string, number: number) {
  const list = (await apiWith(env, 'GET', `/organizations/${org.orgId}/stations/${stationId}/tickets`, { user: org.cashier })).body;
  return list.find((t: any) => t.number === number);
}
const ready = (org: TestOrg, env: Record<string, string>, id: string) => apiWith(env, 'POST', `/organizations/${org.orgId}/tickets/${id}`, { user: org.cashier, body: { status: 'ready' } });

async function settled(ticketId: string, column: 'push_status' | 'sms_status') {
  let status: string | null = null;
  for (let i = 0; i < 100; i++) {
    status = (await rows<any>(`SELECT ${column} AS s FROM prep_tickets WHERE id = ?`, ticketId))[0].s;
    if (status !== null && status !== 'sending') return status;
    await new Promise((r) => setTimeout(r, 10));
  }
  return status;
}

describe('the message itself', () => {
  it('encrypts so that only the browser can read it (RFC 8291)', async () => {
    const b = await browser();
    const body = await encryptPayload(b.subscription, te('{"hello":"world"}'));
    expect(new DataView(body.buffer).getUint32(16)).toBe(4096);
    expect(await decrypt(b, body)).toBe('{"hello":"world"}');
  });

  it('only a push service address, with proper keys', async () => {
    const b = await browser();
    expect(parseSubscription(b.subscription)).toEqual(b.subscription);
    expect(parseSubscription({ ...b.subscription, endpoint: 'https://web.push.apple.com/QAbc' })).not.toBeNull();
    expect(parseSubscription({ ...b.subscription, endpoint: 'https://evil.example/hook' })).toBeNull();
    expect(parseSubscription({ ...b.subscription, endpoint: 'http://fcm.googleapis.com/x' })).toBeNull();
    expect(parseSubscription({ ...b.subscription, keys: { p256dh: 'abc', auth: b.subscription.keys.auth } })).toBeNull();
    expect(parseSubscription(null)).toBeNull();
  });
});

describe('Web Push when a station is ready', () => {
  it('not offered without the installation key', async () => {
    const org = await seedOrg();
    const v = await venue(org, {});
    const placed = (await pub({}, 'POST', `/self-order/${v.code}/orders`, { lines: [{ variantId: v.frieten, quantity: 1 }] })).body;
    expect((await pub({}, 'GET', `/orders/${placed.token}`)).body.push).toBeNull();
    expect((await pub({}, 'POST', `/orders/${placed.token}/push`, { subscription: (await browser()).subscription })).body.code).toBe('push_unavailable');
  });

  it('subscribe on the order page; one notification per station, signed and encrypted; then no SMS', async () => {
    stubServices();
    const key = await vapidKey();
    const env = { WEB_PUSH_KEY: key.secret, ...SMS };
    const org = await seedOrg();
    const v = await venue(org, env);
    await v.admin('PATCH', `/events/${v.event.id}/modes/${v.modeId}`, { notifySms: true });
    const order = await placeAndPay(org, env, v);
    const page = (await pub(env, 'GET', `/orders/${order.token}`)).body;
    const raw = new Uint8Array((await crypto.subtle.exportKey('raw', key.publicKey)) as ArrayBuffer);
    expect(page.push).toEqual({ publicKey: b64url(raw), available: true, subscribed: false });

    // A number too: the push wins, no SMS.
    await pub(env, 'POST', `/orders/${order.token}/notify`, { phone: '0470123456' });
    expect((await pub(env, 'POST', `/orders/${order.token}/push`, { subscription: { endpoint: 'https://evil.example/x', keys: {} } })).body.code).toBe('push_subscription_invalid');
    const b = await browser();
    expect((await pub(env, 'POST', `/orders/${order.token}/push`, { subscription: b.subscription })).body).toEqual({ ok: true });
    expect((await pub(env, 'GET', `/orders/${order.token}`)).body.push.subscribed).toBe(true);

    const kitchen = await ticketOf(org, env, v.kitchen.id, order.number);
    await ready(org, env, kitchen.id);
    expect(await settled(kitchen.id, 'push_status')).toBe('sent');
    expect(pushed).toHaveLength(1);
    const msg = JSON.parse(await decrypt(b, pushed[0].body));
    expect(msg).toEqual({ title: 'Test org', body: `Je bestelling #${order.number} is klaar - Keuken.`, url: `/volg/${order.token}`, tag: kitchen.id });
    expect(pushed[0].headers).toMatchObject({ 'content-encoding': 'aes128gcm', ttl: '3600', urgency: 'high' });

    // VAPID: a JWT for the push service's origin, signed with the installation's key.
    const [, t, k] = pushed[0].headers.authorization.match(/^vapid t=([^,]+), k=(.+)$/)!;
    expect(k).toBe(b64url(raw));
    const [h, c, sig] = t.split('.');
    const claims = JSON.parse(new TextDecoder().decode(fromB64url(c)));
    expect(claims.aud).toBe('https://fcm.googleapis.com');
    expect(claims.sub).toMatch(/^(mailto:|https:)/);
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key.publicKey, fromB64url(sig), te(`${h}.${c}`))).toBe(true);

    const bar = await ticketOf(org, env, v.bar.id, order.number);
    await ready(org, env, bar.id);
    expect(await settled(bar.id, 'push_status')).toBe('sent');
    expect(pushed).toHaveLength(2);
    await new Promise((r) => setTimeout(r, 50));
    expect(sms).toEqual([]);
    // Every station ready: the browser and the number are forgotten.
    expect(await rows<any>('SELECT push_subscription, notify_phone FROM tabs WHERE id = ?', order.tabId)).toEqual([{ push_subscription: null, notify_phone: null }]);
  });

  it('a browser that unsubscribed: forgotten, and the SMS goes after all', async () => {
    stubServices();
    const env = { WEB_PUSH_KEY: (await vapidKey()).secret, ...SMS };
    const org = await seedOrg();
    const v = await venue(org, env);
    await v.admin('PATCH', `/events/${v.event.id}/modes/${v.modeId}`, { notifySms: true });
    const order = await placeAndPay(org, env, v);
    await pub(env, 'POST', `/orders/${order.token}/notify`, { phone: '0470123456' });
    await pub(env, 'POST', `/orders/${order.token}/push`, { subscription: (await browser()).subscription });
    pushStatus = 410;
    const kitchen = await ticketOf(org, env, v.kitchen.id, order.number);
    await ready(org, env, kitchen.id);
    expect(await settled(kitchen.id, 'push_status')).toBe('failed');
    expect(await settled(kitchen.id, 'sms_status')).toBe('sent');
    expect(sms).toEqual([`Test org: je bestelling #${order.number} is klaar - Keuken.`]);
    expect((await rows<any>('SELECT push_subscription FROM tabs WHERE id = ?', order.tabId))[0].push_subscription).toBeNull();
  });

  it('turned off again on the order page', async () => {
    const env = { WEB_PUSH_KEY: (await vapidKey()).secret };
    const org = await seedOrg();
    const v = await venue(org, env);
    const order = await placeAndPay(org, env, v);
    await pub(env, 'POST', `/orders/${order.token}/push`, { subscription: (await browser()).subscription });
    expect((await pub(env, 'DELETE', `/orders/${order.token}/push`)).body).toEqual({ ok: true });
    expect((await pub(env, 'GET', `/orders/${order.token}`)).body.push.subscribed).toBe(false);
  });
});
