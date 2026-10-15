// Tables and waiters — DOMAIN_MODEL.md "Tables and waiters" (release C).
// Tables belong to the organisation (T1), optionally in a zone; one open tab
// per table (T5); a table's status follows that tab — only "Opgeruimd" is
// set by hand:
//
//   Bezet         a tab is open on it
//   Af te ruimen  its last tab was paid (or cancelled) after the last "Opgeruimd"
//   Vrij          otherwise
//
//   GET    /organizations/:org/tables                       admin, Kassa, Bediening: the tables with their status and open tab
//   POST   /organizations/:org/tables                       admin: { name, zone? }
//   PATCH  /organizations/:org/tables/:id                   admin: { name?, zone?, position?, archived? }
//   POST   /organizations/:org/tables/:id/new-qr            admin: a new QR code (the old one stops working)
//   POST   /organizations/:org/tables/:id/seat              admin, Kassa, Bediening: { eventId, modeId? } — guests seated: its tab opens
//   POST   /organizations/:org/tables/:id/clear             admin, Kassa, Bediening: "Opgeruimd" — Vrij again
//   GET    /organizations/:org/tables/by-qr/:token          admin, Kassa, Bediening: the table a scanned QR is (the waiter screen)
//   GET    /organizations/:org/live-token                   admin, Kassa, Bediening: the waiter screen's live channel
//   GET    /public/tables/:token                            a guest who scanned it: the table, and — while it's
//                                                           Bezet and its mode lets guests order with the QR — the
//                                                           tab's follow token (they order on it, T3)
//
// A table's tab: label "Tafel <name>", source 'table', paid when leaving,
// with the event's ordering mode "aan tafel" (T2) — its menu is the waiters'.
import type { Env } from './env';
import { errorJson } from './errors';
import { json } from './http';
import { extractCaller, requireOrgRole, SERVICE_ROLES } from './organizations/auth';
import { broadcastOrgEvent, callDeviceHub } from './devicehub-client';
import { openTab, type Who } from './tabs';
import { staffOf } from './staff';

const MAX_NAME = 30;

interface TableRow {
  id: string;
  org_id: string;
  name: string;
  zone: string | null;
  position: number;
  qr_token: string | null;
  cleared_at: string | null;
  created_at: string;
  archived_at: string | null;
}

type TableState = 'free' | 'occupied' | 'clearing';

// 20 characters from 32 without look-alikes: not guessable, short enough for a QR.
function newToken(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  return [...crypto.getRandomValues(new Uint8Array(20))].map((b) => alphabet[b % alphabet.length]).join('');
}

async function member(request: Request, env: Env, orgId: string): Promise<{ admin: boolean } | Response> {
  const caller = extractCaller(request);
  if (!caller) return json({ error: 'Unauthorized' }, 401);
  const membership = await requireOrgRole(env, orgId, caller, SERVICE_ROLES);
  if (!membership) return json({ error: 'Forbidden' }, 403);
  return { admin: membership.role === 'admin' };
}

// Every table of the organisation with its state and open tab — one query.
const TABLES_SQL = `
  SELECT t.*,
    o.id AS tab_id, o.number AS tab_number, o.label AS tab_label, o.opened_at AS tab_opened_at, o.order_token AS tab_token,
    (SELECT COALESCE(SUM(l.unit_price_cents * l.quantity), 0) FROM order_lines l WHERE l.tab_id = o.id) AS tab_total,
    (SELECT MAX(COALESCE(x.closed_at, x.opened_at)) FROM tabs x WHERE x.table_id = t.id AND x.status <> 'open') AS last_closed
  FROM tables t
  LEFT JOIN tabs o ON o.table_id = t.id AND o.status = 'open'
  WHERE t.org_id = ?`;

type Joined = TableRow & { tab_id: string | null; tab_number: number | null; tab_label: string | null; tab_opened_at: string | null; tab_token: string | null; tab_total: number; last_closed: string | null };

function stateOf(r: Joined): TableState {
  if (r.tab_id) return 'occupied';
  if (r.last_closed && (!r.cleared_at || r.last_closed > r.cleared_at)) return 'clearing';
  return 'free';
}

