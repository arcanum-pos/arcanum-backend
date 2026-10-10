// Devices — kassa's and customer displays — and how they're paired
// (DOMAIN_MODEL.md "Devices: control plane and data plane").
//
// arcanum-devicehub keeps the registry (and the live sockets) but knows
// nothing about people: every device action of a browser comes here, is
// checked against the caller's membership, and only then goes to devicehub
// over the service binding (INTERNAL_API_KEY).
//
//   POST   /organizations/:org/device-pairings          admin   { role, name, linkTo? } → { id, code, role, name, expiresAt }
//                                                               (linkTo: a kassa, for a customer display — linked on claim)
//   GET    /organizations/:org/device-pairings          admin   the last day's codes and what became of them
//   DELETE /organizations/:org/device-pairings/:id      admin   revoke an open code
//   POST   /organizations/device-pairings/claim         member of the code's org   { code } → the device (+ org name, language)
//
//   GET    /organizations/:org/devices                  member  the registry (+ names, presence)
//   GET    /organizations/:org/devices/:id              member  one device — a kassa checks itself on load
//   PATCH  /organizations/:org/devices/:id              member  { name }
//   DELETE /organizations/:org/devices/:id              admin   unpair / remove
//   POST   /organizations/:org/devices/:pos/display     member  a customer display in a second window of this kassa
//   GET    /organizations/:org/devices/:pos/linked      member  its linked customer display
//   GET    /organizations/:org/devices/:pos/linkable    member  customer displays of the org, unlinked and online
//   POST   /organizations/:org/devices/:pos/link        member  { terminalId }
//   POST   /organizations/:org/devices/:id/unlink       member
//   POST   /organizations/:org/devices/:pos/reset       member  tell the kassa and its display to start over
//
// A pairing code: 8 characters from an alphabet without look-alikes,
// shown as XXXX-XXXX; single use, valid 10 minutes, only its SHA-256 is
// stored. A wrong code gets one answer whatever the reason (unknown,
// expired, used, revoked); 10 wrong ones in 10 minutes and the person waits.
import type { Env } from './env';
import { callDeviceHub } from './devicehub-client';
import { errorJson } from './errors';
import { json } from './http';
import { extractCaller, requireOrgRole } from './organizations/auth';
import type { CallerIdentity } from './organizations/types';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
const CODE_LENGTH = 8;
const CODE_MINUTES = 10;
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MINUTES = 10;
const KEEP_DAYS = 30;
const MAX_NAME = 60;
const ROLES = new Set(['pos', 'cfd']);

type Role = 'pos' | 'cfd';

interface PairingRow {
  id: string;
  org_id: string;
  role: Role;
  name: string;
  created_by: string;
  created_at: string;
  expires_at: string;
  claimed_at: string | null;
  claimed_by: string | null;
  terminal_id: string | null;
  revoked_at: string | null;
  // A customer display's kassa: linked to it as soon as it's paired.
  link_to: string | null;
}

interface DeviceRow {
  terminal_id: string;
  org_id: string | null;
  role: string;
  linked_to: string | null;
  name?: string | null;
}

function newCode(): string {
  // Rejection sampling: 248 = 8 × 31, so every character is equally likely.
  let code = '';
  while (code.length < CODE_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      if (byte < 248 && code.length < CODE_LENGTH) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
    }
  }
  return code;
}

// As typed: case, spaces and dashes don't matter.
export const normalizeCode = (input: string) => input.toUpperCase().replace(/[\s-]/g, '');
const shownCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const who = (caller: CallerIdentity) => caller.name || caller.email || caller.sub;

function pairingStatus(row: PairingRow, now = Date.now()): 'open' | 'claimed' | 'revoked' | 'expired' {
  if (row.claimed_at) return 'claimed';
  if (row.revoked_at) return 'revoked';
  return Date.parse(row.expires_at) <= now ? 'expired' : 'open';
}

function pairingJson(row: PairingRow) {
  return {
    id: row.id,
    role: row.role,
    name: row.name,
    status: pairingStatus(row),
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    claimedAt: row.claimed_at,
    claimedBy: row.claimed_by,
    terminalId: row.terminal_id,
    linkTo: row.link_to,
  };
}

async function devicehub(env: Env, path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const res = await callDeviceHub(env, path, init);
  return { status: res.status, body: await res.json().catch(() => null) };
}

