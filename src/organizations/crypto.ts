// Envelope encryption for organization secrets (IdP client secrets, payment
// provider credentials). Each organization gets its own random AES-256 data
// key (DEK), generated once at org-creation time; the DEK itself is stored
// only ever "wrapped" (encrypted) under the platform-wide ENCRYPTION_KEY
// secret — never in the clear, and never anywhere but the org's own row.
//
// Why per-org instead of one platform-wide key for everything: rotating or
// revoking one organization's key touches only that organization's row, not
// a platform-wide re-encryption migration. It does NOT protect against a
// fully compromised running Worker or a leaked ENCRYPTION_KEY — that would
// still allow unwrapping any org's DEK. What it buys you is isolated
// blast-radius and rotation between tenants, which is the actual risk that
// matters as this grows into a multi-org platform.
//
// One primitive (AES-GCM encrypt/decrypt) serves both roles: wrapping a DEK
// under the platform key, and encrypting an actual secret under an org's DEK
// — "encrypting a key" is just "encrypting bytes."

export interface EncryptedValue {
  ciphertext: string;
  iv: string;
}

async function importKey(keyB64: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(keyB64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export async function encryptWithKey(plaintext: string, keyB64: string): Promise<EncryptedValue> {
  const key = await importKey(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  return { ciphertext: toBase64(new Uint8Array(ciphertext)), iv: toBase64(iv) };
}

export async function decryptWithKey(value: EncryptedValue, keyB64: string): Promise<string> {
  const key = await importKey(keyB64);
  const iv = fromBase64(value.iv);
  const ciphertext = fromBase64(value.ciphertext);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return new TextDecoder().decode(plain);
}

// --- Per-organization data keys (DEKs) ---

export function generateDataKey(): string {
  const raw = crypto.getRandomValues(new Uint8Array(32)); // AES-256
  return toBase64(raw);
}

export async function wrapDataKey(dekB64: string, platformKeyB64: string): Promise<EncryptedValue> {
  return encryptWithKey(dekB64, platformKeyB64);
}

export async function unwrapDataKey(wrapped: EncryptedValue, platformKeyB64: string): Promise<string> {
  return decryptWithKey(wrapped, platformKeyB64);
}
