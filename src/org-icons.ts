// An organisation's own app icons — console → Instellingen → Weergave →
// App-iconen (2026-10-18). What a phone, tablet or computer shows for one
// of the org's screens installed as an app (and in the browser tab), per
// page — `slot` — and for a station screen per prep station. Not set: the
// default icon (arcanum-frontends' public/icons/, served by arcanum-bff).
//
//   GET    /organizations/:org/icons                 member  [{ slot, updatedAt }] — the slots that have one
//   PUT    /organizations/:org/icons/:slot           admin   { png: { 96, 180, 192, 512 } } (base64 PNGs, those sizes)
//   DELETE /organizations/:org/icons/:slot           admin   back to the default
//   GET    /public/icons/:org/:slot/:size            nobody  the PNG — a prep station without one of its
//                                                            own: the org's station icon; neither: 404
//
// The browser makes the sizes (a canvas) — a Worker can't resize images.
// Each PNG is checked: the signature, and the width and height it claims.
import type { Env } from './env';
import { codedError, errorJson } from './errors';
import { json } from './http';
import { extractCaller, requireOrgRole } from './organizations/auth';

export const ICON_SIZES = [96, 180, 192, 512] as const;
// The pages that can be installed as an app, per organisation. A prep
// station's: station-<its id>.
export const ICON_SLOTS = new Set(['kassa', 'display', 'station', 'pickup', 'entrance', 'tap', 'waiter', 'selforder']);
const STATION_SLOT = /^station-([A-Za-z0-9_-]{1,64})$/;
// A 512 px icon, a photo even, stays well under this.
const MAX_PNG_BYTES = 1_000_000;

function fromBase64(text: string): Uint8Array | null {
  try {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

// The PNG's own width × height (its IHDR chunk), or null when it isn't one.
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || signature.some((b, i) => bytes[i] !== b)) return null;
  if (String.fromCharCode(...bytes.slice(12, 16)) !== 'IHDR') return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

async function validSlot(env: Env, orgId: string, slot: string): Promise<boolean> {
  if (ICON_SLOTS.has(slot)) return true;
  const station = slot.match(STATION_SLOT);
  return !!station && !!(await env.DB.prepare('SELECT 1 FROM prep_stations WHERE id = ? AND org_id = ?').bind(station[1], orgId).first());
}

async function member(request: Request, env: Env, orgId: string, roles: ('admin' | 'cashier')[]): Promise<Response | null> {
  const caller = extractCaller(request);
  if (!caller) return json({ error: 'Unauthorized' }, 401);
  if (!(await requireOrgRole(env, orgId, caller, roles))) return json({ error: 'Forbidden' }, 403);
  return null;
}

async function listIcons(request: Request, env: Env, orgId: string): Promise<Response> {
  const refused = await member(request, env, orgId, ['admin', 'cashier']);
  if (refused) return refused;
  const { results } = await env.DB.prepare('SELECT slot, MAX(updated_at) AS updated_at FROM org_icons WHERE org_id = ? GROUP BY slot ORDER BY slot')
    .bind(orgId)
    .all<{ slot: string; updated_at: string }>();
  return json((results || []).map((r) => ({ slot: r.slot, updatedAt: r.updated_at })));
}

async function setIcon(request: Request, env: Env, orgId: string, slot: string): Promise<Response> {
  const refused = await member(request, env, orgId, ['admin']);
  if (refused) return refused;
  if (!(await validSlot(env, orgId, slot))) return errorJson('icon_slot_unknown', 404);
  const body = (await request.json().catch(() => null)) as { png?: Record<string, unknown> } | null;
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  for (const size of ICON_SIZES) {
    const text = body?.png?.[size];
    const bytes = typeof text === 'string' && text.length <= (MAX_PNG_BYTES * 4) / 3 + 4 ? fromBase64(text) : null;
    const dims = bytes ? pngSize(bytes) : null;
    if (!bytes || bytes.length > MAX_PNG_BYTES || !dims || dims.width !== size || dims.height !== size) return errorJson(codedError('icon_invalid', { size }), 400);
    statements.push(
      env.DB.prepare('INSERT OR REPLACE INTO org_icons (org_id, slot, size, png, updated_at) VALUES (?, ?, ?, ?, ?)').bind(orgId, slot, size, text as string, now)
    );
  }
  await env.DB.batch(statements);
  return json({ slot, updatedAt: now });
}

async function removeIcon(request: Request, env: Env, orgId: string, slot: string): Promise<Response> {
  const refused = await member(request, env, orgId, ['admin']);
  if (refused) return refused;
  await env.DB.prepare('DELETE FROM org_icons WHERE org_id = ? AND slot = ?').bind(orgId, slot).run();
  return json({ ok: true });
}

// The PNG for a page — nothing secret: it's on people's home screens. A
// prep station without its own: the org's station icon.
async function publicIcon(env: Env, orgId: string, slot: string, size: number): Promise<Response> {
  if (!ICON_SIZES.includes(size as (typeof ICON_SIZES)[number])) return json({ error: 'Not found' }, 404);
  const slots = STATION_SLOT.test(slot) ? [slot, 'station'] : [slot];
  for (const s of slots) {
    const row = await env.DB.prepare('SELECT png, updated_at FROM org_icons WHERE org_id = ? AND slot = ? AND size = ?').bind(orgId, s, size).first<{ png: string; updated_at: string }>();
    const bytes = row ? fromBase64(row.png) : null;
    if (bytes) {
      return new Response(bytes, {
        headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=300', 'Last-Modified': new Date(row!.updated_at).toUTCString() },
      });
    }
  }
  return json({ error: 'Not found' }, 404);
}

export async function dispatchPublicIconRoute(request: Request, env: Env, pathname: string): Promise<Response | null> {
  const match = pathname.match(/^\/public\/icons\/([^/]+)\/([^/]+)\/(\d+)$/);
  if (!match || request.method !== 'GET') return null;
  return publicIcon(env, decodeURIComponent(match[1]), decodeURIComponent(match[2]), Number(match[3]));
}

export async function dispatchOrgIconRoute(request: Request, env: Env, pathname: string): Promise<Response | null> {
  let match = pathname.match(/^\/organizations\/([^/]+)\/icons$/);
  if (match) return request.method === 'GET' ? listIcons(request, env, match[1]) : null;
  match = pathname.match(/^\/organizations\/([^/]+)\/icons\/([^/]+)$/);
  if (!match) return null;
  const slot = decodeURIComponent(match[2]);
  if (request.method === 'PUT') return setIcon(request, env, match[1], slot);
  if (request.method === 'DELETE') return removeIcon(request, env, match[1], slot);
  return null;
}