// The device, if it's one of this org's; null otherwise (unknown, or another org's).
async function orgDevice(env: Env, orgId: string, terminalId: string): Promise<DeviceRow | null> {
  const { status, body } = await devicehub(env, `/devices/${encodeURIComponent(terminalId)}`);
  return status === 200 && body?.org_id === orgId ? (body as DeviceRow) : null;
}

async function memberOf(request: Request, env: Env, orgId: string, roles: ('admin' | 'cashier')[]): Promise<CallerIdentity | Response> {
  const caller = extractCaller(request);
  if (!caller) return json({ error: 'Unauthorized' }, 401);
  if (!(await requireOrgRole(env, orgId, caller, roles))) return json({ error: 'Forbidden' }, 403);
  return caller;
}

const MEMBER: ('admin' | 'cashier')[] = ['admin', 'cashier'];
const ADMIN: ('admin' | 'cashier')[] = ['admin'];

// A kassa's own customer display (a second window on the same device).
export const companionDisplayId = (posId: string) => `display-of-${posId}`;
const COMPANION_SUFFIX: Record<string, string> = { nl: 'klantscherm', fr: 'écran client', en: 'customer display' };
const COMPANION_KASSA: Record<string, string> = { nl: 'Kassa', fr: 'Caisse', en: 'Till' };

// --- Pairing codes ---

async function createPairing(request: Request, env: Env, orgId: string): Promise<Response> {
  const caller = await memberOf(request, env, orgId, ADMIN);
  if (caller instanceof Response) return caller;
  const body = (await request.json().catch(() => null)) as { role?: unknown; name?: unknown; linkTo?: unknown } | null;
  const role = String(body?.role ?? '');
  if (!ROLES.has(role)) return json({ error: "role must be 'pos' or 'cfd'" }, 400);
  const name = (typeof body?.name === 'string' ? body.name.trim() : '').slice(0, MAX_NAME);
  if (!name) return errorJson('device_name_required', 400);
  // A customer display can be meant for one kassa of this org right away.
  const linkTo = role === 'cfd' && typeof body?.linkTo === 'string' && body.linkTo ? body.linkTo : null;
  if (linkTo) {
    const pos = await orgDevice(env, orgId, linkTo);
    if (!pos || pos.role !== 'pos') return errorJson('device_not_found', 404);
  }

  const { row, code } = await issuePairingCode(env, orgId, role as Role, name, who(caller), linkTo);
  return json({ ...pairingJson(row), code }, 201);
}

// A new pairing code (shown form, XXXX-XXXX) — by an admin above, or by the
// system for a demo's own kassa (demo-orgs.ts), which then pairs the
// browser the demo starts in.
export async function issuePairingCode(env: Env, orgId: string, role: Role, name: string, createdBy: string, linkTo: string | null = null): Promise<{ row: PairingRow; code: string }> {
  const code = newCode();
  const now = new Date();
  const row: PairingRow = {
    id: crypto.randomUUID(),
    org_id: orgId,
    role,
    name,
    created_by: createdBy,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + CODE_MINUTES * 60_000).toISOString(),
    claimed_at: null,
    claimed_by: null,
    terminal_id: null,
    revoked_at: null,
    link_to: linkTo,
  };
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO device_pairings (id, org_id, code_hash, role, name, created_by, created_at, expires_at, link_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(row.id, orgId, await sha256(code), row.role, name, row.created_by, row.created_at, row.expires_at, linkTo),
    env.DB.prepare('DELETE FROM device_pairings WHERE created_at < ?').bind(new Date(now.getTime() - KEEP_DAYS * 86_400_000).toISOString()),
  ]);
  return { row, code: shownCode(code) };
}

async function listPairings(request: Request, env: Env, orgId: string): Promise<Response> {
  const caller = await memberOf(request, env, orgId, ADMIN);
  if (caller instanceof Response) return caller;
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const { results } = await env.DB.prepare('SELECT * FROM device_pairings WHERE org_id = ? AND created_at >= ? ORDER BY created_at DESC')
    .bind(orgId, since)
    .all<PairingRow>();
  return json((results || []).map(pairingJson));
}

async function revokePairing(request: Request, env: Env, orgId: string, id: string): Promise<Response> {
  const caller = await memberOf(request, env, orgId, ADMIN);
  if (caller instanceof Response) return caller;
  const result = await env.DB.prepare('UPDATE device_pairings SET revoked_at = ? WHERE id = ? AND org_id = ? AND claimed_at IS NULL AND revoked_at IS NULL')
    .bind(new Date().toISOString(), id, orgId)
    .run();
  if (!result.meta.changes) return json({ error: 'Not found' }, 404);
  return json({ ok: true });
}