const tableJson = (r: Joined, _admin: boolean) => ({
  id: r.id,
  name: r.name,
  zone: r.zone,
  position: r.position,
  archived: !!r.archived_at,
  state: stateOf(r),
  tab: r.tab_id ? { id: r.tab_id, number: r.tab_number, label: r.tab_label, openedAt: r.tab_opened_at, totalCents: r.tab_total } : null,
  // The QR's token: for admins (printing it) and whoever seats guests.
  qrToken: r.qr_token,
});

async function loadTables(env: Env, orgId: string, where = '', ...params: unknown[]): Promise<Joined[]> {
  const { results } = await env.DB.prepare(`${TABLES_SQL} ${where} ORDER BY t.zone IS NOT NULL, t.zone, t.position, t.name`)
    .bind(orgId, ...params)
    .all<Joined>();
  return results || [];
}

async function listTables(request: Request, env: Env, orgId: string): Promise<Response> {
  const caller = await member(request, env, orgId);
  if (caller instanceof Response) return caller;
  // A table without a QR yet (made before, or imported): it gets one now.
  await env.DB.prepare('UPDATE tables SET qr_token = ? WHERE id = (SELECT id FROM tables WHERE org_id = ? AND qr_token IS NULL LIMIT 1)').bind(newToken(), orgId).run();
  const rows = await loadTables(env, orgId, caller.admin ? '' : 'AND t.archived_at IS NULL');
  // More than one without a QR: one per listing is enough work per request; the rest follow.
  return json(rows.map((r) => tableJson(r, caller.admin)));
}

async function createTable(request: Request, env: Env, orgId: string): Promise<Response> {
  const caller = await member(request, env, orgId);
  if (caller instanceof Response) return caller;
  if (!caller.admin) return json({ error: 'Forbidden' }, 403);
  const body = (await request.json().catch(() => ({}))) as { name?: unknown; zone?: unknown };
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, MAX_NAME) : '';
  if (!name) return errorJson('table_name_required', 400);
  const zone = typeof body.zone === 'string' && body.zone.trim() ? body.zone.trim().slice(0, MAX_NAME) : null;
  if (await env.DB.prepare('SELECT 1 FROM tables WHERE org_id = ? AND archived_at IS NULL AND name = ? COLLATE NOCASE').bind(orgId, name).first()) return errorJson('table_name_taken', 409);
  const id = crypto.randomUUID();
  const position = ((await env.DB.prepare('SELECT MAX(position) AS p FROM tables WHERE org_id = ?').bind(orgId).first<{ p: number | null }>())?.p ?? -1) + 1;
  await env.DB.prepare('INSERT INTO tables (id, org_id, name, zone, position, qr_token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, orgId, name, zone, position, newToken(), new Date().toISOString())
    .run();
  const [row] = await loadTables(env, orgId, 'AND t.id = ?', id);
  return json(tableJson(row, true), 201);
}

async function updateTable(request: Request, env: Env, orgId: string, tableId: string): Promise<Response> {
  const caller = await member(request, env, orgId);
  if (caller instanceof Response) return caller;
  if (!caller.admin) return json({ error: 'Forbidden' }, 403);
  const [row] = await loadTables(env, orgId, 'AND t.id = ?', tableId);
  if (!row) return errorJson('table_not_found', 404);
  const body = (await request.json().catch(() => ({}))) as { name?: unknown; zone?: unknown; position?: unknown; archived?: unknown };
  let { name, zone, position, archived_at } = row;
  if (body.name !== undefined) {
    name = typeof body.name === 'string' ? body.name.trim().slice(0, MAX_NAME) : '';
    if (!name) return errorJson('table_name_required', 400);
    if (await env.DB.prepare('SELECT 1 FROM tables WHERE org_id = ? AND archived_at IS NULL AND name = ? COLLATE NOCASE AND id <> ?').bind(orgId, name, tableId).first()) return errorJson('table_name_taken', 409);
  }
  if (body.zone !== undefined) zone = typeof body.zone === 'string' && body.zone.trim() ? body.zone.trim().slice(0, MAX_NAME) : null;
  if (body.position !== undefined && Number.isInteger(body.position)) position = body.position as number;
  if (body.archived !== undefined) {
    if (body.archived && row.tab_id) return errorJson('table_occupied', 409);
    archived_at = body.archived ? (archived_at ?? new Date().toISOString()) : null;
  }
  await env.DB.prepare('UPDATE tables SET name = ?, zone = ?, position = ?, archived_at = ? WHERE id = ?').bind(name, zone, position, archived_at, tableId).run();
  const [after] = await loadTables(env, orgId, 'AND t.id = ?', tableId);
  return json(tableJson(after, true));
}

