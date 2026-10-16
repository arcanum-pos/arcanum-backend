// Device keys — DOMAIN_MODEL.md "Devices: control plane and data plane"
// (decided 2026-10-12). A station screen or a customer display needs no
// person: it's paired with its pairing code alone (devices.ts publicPair)
// and gets its own key. arcanum-bff keeps it in the browser as an HttpOnly
// cookie and passes it on as X-Device-Key — only when no person is signed in
// (it clears any X-Device-Key a client sent).
//
// A key is accepted in exactly these places, each checking it's the
// device's own:
//   station  GET  /organizations/:org/devices/:self
//            GET  /organizations/:org/stations/:its station/tickets
//            POST /organizations/:org/tickets/:id   (a ticket of its station)
//   cfd      GET  /organizations/:org/devices/:self
//            GET  /sumup/status/:charge             (a charge of its linked kassa)
//   tap      GET  /organizations/:org/devices/:self
//            GET  /organizations/:org/devices/:self/tap     (its kassa's Tap to Pay payment)
//            POST/DELETE /organizations/:org/devices/:self/push
//   all      GET  /organizations/device-ws-token?terminal_id=:self
// Everywhere else it's as if nobody were signed in. Valid until the device
// is removed in the console (revokeDeviceKeys). Only its SHA-256 is stored.
import type { Env } from './env';

export type DeviceRole = 'station' | 'cfd' | 'tap';

export interface DeviceCaller {
  terminalId: string;
  orgId: string;
  role: DeviceRole;
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 256 bits, base64url.
export async function createDeviceKey(env: Env, d: DeviceCaller): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const key = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  await env.DB.prepare('INSERT INTO device_keys (key_hash, terminal_id, org_id, role, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(await sha256(key), d.terminalId, d.orgId, d.role, new Date().toISOString())
    .run();
  return key;
}

// The device behind the request's key — null without one, or a revoked one.
export async function deviceCaller(request: Request, env: Env): Promise<DeviceCaller | null> {
  const key = request.headers.get('X-Device-Key');
  if (!key || key.length < 20 || key.length > 100) return null;
  const row = await env.DB.prepare('SELECT terminal_id, org_id, role FROM device_keys WHERE key_hash = ? AND revoked_at IS NULL')
    .bind(await sha256(key))
    .first<{ terminal_id: string; org_id: string; role: DeviceRole }>();
  return row ? { terminalId: row.terminal_id, orgId: row.org_id, role: row.role } : null;
}

export function revokeDeviceKeys(env: Env, terminalId: string): D1PreparedStatement {
  return env.DB.prepare('UPDATE device_keys SET revoked_at = ? WHERE terminal_id = ? AND revoked_at IS NULL').bind(new Date().toISOString(), terminalId);
}