async function claimPairing(request: Request, env: Env): Promise<Response> {
  const caller = extractCaller(request);
  if (!caller) return json({ error: 'Unauthorized' }, 401);
  const body = (await request.json().catch(() => null)) as { code?: unknown } | null;
  const code = normalizeCode(typeof body?.code === 'string' ? body.code : '');
  const callerKey = `${caller.issuer} ${caller.sub}`;
  const now = new Date();
  const windowStart = new Date(now.getTime() - FAILURE_WINDOW_MINUTES * 60_000).toISOString();

  const failures = await env.DB.prepare('SELECT COUNT(*) AS n FROM device_pairing_failures WHERE caller = ? AND at >= ?')
    .bind(callerKey, windowStart)
    .first<{ n: number }>();
  if ((failures?.n ?? 0) >= MAX_FAILURES) return errorJson('pairing_too_many_attempts', 429);

  const row =
    code.length === CODE_LENGTH
      ? await env.DB.prepare('SELECT * FROM device_pairings WHERE code_hash = ? AND claimed_at IS NULL AND revoked_at IS NULL AND expires_at > ?')
          .bind(await sha256(code), now.toISOString())
          .first<PairingRow>()
      : null;
  if (!row) {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO device_pairing_failures (caller, at) VALUES (?, ?)').bind(callerKey, now.toISOString()),
      env.DB.prepare('DELETE FROM device_pairing_failures WHERE at < ?').bind(new Date(now.getTime() - 86_400_000).toISOString()),
    ]);
    return errorJson('pairing_code_invalid', 400);
  }

  // A valid code still needs a member of its org on this device — and says
  // so, rather than "wrong code": they're signed in with the wrong account.
  if (!(await requireOrgRole(env, row.org_id, caller, MEMBER))) return errorJson('pairing_not_member', 403);

  const terminalId = crypto.randomUUID();
  const claimed = await env.DB.prepare('UPDATE device_pairings SET claimed_at = ?, claimed_by = ?, terminal_id = ? WHERE id = ? AND claimed_at IS NULL AND revoked_at IS NULL')
    .bind(now.toISOString(), who(caller), terminalId, row.id)
    .run();
  if (!claimed.meta.changes) return errorJson('pairing_code_invalid', 400);

  const registered = await devicehub(env, '/devices/register', {
    method: 'POST',
    body: JSON.stringify({ terminal_id: terminalId, org_id: row.org_id, role: row.role, name: row.name }),
  });
  if (registered.status !== 200) {
    // Give the code back: nothing was registered.
    await env.DB.prepare('UPDATE device_pairings SET claimed_at = NULL, claimed_by = NULL, terminal_id = NULL WHERE id = ?').bind(row.id).run();
    return errorJson('devicehub_failed', 502);
  }
  // A customer display meant for a kassa: linked now — if that kassa is still there.
  let linkedTo: string | null = null;
  if (row.role === 'cfd' && row.link_to && (await orgDevice(env, row.org_id, row.link_to))) {
    const previous = await devicehub(env, `/devices/${encodeURIComponent(row.link_to)}/linked?role=cfd`);
    if (previous.status === 200 && previous.body?.terminal_id) {
      await devicehub(env, '/devices/unlink', { method: 'POST', body: JSON.stringify({ terminal_id: previous.body.terminal_id }) });
    }
    const linked = await devicehub(env, '/devices/link', { method: 'POST', body: JSON.stringify({ pos_terminal_id: row.link_to, terminal_id: terminalId }) });
    if (linked.status === 200) linkedTo = row.link_to;
  }
  // The org's language too: a new device starts in it (unless one was picked on the device).
  const org = await env.DB.prepare('SELECT name, locale FROM organizations WHERE id = ?').bind(row.org_id).first<{ name: string; locale: string | null }>();
  return json({ terminalId, role: row.role, orgId: row.org_id, orgName: org?.name ?? '', orgLocale: org?.locale ?? null, name: row.name, linkedTo }, 201);
}

// --- Devices ---

async function listDevices(request: Request, env: Env, orgId: string): Promise<Response> {
  const caller = await memberOf(request, env, orgId, MEMBER);
  if (caller instanceof Response) return caller;
  const { status, body } = await devicehub(env, `/devices/by-org/${encodeURIComponent(orgId)}`);
  if (status !== 200) return errorJson('devicehub_failed', 502);
  return json(body);
}