async function newQr(request: Request, env: Env, orgId: string, tableId: string): Promise<Response> {
  const caller = await member(request, env, orgId);
  if (caller instanceof Response) return caller;
  if (!caller.admin) return json({ error: 'Forbidden' }, 403);
  const done = await env.DB.prepare('UPDATE tables SET qr_token = ? WHERE id = ? AND org_id = ?').bind(newToken(), tableId, orgId).run();
  if (!done.meta.changes) return errorJson('table_not_found', 404);
  const [row] = await loadTables(env, orgId, 'AND t.id = ?', tableId);
  return json(tableJson(row, true));
}

// Guests seated: the table's tab opens — paid when they leave, with the
// event's "aan tafel" mode (T2). Only a Vrij table (one tab per table, T5;
// not one still to be cleared).
async function seat(request: Request, env: Env, orgId: string, tableId: string): Promise<Response> {
  const caller = await member(request, env, orgId);
  if (caller instanceof Response) return caller;
  const [row] = await loadTables(env, orgId, 'AND t.id = ? AND t.archived_at IS NULL', tableId);
  if (!row) return errorJson('table_not_found', 404);
  const state = stateOf(row);
  if (state === 'occupied') return errorJson('table_occupied', 409);
  if (state === 'clearing') return errorJson('table_not_cleared', 409);
  const body = (await request.json().catch(() => ({}))) as { eventId?: unknown; modeId?: unknown; deviceName?: unknown };
  const event = typeof body.eventId === 'string' ? await env.DB.prepare('SELECT id FROM events WHERE id = ? AND org_id = ?').bind(body.eventId, orgId).first<{ id: string }>() : null;
  if (!event) return errorJson('event_not_found', 404);
  const { results: modes } = await env.DB.prepare('SELECT id, name, catalog_id FROM event_order_modes WHERE event_id = ? AND at_table = 1 AND catalog_id IS NOT NULL ORDER BY position')
    .bind(event.id)
    .all<{ id: string; name: string; catalog_id: string }>();
  const mode = (modes || []).find((m) => m.id === body.modeId) ?? (modes || [])[0];
  if (!mode) return errorJson('no_table_mode', 409);
  const staff = await staffOf(request, env, orgId);
  const who: Who = {
    deviceId: null,
    deviceName: typeof body.deviceName === 'string' ? body.deviceName.slice(0, 100) : null,
    userName: request.headers.get('X-User-Name') || null,
    userEmail: request.headers.get('X-User-Email') || null,
    staffId: staff?.id ?? null,
    staffName: staff?.name ?? null,
  };
  try {
    const tabId = await openTab(env, {
      orgId,
      label: `Tafel ${row.name}`,
      slotId: null,
      eventId: event.id,
      who,
      source: 'table',
      lines: [],
      catalogId: mode.catalog_id,
      payLater: true,
      orderMode: { id: mode.id, name: mode.name },
      tableId,
    });
    const [after] = await loadTables(env, orgId, 'AND t.id = ?', tableId);
    void tabId; // openTab already told the kassas and waiter screens
    return json(tableJson(after, caller.admin), 201);
  } catch (err) {
    // The unique index: someone seated guests here just now.
    if (/UNIQUE/i.test(String(err))) return errorJson('table_occupied', 409);
    throw err;
  }
}

