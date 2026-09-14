// Verifies Bancontact's callback signature — a detached JWS (RFC 7797),
// ES256, key resolved by `kid` against Bancontact's own JWKS endpoint
// (https://docs.bancontactpro.com — callback guide, 2026-09). The x5t#S256
// certificate-thumbprint cross-check documented alongside this is NOT
// implemented here: kid-matched signature verification against a JWKS
// fetched fresh over HTTPS from Bancontact's own domain already gives the
// core guarantee (only Bancontact could have produced a valid signature for
// a key it itself publishes) — revisit if that's ever judged insufficient.
interface Jwk {
  kid: string;
  kty: string;
  crv?: string;
  x?: string;
  y?: string;
}

interface Jwks {
  keys: Jwk[];
}

const JWKS_URLS: Record<'preprod' | 'prod', string> = {
  preprod: 'https://jwks.preprod.bancontact.net/',
  prod: 'https://jwks.bancontact.net/',
};

// Cheap in-memory cache, scoped to the Worker isolate's lifetime — JWKS
// rotate rarely, a cold start just re-fetches.
const jwksCache = new Map<string, { fetchedAt: number; jwks: Jwks }>();
const JWKS_CACHE_TTL_MS = 60 * 60 * 1000;

async function fetchJwks(environment: 'preprod' | 'prod'): Promise<Jwks> {
  const response = await fetch(JWKS_URLS[environment]);
  if (!response.ok) throw new Error(`Kon Bancontact JWKS niet ophalen (${response.status})`);
  return (await response.json()) as Jwks;
}

async function getJwks(environment: 'preprod' | 'prod'): Promise<Jwks> {
  const cached = jwksCache.get(environment);
  if (cached && Date.now() - cached.fetchedAt < JWKS_CACHE_TTL_MS) return cached.jwks;

  const jwks = await fetchJwks(environment);
  jwksCache.set(environment, { fetchedAt: Date.now(), jwks });
  return jwks;
}

function base64UrlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(b64url.length / 4) * 4, '=');
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// `signatureHeader` is the raw value of the `Signature` request header:
// "<base64url(JOSE header)>..<base64url(signature)>" (RFC 7797 detached
// form — the middle payload segment is omitted). `rawBody` must be the
// exact bytes Bancontact sent, captured with request.text() before any
// JSON.parse — re-serializing could change byte-for-byte content and break
// verification.
export async function verifyBancontactCallback(
  signatureHeader: string,
  rawBody: string,
  environment: 'preprod' | 'prod'
): Promise<boolean> {
  const match = signatureHeader.match(/^([^.]+)\.\.([^.]+)$/);
  if (!match) return false;
  const [, headerB64, signatureB64] = match;

  let header: { kid?: string; alg?: string };
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlToBytes(headerB64)));
  } catch {
    return false;
  }
  if (header.alg !== 'ES256' || !header.kid) return false;

  let jwks = await getJwks(environment);
  let jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    // Key rotated since our last fetch — re-fetch once, bypassing the cache.
    jwks = await fetchJwks(environment);
    jwksCache.set(environment, { fetchedAt: Date.now(), jwks });
    jwk = jwks.keys.find((k) => k.kid === header!.kid);
  }
  if (!jwk || jwk.kty !== 'EC' || !jwk.x || !jwk.y) return false;

  const publicKey = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, crv: jwk.crv || 'P-256', x: jwk.x, y: jwk.y, ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify']
  );

  const signingInput = `${headerB64}.${base64UrlEncode(new TextEncoder().encode(rawBody))}`;

  // WebCrypto ECDSA verify expects raw (r||s) signature bytes — JWS ES256
  // signatures are already in that format (RFC 7518 §3.4), not ASN.1 DER.
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    publicKey,
    base64UrlToBytes(signatureB64),
    new TextEncoder().encode(signingInput)
  );
}