async function getDevice(request: Request, env: Env, orgId: string, terminalId: string): Promise<Response> {
  const caller = await memberOf(request, env, orgId, MEMBER);
  if (caller instanceof Response) return caller;
  const device = await orgDevice(env, orgId, terminalId);
  return device ? json(device) : errorJson('device_not_found', 404);
}

async function renameDevice(request: Request, env: Env, orgId: string, terminalId: string): Promise<Response> {
  const caller = await memberOf(request, env, orgId, MEMBER);
  if (caller instanceof Response) return caller;
  const body = (await request.json().catch(() => null)) as { name?: unknown } | null;
  const name = (typeof body?.name === 'string' ? body.name.trim() : '').slice(0, MAX_NAME);
  if (!name) return errorJson('device_name_required', 400);
  if (!(await orgDevice(env, orgId, terminalId))) return errorJson('device_not_found', 404);
  const { status, body: renamed } = await devicehub(env, '/devices/rename', { method: 'POST', body: JSON.stringify({ terminal_id: terminalId, name }) });
  return status === 200 ? json(renamed) : errorJson('devicehub_failed', 502);
}

async function removeDevice(request: Request, env: Env, orgId: string, terminalId: string): Promise<Response> {
  const caller = await memberOf(request, env, orgId, ADMIN);
  if (caller instanceof Response) return caller;
  if (!(await orgDevice(env, orgId, terminalId))) return errorJson('device_not_found', 404);
  const { status } = await devicehub(env, '/devices/remove', { method: 'POST', body: JSON.stringify({ terminal_id: terminalId }) });
  return status === 200 ? json({ ok: true }) : errorJson('devicehub_failed', 502);
}

// The kassa's "Klantscherm openen": a customer display in a second window of
// this kassa, registered and linked at once — no code: the kassa is paired.
async function openDisplay(request: Request, env: Env, orgId: string, posId: string): Promise<Response> {
  const caller = await memberOf(request, env, orgId, MEMBER);
  if (caller instanceof Response) return caller;
  const pos = await orgDevice(env, orgId, posId);
  if (!pos || pos.role !== 'pos') return errorJson('device_not_found', 404);
  // Always the same display for this kassa (its id follows from the
  // kassa's), so opening it again doesn't add another one to Toestellen.
  // Registering is a no-op when it exists; the name follows the kassa's.
  const terminalId = companionDisplayId(posId);
  const org = await env.DB.prepare('SELECT locale FROM organizations WHERE id = ?').bind(orgId).first<{ locale: string | null }>();
  const name = `${pos.name || COMPANION_KASSA[org?.locale ?? 'nl'] || 'Kassa'} · ${COMPANION_SUFFIX[org?.locale ?? 'nl'] || COMPANION_SUFFIX.nl}`.slice(0, MAX_NAME);
  const registered = await devicehub(env, '/devices/register', {
    method: 'POST',
    body: JSON.stringify({ terminal_id: terminalId, org_id: orgId, role: 'cfd', name }),
  });
  if (registered.status !== 200) return errorJson('devicehub_failed', 502);
  await devicehub(env, '/devices/rename', { method: 'POST', body: JSON.stringify({ terminal_id: terminalId, name }) });
  // It replaces whichever display this kassa had (one per kassa).
  const previous = await devicehub(env, `/devices/${encodeURIComponent(posId)}/linked?role=cfd`);
  if (previous.status === 200 && previous.body?.terminal_id && previous.body.terminal_id !== terminalId) {
    await devicehub(env, '/devices/unlink', { method: 'POST', body: JSON.stringify({ terminal_id: previous.body.terminal_id }) });
  }
  const linked = await devicehub(env, '/devices/link', { method: 'POST', body: JSON.stringify({ pos_terminal_id: posId, terminal_id: terminalId }) });
  if (linked.status !== 200) return errorJson('devicehub_failed', 502);
  return json({ terminalId }, 201);
}

async function linkedDisplay(request: Request, env: Env, orgId: string, posId: string): Promise<Response> {
  const caller = await memberOf(request, env, orgId, MEMBER);
  if (caller instanceof Response) return caller;
  if (!(await orgDevice(env, orgId, posId))) return errorJson('device_not_found', 404);
  const { status, body } = await devicehub(env, `/devices/${encodeURIComponent(posId)}/linked?role=cfd`);
  return status === 200 ? json(body) : errorJson('devicehub_failed', 502);
}

