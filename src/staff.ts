// Staff on shared devices — DOMAIN_MODEL.md "Staff on shared devices"
// (release B1). A staff member is a name (+ an optional PIN) to record who
// did what on a shared kassa or station screen; not an account and not
// security (the device itself is trusted). A device picks its person, gets
// a signed token for them (after the PIN, if there is one) and sends it as
// X-Staff with what it does; the backend records the person from that token
// only — never from a name a browser sends.
//
//   GET    /organizations/:org/staff                 member or a station screen's key: { required, staff: [{ id, name, hasPin }] }
//                                                    (?all=1, admins: archived ones too, with memberId)
//   POST   /organizations/:org/staff                 admin: { name, pin? }
//   PATCH  /organizations/:org/staff/:id             admin: { name?, pin? (null = none), memberId?, archived? }
//   POST   /organizations/:org/staff/:id/token       member or a station screen's key: { pin? } → { token, staff }
//   PUT    /organizations/:org/staff-settings        admin: { required } — a person must be chosen to sell (S2)
import type { Env } from './env';
import { errorJson } from './errors';
import { json } from './http';
import { extractCaller, requireOrgRole } from './organizations/auth';
import { deviceCaller } from './device-keys';

const MAX_NAME = 60;
const PIN = /^\d{4,6}$/;
// Wrong PINs per device (or person) per minute.
const MAX_PIN_TRIES = 5;
// A chosen person stays chosen (S1): the token lasts a month, and stops
// working sooner when the staff member is archived or their PIN changes.
const TOKEN_DAYS = 30;

export interface Staff {
  id: string;
  name: string;
}

interface StaffRow {
  id: string;
  org_id: string;
  name: string;
  pin_hash: string | null;
  pin_changed_at: string | null;
  member_id: string | null;
  created_at: string;
  archived_at: string | null;
}

const enc = new TextEncoder();
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (text: string) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4)), (c) => c.charCodeAt(0));

async function sha256Hex(text: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// A PIN keeps colleagues apart, nothing more: salted with the staff id.
const pinHash = (staffId: string, pin: string) => sha256Hex(`staff-pin:${staffId}:${pin}`);

// The token's signing key, derived from the installation's ENCRYPTION_KEY.
async function tokenKey(env: Env): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest('SHA-256', enc.encode(`staff-token:${env.ENCRYPTION_KEY}`));
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function issueToken(env: Env, orgId: string, staffId: string): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify({ o: orgId, s: staffId, t: Date.now() })));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await tokenKey(env), enc.encode(payload)));
  return `${payload}.${b64url(sig)}`;
}

// The person a request comes from (its X-Staff token), or null — a token
// that's forged, for another organisation, too old, or of someone archived
// or whose PIN changed since, counts as nobody.
export async function staffOf(request: Request, env: Env, orgId: string): Promise<Staff | null> {
  const token = request.headers.get('X-Staff') || '';
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  try {
    const valid = await crypto.subtle.verify('HMAC', await tokenKey(env), fromB64url(sig), enc.encode(payload));
    if (!valid) return null;
    const { o, s, t } = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as { o: string; s: string; t: number };
    if (o !== orgId || typeof t !== 'number' || Date.now() - t > TOKEN_DAYS * 86_400_000) return null;
    const row = await env.DB.prepare('SELECT id, name, pin_changed_at FROM staff WHERE id = ? AND org_id = ? AND archived_at IS NULL')
      .bind(s, orgId)
      .first<{ id: string; name: string; pin_changed_at: string | null }>();
    if (!row || (row.pin_changed_at && Date.parse(row.pin_changed_at) > t)) return null;
    return { id: row.id, name: row.name };
  } catch {
    return null;
  }
}

// Whether this organisation requires a person to be chosen to sell (S2).
export async function staffRequired(env: Env, orgId: string): Promise<boolean> {
  return !!(await env.DB.prepare('SELECT staff_required FROM organizations WHERE id = ?').bind(orgId).first<{ staff_required: number }>())?.staff_required;
}

// The person for something a kassa does: refused (409 staff_required) when
// the organisation requires one and none was chosen.
// A personal device (the waiter screen on someone's own phone, signed in
// with their own account - T7) chooses nobody: the account says who, and
// the staff member linked to that account's membership, if any, is
// recorded. The requirement is for shared devices only.
export async function staffForSale(request: Request, env: Env, orgId: string): Promise<Staff | null | Response> {
  const staff = await staffOf(request, env, orgId);
  if (staff) return staff;
  if (request.headers.get('X-Arcanum-Device') === 'personal') return linkedStaff(request, env, orgId);
  if (await staffRequired(env, orgId)) return errorJson('staff_required', 409);
  return null;
}

