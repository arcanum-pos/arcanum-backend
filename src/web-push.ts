// Web Push (ROADMAP §8b, release G'): "your order is ready" on a guest's
// locked phone, one notification per station — sent next to (instead of)
// the SMS in messaging.ts. No library: the message encryption (RFC 8291,
// aes128gcm) and the VAPID signature (RFC 8292) with the Workers' own crypto.
//
// The key pair is the installation's: WEB_PUSH_KEY, a P-256 private key
// (PKCS#8, base64) the installer generates once. Its public half is what a
// browser subscribes with. Without it, Web Push is simply not offered.
import type { Env } from './env';
import { installationMailProvider } from './organizations/mail';

export interface PushSubscriptionJson {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

// Only the browsers' own push services — never an arbitrary address the
// guest's page could hand us.
const PUSH_HOSTS = ['fcm.googleapis.com', 'push.apple.com', 'push.services.mozilla.com', 'notify.windows.com', 'push.api.chromecast.com'];

export function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(text: string): Uint8Array {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
}

const text = (s: string) => new TextEncoder().encode(s);

// A subscription as the browser gives it (PushSubscription.toJSON()), checked.
export function parseSubscription(raw: unknown): PushSubscriptionJson | null {
  const r = raw as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
  if (!r || typeof r.endpoint !== 'string' || typeof r.keys?.p256dh !== 'string' || typeof r.keys?.auth !== 'string') return null;
  let url: URL;
  try {
    url = new URL(r.endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || r.endpoint.length > 1000) return null;
  if (!PUSH_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`))) return null;
  try {
    if (fromB64url(r.keys.p256dh).length !== 65 || fromB64url(r.keys.auth).length !== 16) return null;
  } catch {
    return null;
  }
  return { endpoint: r.endpoint, keys: { p256dh: r.keys.p256dh, auth: r.keys.auth } };
}

interface Vapid {
  privateKey: CryptoKey;
  publicKey: string; // base64url of the raw (65-byte) point: the browser's applicationServerKey
}

let cached: { source: string; vapid: Promise<Vapid> } | null = null;

async function loadVapid(source: string): Promise<Vapid> {
  const der = Uint8Array.from(atob(source), (c) => c.charCodeAt(0));
  const privateKey = await crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  const jwk = (await crypto.subtle.exportKey('jwk', privateKey)) as JsonWebKey;
  const publicKey = b64url(concat(new Uint8Array([4]), fromB64url(jwk.x!), fromB64url(jwk.y!)));
  return { privateKey, publicKey };
}

function vapidOf(env: Env): Promise<Vapid> | null {
  if (!env.WEB_PUSH_KEY) return null;
  if (cached?.source !== env.WEB_PUSH_KEY) cached = { source: env.WEB_PUSH_KEY, vapid: loadVapid(env.WEB_PUSH_KEY) };
  return cached.vapid;
}

// The key a browser subscribes with; null: no Web Push on this installation
// (or a key that doesn't load — then it's simply not offered).
export async function webPushPublicKey(env: Env): Promise<string | null> {
  try {
    return (await vapidOf(env))?.publicKey ?? null;
  } catch (err) {
    console.error('WEB_PUSH_KEY laadt niet', err);
    return null;
  }
}

// Who to contact about these pushes (RFC 8292 "sub"): the installation's
// mail sender, else its own address.
function subject(env: Env): string {
  try {
    const from = installationMailProvider(env)?.fromAddress;
    if (typeof from === 'string' && from.includes('@')) return `mailto:${from}`;
  } catch {
    // no usable mail settings
  }
  return env.PUBLIC_BASE_URL;
}

async function vapidHeader(env: Env, vapid: Vapid, endpoint: string): Promise<string> {
  const header = b64url(text(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(text(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject(env) })));
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, vapid.privateKey, text(`${header}.${claims}`)));
  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${vapid.publicKey}`;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

// RFC 8291: the payload encrypted for this subscription, as one aes128gcm record.
export async function encryptPayload(subscription: PushSubscriptionJson, payload: Uint8Array, salt = crypto.getRandomValues(new Uint8Array(16))): Promise<Uint8Array> {
  const uaPublic = fromB64url(subscription.keys.p256dh);
  const authSecret = fromB64url(subscription.keys.auth);
  const local = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const asPublic = new Uint8Array((await crypto.subtle.exportKey('raw', local.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', $public: uaKey, public: uaKey } as SubtleCryptoDeriveKeyAlgorithm, local.privateKey, 256));
  const ikm = await hkdf(authSecret, ecdhSecret, concat(text('WebPush: info\0'), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, text('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, text('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // The last (only) record: the payload, then the delimiter 0x02, no padding.
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concat(payload, new Uint8Array([2]))));
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

export interface PushMessage {
  title: string;
  body: string;
  url: string;
  tag: string;
}

// ok, or gone (the browser unsubscribed: forget it), or another failure.
export type PushResult = { ok: true } | { ok: false; gone: boolean; error: string };

export async function sendPush(env: Env, subscription: PushSubscriptionJson, message: PushMessage): Promise<PushResult> {
  const vapid = await vapidOf(env);
  if (!vapid) return { ok: false, gone: false, error: 'no WEB_PUSH_KEY' };
  const body = await encryptPayload(subscription, text(JSON.stringify(message)));
  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidHeader(env, vapid, subscription.endpoint),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '3600',
      Urgency: 'high',
    },
    body,
  });
  if (res.ok) return { ok: true };
  const detail = (await res.text().catch(() => '')).slice(0, 150);
  return { ok: false, gone: res.status === 404 || res.status === 410, error: `${res.status} ${detail}`.trim() };
}
