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
//   POST   /organizations/:org/tables/:id/move              { toTableId } — Verplaatsen (D1): to a free table, this one Af te ruimen
//   POST   /organizations/:org/tables/:id/merge             { intoTableId } — Samenvoegen (D2): its orders onto that table's tab (not once paid)
//   POST   /organizations/:org/tables/:id/promise           { promised } — Beloven to waiting guests (a table that will come free)
//   GET    /organizations/:org/promised-tables              members, or an entrance screen's key: the promised tables, ready or not
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
import { broadcastOrgEvent, callDeviceHub, notifyTabChanged, notifyTabsChanged } from './devicehub-client';
import { deviceCaller } from './device-keys';
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
  needs_clearing_at?: string | null;
  promised_at?: string | null;
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
    (SELECT MAX(COALESCE(x.closed_at, x.opened_at)) FROM tabs x WHERE x.table_id = t.id AND x.status <> 'open') AS last_closed,
    (SELECT COUNT(*) FROM prep_tickets p WHERE p.tab_id = o.id AND p.status IN ('ordered', 'in_progress')) AS preparing
  FROM tables t
  LEFT JOIN tabs o ON o.table_id = t.id AND o.status = 'open'
  WHERE t.org_id = ?`;

type Joined = TableRow & { tab_id: string | null; tab_number: number | null; tab_label: string | null; tab_opened_at: string | null; tab_token: string | null; tab_total: number; last_closed: string | null; preparing: number };

// Af te ruimen: its last tab ended (paid, cancelled, merged away) or its
// guests moved, after the last "Opgeruimd".
function stateOf(r: Joined): TableState {
  if (r.tab_id) return 'occupied';
  const after = (at: string | null | undefined) => !!at && (!r.cleared_at || at > r.cleared_at);
  if (after(r.last_closed) || after(r.needs_clearing_at)) return 'clearing';
  return 'free';
}

const tableJson = (r: Joined, _admin: boolean) => ({
  id: r.id,
  name: r.name,
  zone: r.zone,
  position: r.position,
  archived: !!r.archived_at,
  state: stateOf(r),
  tab: r.tab_id ? { id: r.tab_id, number: r.tab_number, label: r.tab_label, openedAt: r.tab_opened_at, totalCents: r.tab_total, preparing: r.preparing > 0 } : null,
  // Promised to guests waiting at the entrance (release D).
  promised: !!r.promised_at,
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
    // The guests it was promised to are seated (D5).
    if (row.promised_at) {
      await env.DB.prepare('UPDATE tables SET promised_at = NULL WHERE id = ?').bind(tableId).run();
      await tablesChanged(env, orgId);
    }
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
  // No tab changed: the waiter screens and the entrance screen hear it from their own push.
  await tablesChanged(env, orgId);
  return json(tableJson(after, caller.admin));
}

// The waiter screens (the kassa channel) and the entrance screens (station
// screens with view 'tables') — something about the tables changed.
async function tablesChanged(env: Env, orgId: string): Promise<void> {
  await Promise.all([broadcastOrgEvent(env, orgId, 'tables_changed', {}), broadcastOrgEvent(env, orgId, 'tables_changed', {}, 'station')]);
}

// Verplaatsen (D1): the guests and their tab to a free table; the one they
// leave is Af te ruimen.
async function move(request: Request, env: Env, orgId: string, tableId: string): Promise<Response> {
  const caller = await member(request, env, orgId);
  if (caller instanceof Response) return caller;
  const body = (await request.json().catch(() => ({}))) as { toTableId?: unknown };
  const [from] = await loadTables(env, orgId, 'AND t.id = ?', tableId);
  const [to] = typeof body.toTableId === 'string' ? await loadTables(env, orgId, 'AND t.id = ? AND t.archived_at IS NULL', body.toTableId) : [];
  if (!from || !to) return errorJson('table_not_found', 404);
  if (!from.tab_id) return errorJson('table_not_occupied', 409);
  if (stateOf(to) !== 'free') return errorJson(stateOf(to) === 'occupied' ? 'table_occupied' : 'table_not_cleared', 409);
  const now = new Date().toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare("UPDATE tabs SET table_id = ?, label = ? WHERE id = ? AND status = 'open'").bind(to.id, `Tafel ${to.name}`, from.tab_id),
      env.DB.prepare('UPDATE tables SET needs_clearing_at = ? WHERE id = ?').bind(now, from.id),
      // A promise for the table they move to: theirs now (D5).
      env.DB.prepare('UPDATE tables SET promised_at = NULL WHERE id = ?').bind(to.id),
    ]);
  } catch (err) {
    if (/UNIQUE/i.test(String(err))) return errorJson('table_occupied', 409);
    throw err;
  }
  notifyTabChanged(env, orgId, from.tab_id);
  await tablesChanged(env, orgId);
  const [after] = await loadTables(env, orgId, 'AND t.id = ?', to.id);
  return json(tableJson(after, caller.admin));
}

// Samenvoegen (D2): this table's orders onto another table's tab; this one
// is then Af te ruimen. Refused once this tab has (part of) a payment.
async function merge(request: Request, env: Env, orgId: string, tableId: string): Promise<Response> {
  const caller = await member(request, env, orgId);
  if (caller instanceof Response) return caller;
  const body = (await request.json().catch(() => ({}))) as { intoTableId?: unknown };
  const [from] = await loadTables(env, orgId, 'AND t.id = ?', tableId);
  const [into] = typeof body.intoTableId === 'string' ? await loadTables(env, orgId, 'AND t.id = ?', body.intoTableId) : [];
  if (!from || !into || from.id === into.id) return errorJson('table_not_found', 404);
  if (!from.tab_id || !into.tab_id) return errorJson('table_not_occupied', 409);
  const paid = await env.DB.prepare("SELECT 1 FROM charges WHERE tab_id IN (?, ?) AND status IN ('pending', 'succeeded') LIMIT 1").bind(from.tab_id, into.tab_id).first();
  if (paid) return errorJson('table_merge_paid', 409);
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare('UPDATE order_lines SET tab_id = ? WHERE tab_id = ?').bind(into.tab_id, from.tab_id),
    env.DB.prepare('UPDATE orders SET tab_id = ? WHERE tab_id = ?').bind(into.tab_id, from.tab_id),
    env.DB.prepare('UPDATE prep_tickets SET tab_id = ? WHERE tab_id = ?').bind(into.tab_id, from.tab_id),
    env.DB.prepare("UPDATE tabs SET status = 'cancelled', closed_at = ?, cancel_reason = ? WHERE id = ? AND status = 'open'").bind(now, `Samengevoegd met Tafel ${into.name}`, from.tab_id),
    env.DB.prepare('UPDATE tables SET needs_clearing_at = ? WHERE id = ?').bind(now, from.id),
  ]);
  notifyTabsChanged(env, orgId, [from.tab_id, into.tab_id]);
  await tablesChanged(env, orgId);
  const [after] = await loadTables(env, orgId, 'AND t.id = ?', into.id);
  return json(tableJson(after, caller.admin));
}

// Beloven: the table is promised to guests waiting at the entrance (only
// one that will come free: Bezet or Af te ruimen); { promised: false } takes it back.
async function promise(request: Request, env: Env, orgId: string, tableId: string): Promise<Response> {
  const caller = await member(request, env, orgId);
  if (caller instanceof Response) return caller;
  const [row] = await loadTables(env, orgId, 'AND t.id = ?', tableId);
  if (!row) return errorJson('table_not_found', 404);
  const body = (await request.json().catch(() => ({}))) as { promised?: unknown };
  const on = body.promised !== false;
  if (on && stateOf(row) === 'free') return errorJson('table_free', 409);
  await env.DB.prepare('UPDATE tables SET promised_at = ? WHERE id = ?').bind(on ? new Date().toISOString() : null, tableId).run();
  await tablesChanged(env, orgId);
  const [after] = await loadTables(env, orgId, 'AND t.id = ?', tableId);
  return json(tableJson(after, caller.admin));
}

// The entrance screen: the promised tables, oldest promise first — ready
// once cleaned (Vrij). A member, or an entrance screen's own key.
async function promised(request: Request, env: Env, orgId: string): Promise<Response> {
  if (!extractCaller(request)) {
    const device = await deviceCaller(request, env);
    if (!device) return json({ error: 'Unauthorized' }, 401);
    const own = device.orgId === orgId && device.role === 'station'
      ? await env.DB.prepare('SELECT view FROM station_devices WHERE terminal_id = ? AND org_id = ?').bind(device.terminalId, orgId).first<{ view: string | null }>()
      : null;
    if (own?.view !== 'tables') return json({ error: 'Forbidden' }, 403);
  } else {
    const caller = await member(request, env, orgId);
    if (caller instanceof Response) return caller;
  }
  const rows = await loadTables(env, orgId, 'AND t.promised_at IS NOT NULL AND t.archived_at IS NULL');
  rows.sort((a, b) => String(a.promised_at).localeCompare(String(b.promised_at)));
  return json(rows.map((r) => ({ name: r.name, zone: r.zone, ready: stateOf(r) === 'free', promisedAt: r.promised_at })));
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
  r = pathname.match(/^\/organizations\/([^/]+)\/promised-tables$/);
  if (r && m === 'GET') return promised(request, env, r[1]);
  r = pathname.match(/^\/organizations\/([^/]+)\/tables\/([^/]+)\/(new-qr|seat|clear|move|merge|promise)$/);
  if (r && m === 'POST') {
    const [, orgId, id, action] = r;
    const tableId = decodeURIComponent(id);
    if (action === 'new-qr') return newQr(request, env, orgId, tableId);
    if (action === 'seat') return seat(request, env, orgId, tableId);
    if (action === 'move') return move(request, env, orgId, tableId);
    if (action === 'merge') return merge(request, env, orgId, tableId);
    if (action === 'promise') return promise(request, env, orgId, tableId);
    return clear(request, env, orgId, tableId);
  }
  const pub = pathname.match(/^\/public\/tables\/([^/]+)$/);
  if (pub && m === 'GET') return publicTable(env, decodeURIComponent(pub[1]));
  return null;
}