async function linkedStaff(request: Request, env: Env, orgId: string): Promise<Staff | null> {
  const caller = extractCaller(request);
  if (!caller) return null;
  return env.DB.prepare(
    `SELECT s.id, s.name FROM staff s JOIN memberships m ON m.id = s.member_id
     WHERE s.org_id = ? AND s.archived_at IS NULL AND m.org_id = ? AND m.user_sub = ? AND m.issuer = ? AND m.status = 'active' LIMIT 1`
  )
    .bind(orgId, orgId, caller.sub, caller.issuer)
    .first<Staff>();
}

type Access = { kind: 'member'; admin: boolean; who: string } | { kind: 'device'; who: string };

// A member (admin or kassa) — or, where `devices`, a station screen's own key.
async function access(request: Request, env: Env, orgId: string, devices: boolean): Promise<Access | Response> {
  const caller = extractCaller(request);
  if (caller) {
    const membership = await requireOrgRole(env, orgId, caller, ['admin', 'cashier']);
    if (!membership) return json({ error: 'Forbidden' }, 403);
    return { kind: 'member', admin: membership.role === 'admin', who: `${caller.issuer}|${caller.sub}` };
  }
  const device = devices ? await deviceCaller(request, env) : null;
  if (!device) return json({ error: 'Unauthorized' }, 401);
  if (device.orgId !== orgId || device.role !== 'station') return json({ error: 'Forbidden' }, 403);
  return { kind: 'device', who: `device|${device.terminalId}` };
}

const staffJson = (r: StaffRow, full: boolean) => ({
  id: r.id,
  name: r.name,
  hasPin: !!r.pin_hash,
  ...(full ? { memberId: r.member_id, archived: !!r.archived_at, createdAt: r.created_at } : {}),
});

async function listStaff(request: Request, env: Env, orgId: string): Promise<Response> {
  const a = await access(request, env, orgId, true);
  if (a instanceof Response) return a;
  const all = a.kind === 'member' && a.admin && new URL(request.url).searchParams.get('all') === '1';
  const { results } = await env.DB.prepare(`SELECT * FROM staff WHERE org_id = ? ${all ? '' : 'AND archived_at IS NULL'} ORDER BY name COLLATE NOCASE`)
    .bind(orgId)
    .all<StaffRow>();
  return json({ required: await staffRequired(env, orgId), staff: (results || []).map((r) => staffJson(r, all)) });
}

async function adminOnly(request: Request, env: Env, orgId: string): Promise<Response | null> {
  const a = await access(request, env, orgId, false);
  if (a instanceof Response) return a;
  return a.kind === 'member' && a.admin ? null : json({ error: 'Forbidden' }, 403);
}

async function nameTaken(env: Env, orgId: string, name: string, except = ''): Promise<boolean> {
  return !!(await env.DB.prepare('SELECT 1 FROM staff WHERE org_id = ? AND archived_at IS NULL AND name = ? COLLATE NOCASE AND id <> ?').bind(orgId, name, except).first());
}

async function createStaff(request: Request, env: Env, orgId: string): Promise<Response> {
  const refused = await adminOnly(request, env, orgId);
  if (refused) return refused;
  const body = (await request.json().catch(() => ({}))) as { name?: unknown; pin?: unknown };
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, MAX_NAME) : '';
  if (!name) return errorJson('staff_name_required', 400);
  if (body.pin !== undefined && body.pin !== null && !(typeof body.pin === 'string' && PIN.test(body.pin))) return errorJson('staff_pin_invalid', 400);
  if (await nameTaken(env, orgId, name)) return errorJson('staff_name_taken', 409);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const hash = typeof body.pin === 'string' ? await pinHash(id, body.pin) : null;
  await env.DB.prepare('INSERT INTO staff (id, org_id, name, pin_hash, pin_changed_at, member_id, created_at, archived_at) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL)')
    .bind(id, orgId, name, hash, hash ? now : null, now)
    .run();
  const row = await env.DB.prepare('SELECT * FROM staff WHERE id = ?').bind(id).first<StaffRow>();
  return json(staffJson(row!, true), 201);
}

