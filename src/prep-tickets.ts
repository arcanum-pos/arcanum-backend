// Prep tickets (bonnen) and station screens — DOMAIN_MODEL.md "Self-ordering
// and station screens". Every order line carries its product's prep station
// (a snapshot, tabs.ts); submitting an order makes one ticket per station
// with something on it. A station screen (device role 'station', linked to
// one station) lists its tickets and moves them on:
//
//   ordered → in_progress → ready → delivered
//
// "Paid" isn't a ticket status: it's the tab's (closed = paid). A station
// screen shows only paid orders by default; that's its own filter.
//
//   GET  /organizations/:org/stations/:station/tickets[?delivered=1]   member
//   POST /organizations/:org/tickets/:id { status }                    member
//
// Changes reach the station screens, the kassas and the "follow your order"
// pages through one notification (devicehub-client.ts notifyTabChanged).
import type { Env } from './env';
import { errorJson } from './errors';
import { json } from './http';
import { extractCaller, requireOrgRole } from './organizations/auth';
import { notifyTabsChanged } from './devicehub-client';
import { notifyTicketReady, sweepPhones } from './messaging';

export const TICKET_STATUSES = ['ordered', 'in_progress', 'ready', 'delivered'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

// How long a station screen looks back: an evening's event, past midnight.
const STATION_WINDOW_HOURS = 18;
// An unpaid self-order is cancelled after this (DOMAIN_MODEL.md: 10 minutes).
export const SELF_ORDER_PAY_MINUTES = 10;

// The ordering mode's name to show ("Take away") — only when its event has
// more than one mode: with one, it says nothing. Information only, never
// routing (a product's prep station decides where it's made).
export const MODE_LABEL_SQL = (ref: string) =>
  `CASE WHEN (SELECT COUNT(*) FROM event_order_modes em WHERE em.event_id = ${ref}.event_id) > 1 THEN ${ref}.order_mode_name END`;

// One statement for an order's tickets — one per station that has a line in
// it (voids never make one) — run in the same batch as the order's lines,
// after them: an order that wasn't inserted has no lines, so no tickets.
export function ticketInsertStatement(env: Env, orgId: string, tabId: string, orderId: string, now: string): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO prep_tickets (id, org_id, tab_id, order_id, station_id, station_name, status, created_at, updated_at)
     SELECT lower(hex(randomblob(16))), ?, ?, ?, prep_station_id, MAX(prep_station_name), 'ordered', ?, ?
     FROM order_lines WHERE order_id = ? AND prep_station_id IS NOT NULL AND voids_line_id IS NULL
     GROUP BY prep_station_id`
  ).bind(orgId, tabId, orderId, now, now, orderId);
}

// Unpaid self-orders older than SELF_ORDER_PAY_MINUTES: cancelled — not a
// tab that's paid when the guest leaves (pay_later). Run
// whenever something looks (the kassa's tab list, a station screen, a new
// self-order, a "follow your order" page) — no timer needed.
export async function cancelExpiredSelfOrders(env: Env, orgId: string): Promise<void> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - SELF_ORDER_PAY_MINUTES * 60_000).toISOString();
  const { results } = await env.DB.prepare(
    `UPDATE tabs SET status = 'cancelled', closed_at = ?, cancel_reason = 'Niet betaald binnen ${SELF_ORDER_PAY_MINUTES} minuten', notify_phone = NULL
     WHERE org_id = ? AND source = 'self_order' AND pay_later = 0 AND status = 'open' AND opened_at < ?
       AND NOT EXISTS (SELECT 1 FROM charges WHERE charges.tab_id = tabs.id AND charges.status IN ('pending', 'succeeded'))
     RETURNING id`
  )
    .bind(now.toISOString(), orgId, cutoff)
    .all<{ id: string }>();
  const ids = (results || []).map((r) => r.id);
  if (ids.length) notifyTabsChanged(env, orgId, ids);
}

async function member(request: Request, env: Env, orgId: string): Promise<Response | { who: string }> {
  const caller = extractCaller(request);
  if (!caller) return json({ error: 'Unauthorized' }, 401);
  if (!(await requireOrgRole(env, orgId, caller, ['admin', 'cashier']))) return json({ error: 'Forbidden' }, 403);
  return { who: caller.name || caller.email || caller.sub };
}

interface TicketRow {
  id: string;
  tab_id: string;
  order_id: string;
  status: TicketStatus;
  created_at: string;
  updated_at: string;
  number: number;
  event_number: number | null;
  label: string;
  tab_status: string;
  source: string;
  pay_later: number;
  mode_label: string | null;
}

interface TicketLineRow {
  order_id: string;
  name: string;
  quantity: number;
  voided: number;
  note: string | null;
}

// A station's tickets of the last STATION_WINDOW_HOURS, oldest first, with
// their lines (net of voids: a line voided at the kassa shows struck through),
// the order's number and whether its tab is paid. Cancelled tabs left out.
async function listStationTickets(request: Request, env: Env, orgId: string, stationId: string): Promise<Response> {
  const caller = await member(request, env, orgId);
  if (caller instanceof Response) return caller;
  await cancelExpiredSelfOrders(env, orgId);
  await sweepPhones(env, orgId).run();
  const withDelivered = new URL(request.url).searchParams.get('delivered') === '1';
  const since = new Date(Date.now() - STATION_WINDOW_HOURS * 3600_000).toISOString();

  const { results } = await env.DB.prepare(
    `SELECT t.id, t.tab_id, t.order_id, t.status, t.created_at, t.updated_at,
       tabs.number, tabs.event_number, tabs.label, tabs.status AS tab_status, tabs.source, tabs.pay_later,
       ${MODE_LABEL_SQL('tabs')} AS mode_label
     FROM prep_tickets t JOIN tabs ON tabs.id = t.tab_id
     WHERE t.org_id = ? AND t.station_id = ? AND t.created_at >= ? AND tabs.status <> 'cancelled'
       ${withDelivered ? '' : "AND t.status <> 'delivered'"}
     ORDER BY t.created_at, t.rowid LIMIT 200`
  )
    .bind(orgId, stationId, since)
    .all<TicketRow>();
  const tickets = results || [];
  if (!tickets.length) return json([]);

  const { results: lineRows } = await env.DB.prepare(
    `SELECT l.order_id, l.name, l.quantity, l.note,
       -COALESCE((SELECT SUM(v.quantity) FROM order_lines v WHERE v.voids_line_id = l.id), 0) AS voided
     FROM order_lines l
     WHERE l.order_id IN (SELECT value FROM json_each(?)) AND l.prep_station_id = ? AND l.voids_line_id IS NULL
     ORDER BY l.created_at, l.rowid`
  )
    .bind(JSON.stringify(tickets.map((t) => t.order_id)), stationId)
    .all<TicketLineRow>();
  const byOrder = new Map<string, TicketLineRow[]>();
  for (const l of lineRows || []) byOrder.set(l.order_id, [...(byOrder.get(l.order_id) || []), l]);

  return json(
    tickets.map((t) => ({
      id: t.id,
      tabId: t.tab_id,
      status: t.status,
      createdAt: t.created_at,
      updatedAt: t.updated_at,
      // What to call out: the event's short number, else the tab's.
      number: t.event_number ?? t.number,
      label: t.label,
      paid: t.tab_status === 'closed',
      selfOrder: t.source === 'self_order',
      // On a tab paid when the guest leaves: prepared unpaid (shown even with
      // the screen's "only paid" filter on).
      payLater: !!t.pay_later,
      // Its ordering mode ("Take away") when the event has more than one —
      // information for whoever prepares it; the station got it from the
      // products' prep station, never from the mode.
      mode: t.mode_label,
      lines: (byOrder.get(t.order_id) || []).map((l) => ({ name: l.name, quantity: l.quantity, voided: l.voided, note: l.note })),
    }))
  );
}

async function setTicketStatus(request: Request, env: Env, orgId: string, ticketId: string): Promise<Response> {
  const caller = await member(request, env, orgId);
  if (caller instanceof Response) return caller;
  const body = (await request.json().catch(() => ({}))) as { status?: unknown };
  const status = String(body.status ?? '');
  if (!(TICKET_STATUSES as readonly string[]).includes(status)) return json({ error: `status must be one of ${TICKET_STATUSES.join(', ')}` }, 400);

  const row = await env.DB.prepare(
    'UPDATE prep_tickets SET status = ?, updated_at = ?, updated_by = ? WHERE id = ? AND org_id = ? RETURNING id, tab_id, status, updated_at'
  )
    .bind(status, new Date().toISOString(), caller.who, ticketId, orgId)
    .first<{ id: string; tab_id: string; status: TicketStatus; updated_at: string }>();
  if (!row) return errorJson('ticket_not_found', 404);
  notifyTabsChanged(env, orgId, [row.tab_id]);
  // Ready: the guest's SMS, if they left a number (messaging.ts).
  if (row.status === 'ready') notifyTicketReady(env, orgId, row.id);
  return json({ id: row.id, status: row.status, updatedAt: row.updated_at });
}

// Handles /organizations/:org/stations/:station/tickets and /organizations/:org/tickets/:id.
export async function dispatchPrepTicketsRoute(request: Request, env: Env, pathname: string): Promise<Response | null> {
  const list = pathname.match(/^\/organizations\/([^/]+)\/stations\/([^/]+)\/tickets$/);
  if (list && request.method === 'GET') return listStationTickets(request, env, list[1], decodeURIComponent(list[2]));
  const one = pathname.match(/^\/organizations\/([^/]+)\/tickets\/([^/]+)$/);
  if (one && request.method === 'POST') return setTicketStatus(request, env, one[1], decodeURIComponent(one[2]));
  return null;
}

// What a "follow your order" page shows (self-order.ts): per station how
// far it is, and overall — waiting for payment, being prepared, ready,
// delivered (or nothing to prepare / cancelled).
// A tab paid when leaving (payLater) follows its tickets while it's open.
export function followState(tabStatus: string, tickets: { station_name: string; status: TicketStatus }[], payLater = false) {
  const stations = tickets.map((t) => ({ name: t.station_name, status: t.status }));
  let state: 'cancelled' | 'awaiting_payment' | 'nothing_to_prepare' | 'preparing' | 'ready' | 'delivered';
  if (tabStatus === 'cancelled') state = 'cancelled';
  else if (tabStatus !== 'closed' && !payLater) state = 'awaiting_payment';
  else if (!stations.length) state = 'nothing_to_prepare';
  else if (stations.every((s) => s.status === 'delivered')) state = 'delivered';
  else if (stations.every((s) => s.status === 'ready' || s.status === 'delivered')) state = 'ready';
  else state = 'preparing';
  return { state, stations };
}