async function clear(request: Request, env: Env, orgId: string, tableId: string): Promise<Response> {
  const caller = await member(request, env, orgId);
  if (caller instanceof Response) return caller;
  const [row] = await loadTables(env, orgId, 'AND t.id = ?', tableId);
  if (!row) return errorJson('table_not_found', 404);
  if (row.tab_id) return errorJson('table_occupied', 409);
  await env.DB.prepare('UPDATE tables SET cleared_at = ? WHERE id = ?').bind(new Date().toISOString(), tableId).run();
  const [after] = await loadTables(env, orgId, 'AND t.id = ?', tableId);
  // No tab changed: the waiter screens hear it from their own push.
  await broadcastOrgEvent(env, orgId, 'tables_changed', { table_id: tableId });
  return json(tableJson(after, caller.admin));
}

// The waiter screen's live channel (a waiter's own phone is no device): a
// socket token for the organisation's kassa channel, from devicehub.
async function liveToken(request: Request, env: Env, orgId: string): Promise<Response> {
  const caller = await member(request, env, orgId);
  if (caller instanceof Response) return caller;
  const res = await callDeviceHub(env, '/devices/member-ws-token', { method: 'POST', body: JSON.stringify({ org_id: orgId }) });
  if (!res.ok) return errorJson('devicehub_failed', 502);
  return json(await res.json());
}

async function byQr(request: Request, env: Env, orgId: string, token: string): Promise<Response> {
  const caller = await member(request, env, orgId);
  if (caller instanceof Response) return caller;
  const [row] = await loadTables(env, orgId, 'AND t.qr_token = ? AND t.archived_at IS NULL', token);
  return row ? json(tableJson(row, caller.admin)) : errorJson('table_not_found', 404);
}

// A guest who scanned the table's QR: the table, and — while it's Bezet and
// its tab's mode lets guests order with the QR — the tab's follow token.
export async function publicTable(env: Env, token: string): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT t.name, t.org_id, o.order_token, m.self_order, e.self_order_enabled
     FROM tables t
     LEFT JOIN tabs o ON o.table_id = t.id AND o.status = 'open'
     LEFT JOIN event_order_modes m ON m.id = o.order_mode_id
     LEFT JOIN events e ON e.id = o.event_id
     WHERE t.qr_token = ? AND t.archived_at IS NULL`
  )
    .bind(token)
    .first<{ name: string; org_id: string; order_token: string | null; self_order: number | null; self_order_enabled: number | null }>();
  if (!row) return errorJson('table_not_found', 404);
  const org = await env.DB.prepare('SELECT name FROM organizations WHERE id = ?').bind(row.org_id).first<{ name: string }>();
  const canOrder = !!row.order_token && !!row.self_order && !!row.self_order_enabled;
  return json({ table: row.name, orgName: org?.name ?? '', occupied: !!row.order_token, orderToken: canOrder ? row.order_token : null });
}

export async function dispatchTablesRoute(request: Request, env: Env, pathname: string): Promise<Response | null> {
  const m = request.method;
  let r = pathname.match(/^\/organizations\/([^/]+)\/tables$/);
  if (r && m === 'GET') return listTables(request, env, r[1]);
  if (r && m === 'POST') return createTable(request, env, r[1]);
  r = pathname.match(/^\/organizations\/([^/]+)\/live-token$/);
  if (r && m === 'GET') return liveToken(request, env, r[1]);
  r = pathname.match(/^\/organizations\/([^/]+)\/tables\/by-qr\/([^/]+)$/);
  if (r && m === 'GET') return byQr(request, env, r[1], decodeURIComponent(r[2]));
  r = pathname.match(/^\/organizations\/([^/]+)\/tables\/([^/]+)$/);
  if (r && m === 'PATCH') return updateTable(request, env, r[1], decodeURIComponent(r[2]));
  r = pathname.match(/^\/organizations\/([^/]+)\/tables\/([^/]+)\/(new-qr|seat|clear)$/);
  if (r && m === 'POST') {
    const [, orgId, id, action] = r;
    if (action === 'new-qr') return newQr(request, env, orgId, decodeURIComponent(id));
    if (action === 'seat') return seat(request, env, orgId, decodeURIComponent(id));
    return clear(request, env, orgId, decodeURIComponent(id));
  }
  const pub = pathname.match(/^\/public\/tables\/([^/]+)$/);
  if (pub && m === 'GET') return publicTable(env, decodeURIComponent(pub[1]));
  return null;
}