async function updateStaff(request: Request, env: Env, orgId: string, staffId: string): Promise<Response> {
  const refused = await adminOnly(request, env, orgId);
  if (refused) return refused;
  const row = await env.DB.prepare('SELECT * FROM staff WHERE id = ? AND org_id = ?').bind(staffId, orgId).first<StaffRow>();
  if (!row) return errorJson('staff_not_found', 404);
  const body = (await request.json().catch(() => ({}))) as { name?: unknown; pin?: unknown; memberId?: unknown; archived?: unknown };
  const now = new Date().toISOString();
  let { name, pin_hash, pin_changed_at, member_id, archived_at } = row;
  if (body.name !== undefined) {
    name = typeof body.name === 'string' ? body.name.trim().slice(0, MAX_NAME) : '';
    if (!name) return errorJson('staff_name_required', 400);
  }
  if (body.pin !== undefined) {
    if (body.pin !== null && !(typeof body.pin === 'string' && PIN.test(body.pin))) return errorJson('staff_pin_invalid', 400);
    pin_hash = typeof body.pin === 'string' ? await pinHash(staffId, body.pin) : null;
    // Devices that chose this person before must choose again.
    pin_changed_at = now;
  }
  if (body.memberId !== undefined) {
    member_id = typeof body.memberId === 'string' && body.memberId ? body.memberId : null;
    if (member_id && !(await env.DB.prepare('SELECT 1 FROM memberships WHERE id = ? AND org_id = ?').bind(member_id, orgId).first())) return errorJson('member_not_found', 404);
  }
  if (body.archived !== undefined) archived_at = body.archived ? (archived_at ?? now) : null;
  if (!archived_at && (await nameTaken(env, orgId, name, staffId))) return errorJson('staff_name_taken', 409);
  await env.DB.prepare('UPDATE staff SET name = ?, pin_hash = ?, pin_changed_at = ?, member_id = ?, archived_at = ? WHERE id = ?')
    .bind(name, pin_hash, pin_changed_at, member_id, archived_at, staffId)
    .run();
  return json(staffJson({ ...row, name, pin_hash, pin_changed_at, member_id, archived_at }, true));
}

async function staffToken(request: Request, env: Env, orgId: string, staffId: string): Promise<Response> {
  const a = await access(request, env, orgId, true);
  if (a instanceof Response) return a;
  const since = new Date(Date.now() - 60_000).toISOString();
  const tries = await env.DB.prepare('SELECT COUNT(*) AS n FROM staff_pin_failures WHERE caller = ? AND at > ?').bind(a.who, since).first<{ n: number }>();
  if ((tries?.n ?? 0) >= MAX_PIN_TRIES) return errorJson('staff_pin_too_many', 429);
  const row = await env.DB.prepare('SELECT * FROM staff WHERE id = ? AND org_id = ? AND archived_at IS NULL').bind(staffId, orgId).first<StaffRow>();
  if (!row) return errorJson('staff_not_found', 404);
  if (row.pin_hash) {
    const body = (await request.json().catch(() => ({}))) as { pin?: unknown };
    const ok = typeof body.pin === 'string' && (await pinHash(staffId, body.pin)) === row.pin_hash;
    if (!ok) {
      await env.DB.batch([
        env.DB.prepare('INSERT INTO staff_pin_failures (caller, at) VALUES (?, ?)').bind(a.who, new Date().toISOString()),
        env.DB.prepare('DELETE FROM staff_pin_failures WHERE at < ?').bind(new Date(Date.now() - 3600_000).toISOString()),
      ]);
      return errorJson('staff_pin_wrong', 403);
    }
  }
  return json({ token: await issueToken(env, orgId, staffId), staff: { id: row.id, name: row.name } });
}

async function setSettings(request: Request, env: Env, orgId: string): Promise<Response> {
  const refused = await adminOnly(request, env, orgId);
  if (refused) return refused;
  const body = (await request.json().catch(() => ({}))) as { required?: unknown };
  if (typeof body.required !== 'boolean') return json({ error: 'required must be true or false' }, 400);
  await env.DB.prepare('UPDATE organizations SET staff_required = ? WHERE id = ?').bind(body.required ? 1 : 0, orgId).run();
  return json({ required: body.required });
}

export async function dispatchStaffRoute(request: Request, env: Env, pathname: string): Promise<Response | null> {
  const settings = pathname.match(/^\/organizations\/([^/]+)\/staff-settings$/);
  if (settings && request.method === 'PUT') return setSettings(request, env, settings[1]);
  const m = pathname.match(/^\/organizations\/([^/]+)\/staff(?:\/([^/]+)(\/token)?)?$/);
  if (!m) return null;
  const [, orgId, id, token] = m;
  if (!id && request.method === 'GET') return listStaff(request, env, orgId);
  if (!id && request.method === 'POST') return createStaff(request, env, orgId);
  if (id && !token && request.method === 'PATCH') return updateStaff(request, env, orgId, decodeURIComponent(id));
  if (id && token && request.method === 'POST') return staffToken(request, env, orgId, decodeURIComponent(id));
  return null;
}