async function linkableDisplays(request: Request, env: Env, orgId: string, posId: string): Promise<Response> {
  const caller = await memberOf(request, env, orgId, MEMBER);
  if (caller instanceof Response) return caller;
  if (!(await orgDevice(env, orgId, posId))) return errorJson('device_not_found', 404);
  const { status, body } = await devicehub(env, `/devices/unlinked?role=cfd&org_id=${encodeURIComponent(orgId)}`);
  return status === 200 ? json(body) : errorJson('devicehub_failed', 502);
}

async function linkDisplay(request: Request, env: Env, orgId: string, posId: string): Promise<Response> {
  const caller = await memberOf(request, env, orgId, MEMBER);
  if (caller instanceof Response) return caller;
  const body = (await request.json().catch(() => null)) as { terminalId?: unknown } | null;
  const terminalId = typeof body?.terminalId === 'string' ? body.terminalId : '';
  const [pos, display] = await Promise.all([orgDevice(env, orgId, posId), terminalId ? orgDevice(env, orgId, terminalId) : null]);
  if (!pos || !display) return errorJson('device_not_found', 404);
  const { status, body: linked } = await devicehub(env, '/devices/link', { method: 'POST', body: JSON.stringify({ pos_terminal_id: posId, terminal_id: terminalId }) });
  return status === 200 ? json(linked) : errorJson('devicehub_failed', 502);
}

async function unlinkDisplay(request: Request, env: Env, orgId: string, terminalId: string): Promise<Response> {
  const caller = await memberOf(request, env, orgId, MEMBER);
  if (caller instanceof Response) return caller;
  if (!(await orgDevice(env, orgId, terminalId))) return errorJson('device_not_found', 404);
  const { status, body } = await devicehub(env, '/devices/unlink', { method: 'POST', body: JSON.stringify({ terminal_id: terminalId }) });
  return status === 200 ? json(body) : errorJson('devicehub_failed', 502);
}

async function resetKassa(request: Request, env: Env, orgId: string, posId: string): Promise<Response> {
  const caller = await memberOf(request, env, orgId, MEMBER);
  if (caller instanceof Response) return caller;
  if (!(await orgDevice(env, orgId, posId))) return errorJson('device_not_found', 404);
  const { status } = await devicehub(env, '/devices/reset', { method: 'POST', body: JSON.stringify({ pos_terminal_id: posId }) });
  return status === 200 ? json({ ok: true }) : errorJson('devicehub_failed', 502);
}

// Every path above; null for anything else (the caller falls through).
export async function dispatchDeviceRoute(request: Request, env: Env, pathname: string): Promise<Response | null> {
  const m = request.method;
  if (pathname === '/organizations/device-pairings/claim') return m === 'POST' ? claimPairing(request, env) : null;

  let match = pathname.match(/^\/organizations\/([^/]+)\/device-pairings$/);
  if (match) {
    if (m === 'POST') return createPairing(request, env, match[1]);
    if (m === 'GET') return listPairings(request, env, match[1]);
    return null;
  }
  match = pathname.match(/^\/organizations\/([^/]+)\/device-pairings\/([^/]+)$/);
  if (match) return m === 'DELETE' ? revokePairing(request, env, match[1], match[2]) : null;

  match = pathname.match(/^\/organizations\/([^/]+)\/devices$/);
  if (match) return m === 'GET' ? listDevices(request, env, match[1]) : null;

  match = pathname.match(/^\/organizations\/([^/]+)\/devices\/([^/]+)$/);
  if (match) {
    const [, orgId, id] = match;
    const terminalId = decodeURIComponent(id);
    if (m === 'GET') return getDevice(request, env, orgId, terminalId);
    if (m === 'PATCH') return renameDevice(request, env, orgId, terminalId);
    if (m === 'DELETE') return removeDevice(request, env, orgId, terminalId);
    return null;
  }

  match = pathname.match(/^\/organizations\/([^/]+)\/devices\/([^/]+)\/(display|linked|linkable|link|unlink|reset)$/);
  if (match) {
    const [, orgId, id, action] = match;
    const terminalId = decodeURIComponent(id);
    if (action === 'linked' || action === 'linkable') {
      if (m !== 'GET') return null;
      return action === 'linked' ? linkedDisplay(request, env, orgId, terminalId) : linkableDisplays(request, env, orgId, terminalId);
    }
    if (m !== 'POST') return null;
    if (action === 'display') return openDisplay(request, env, orgId, terminalId);
    if (action === 'link') return linkDisplay(request, env, orgId, terminalId);
    if (action === 'unlink') return unlinkDisplay(request, env, orgId, terminalId);
    return resetKassa(request, env, orgId, terminalId);
  }
  return null;
}
