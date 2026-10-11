// Per-org events: name + date, what tabs (and so sales) are tagged with —
// and since 2026-10-11 (DOMAIN_MODEL.md "Self-ordering and station
// screens") an event's own short order numbers, its self-ordering (on/off,
// the code in its public URL/QR, /bestel/<code>) and its ordering modes
// (bestelwijzen: "Ter plaatse", "Take away", "Alleen aan de kassa", …), each
// with its own menu, where it's used (the QR and/or the kassa), how guests
// pay and whether they order on a tab.
//
//   GET    /organizations/:org/events                          member
//   POST   /organizations/:org/events { name, date }           admin
//   PATCH  /organizations/:org/events/:id                      admin  { name?, date?, selfOrderEnabled? }
//   POST   /organizations/:org/events/:id/modes                admin  { name, catalogId?, selfOrder?, kassa?,
//                                                                       payAtCounter?, payBancontact?, tabs?, notifySms? }
//   PATCH  /organizations/:org/events/:id/modes/:mode          admin  { the same, all optional, move?: 'up' | 'down' }
//   DELETE /organizations/:org/events/:id/modes/:mode          admin
//   POST   /organizations/:org/events/:id/self-order-code      admin  a new code (the old URL/QR stops working)
//   POST   /organizations/:org/events/:id/reset-numbers        admin  the next order is #1 again
//
// Each answers with the whole event, its modes included — and whether this
// installation can send SMS at all (sms: MESSAGING_CONFIG is set).
import type { Env } from '../env';
import { codedError, errorJson } from '../errors';
import { json } from '../http';
import { extractCaller, requireOrgRole } from './auth';
import { getDecryptedPaymentCredential } from './payment-credentials';
import { smsConfig } from '../messaging';

export interface EventRow {
  id: string;
  org_id: string;
  name: string;
  event_date: string;
  created_at: string;
  self_order_enabled: number;
  self_order_code: string | null;
  order_counter: number;
}

export interface OrderModeRow {
  id: string;
  org_id: string;
  event_id: string;
  name: string;
  position: number;
  catalog_id: string | null;
  self_order: number;
  kassa: number;
  pay_counter: number;
  pay_bancontact: number;
  tabs: number;
  created_at: string;
  notify_sms: number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_MODES = 10;

function rowToMode(row: OrderModeRow) {
  return {
    id: row.id,
    name: row.name,
    catalogId: row.catalog_id,
    // Where it's used: with the event's QR code (guests order themselves), at the kassa.
    selfOrder: !!row.self_order,
    kassa: !!row.kassa,
    // With the QR: how guests pay — at the counter, and/or with Bancontact on their phone —
    // and whether they keep ordering on their tab, paying when they leave.
    payAtCounter: !!row.pay_counter,
    payBancontact: !!row.pay_bancontact,
    tabs: !!row.tabs,
    // An SMS to the guest when a station's part is ready (MESSAGING.md).
    notifySms: !!row.notify_sms,
  };
}

function rowToEvent(env: Env, row: EventRow, modes: OrderModeRow[]) {
  return {
    id: row.id,
    name: row.name,
    date: row.event_date,
    createdAt: row.created_at,
    selfOrder: { enabled: !!row.self_order_enabled, code: row.self_order_code },
    modes: modes.filter((m) => m.event_id === row.id).map(rowToMode),
    // Whether this installation sends SMS (the installer's Geavanceerd → Sms).
    sms: !!smsConfig(env),
    // The last number given out (0: the next order is #1).
    lastOrderNumber: row.order_counter,
  };
}

// 192 bits, base64url: an event's self-order URL can't be guessed.
function newSelfOrderCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_');
}

async function admin(request: Request, env: Env, orgId: string): Promise<Response | null> {
  const caller = extractCaller(request);
  if (!caller) return json({ error: 'Unauthorized' }, 401);
  if (!(await requireOrgRole(env, orgId, caller, ['admin']))) return json({ error: 'Forbidden' }, 403);
  return null;
}

async function loadEvent(env: Env, orgId: string, eventId: string): Promise<EventRow | null> {
  return env.DB.prepare('SELECT * FROM events WHERE id = ? AND org_id = ?').bind(eventId, orgId).first<EventRow>();
}

async function loadModes(env: Env, eventId: string): Promise<OrderModeRow[]> {
  const { results } = await env.DB.prepare('SELECT * FROM event_order_modes WHERE event_id = ? ORDER BY position, created_at').bind(eventId).all<OrderModeRow>();
  return results || [];
}

async function eventResponse(env: Env, orgId: string, eventId: string, status = 200): Promise<Response> {
  const event = await loadEvent(env, orgId, eventId);
  if (!event) return errorJson('event_not_found', 404);
  return json(rowToEvent(env, event, await loadModes(env, eventId)), status);
}

// A mode guests can order with: on the QR, with a menu.
const usable = (m: Pick<OrderModeRow, 'self_order' | 'catalog_id'>) => !!m.self_order && !!m.catalog_id;

export async function updateEvent(request: Request, env: Env, orgId: string, eventId: string): Promise<Response> {
  const refused = await admin(request, env, orgId);
  if (refused) return refused;
  const event = await loadEvent(env, orgId, eventId);
  if (!event) return errorJson('event_not_found', 404);
  const body = (await request.json().catch(() => ({}))) as { name?: unknown; date?: unknown; selfOrderEnabled?: unknown };

  let { name, event_date: date, self_order_enabled: enabled, self_order_code: code } = event;
  if (body.name !== undefined) {
    name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return json({ error: 'name is required' }, 400);
  }
  if (body.date !== undefined) {
    date = typeof body.date === 'string' ? body.date.trim() : '';
    if (!DATE_RE.test(date)) return json({ error: 'date must be in YYYY-MM-DD format' }, 400);
  }
  if (body.selfOrderEnabled !== undefined) enabled = body.selfOrderEnabled === true ? 1 : 0;
  // Switching it on needs a mode guests can order with.
  if (body.selfOrderEnabled === true && !(await loadModes(env, eventId)).some(usable)) return errorJson('self_order_needs_menu', 400);
  if (enabled && !code) code = newSelfOrderCode();

  await env.DB.prepare('UPDATE events SET name = ?, event_date = ?, self_order_enabled = ?, self_order_code = ? WHERE id = ?')
    .bind(name, date, enabled, code, eventId)
    .run();
  return eventResponse(env, orgId, eventId);
}

type ModeBody = Partial<Record<'name' | 'catalogId' | 'selfOrder' | 'kassa' | 'payAtCounter' | 'payBancontact' | 'tabs' | 'notifySms' | 'move', unknown>>;

// A mode's fields from a request body over what it was: a Response when refused.
async function applyModeBody(env: Env, orgId: string, mode: OrderModeRow, body: ModeBody): Promise<OrderModeRow | Response> {
  const next = { ...mode };
  if (body.name !== undefined) {
    next.name = typeof body.name === 'string' ? body.name.trim().slice(0, 40) : '';
    if (!next.name) return errorJson('order_mode_needs_name', 400);
  }
  if (body.catalogId !== undefined) {
    if (body.catalogId === null) next.catalog_id = null;
    else {
      const catalog = typeof body.catalogId === 'string' ? await env.DB.prepare('SELECT id FROM catalogs WHERE id = ? AND org_id = ? AND archived_at IS NULL').bind(body.catalogId, orgId).first<{ id: string }>() : null;
      if (!catalog) return errorJson('unknown_catalog', 400);
      next.catalog_id = catalog.id;
    }
  }
  const flag = (value: unknown, current: number) => (value === undefined ? current : value === true ? 1 : 0);
  next.self_order = flag(body.selfOrder, next.self_order);
  next.kassa = flag(body.kassa, next.kassa);
  next.pay_counter = flag(body.payAtCounter, next.pay_counter);
  next.pay_bancontact = flag(body.payBancontact, next.pay_bancontact);
  next.tabs = flag(body.tabs, next.tabs);
  next.notify_sms = flag(body.notifySms, next.notify_sms);
  if (body.notifySms === true && !smsConfig(env)) return errorJson('sms_not_configured', 400);
  // With the QR: a menu to order from (no menu: not with the QR).
  if (body.selfOrder === true && !next.catalog_id) return errorJson('self_order_needs_menu', 400);
  if (!next.catalog_id) next.self_order = 0;
  if (!next.pay_counter && !next.pay_bancontact) return errorJson('self_order_needs_payment', 400);
  // Bancontact only for an org that has it set up (Instellingen → Betalingen).
  if (body.payBancontact === true && !(await getDecryptedPaymentCredential(env, orgId, 'bancontact'))?.apiKey) return errorJson('bancontact_not_configured', 400);
  return next;
}

// After a mode changed or went: self-ordering without a mode guests can
// order with switches off (switched on again once there is one).
function selfOrderStillUsable(env: Env, eventId: string): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE events SET self_order_enabled = 0 WHERE id = ? AND self_order_enabled = 1
       AND NOT EXISTS (SELECT 1 FROM event_order_modes WHERE event_id = ? AND self_order = 1 AND catalog_id IS NOT NULL)`
  ).bind(eventId, eventId);
}

export async function createOrderMode(request: Request, env: Env, orgId: string, eventId: string): Promise<Response> {
  const refused = await admin(request, env, orgId);
  if (refused) return refused;
  if (!(await loadEvent(env, orgId, eventId))) return errorJson('event_not_found', 404);
  const modes = await loadModes(env, eventId);
  if (modes.length >= MAX_MODES) return errorJson(codedError('too_many_order_modes', { max: MAX_MODES }), 400);
  const body = (await request.json().catch(() => ({}))) as ModeBody;
  const blank: OrderModeRow = {
    id: crypto.randomUUID().replace(/-/g, ''),
    org_id: orgId,
    event_id: eventId,
    name: '',
    position: modes.length ? Math.max(...modes.map((m) => m.position)) + 1 : 0,
    catalog_id: null,
    self_order: 0,
    kassa: 1,
    pay_counter: 1,
    pay_bancontact: 0,
    tabs: 0,
    created_at: new Date().toISOString(),
    notify_sms: 0,
  };
  // With a menu, guests order with it by default.
  const mode = await applyModeBody(env, orgId, blank, { selfOrder: typeof body.catalogId === 'string', ...body, name: body.name ?? '' });
  if (mode instanceof Response) return mode;
  await env.DB.prepare(
    `INSERT INTO event_order_modes (id, org_id, event_id, name, position, catalog_id, self_order, kassa, pay_counter, pay_bancontact, tabs, created_at, notify_sms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(mode.id, orgId, eventId, mode.name, mode.position, mode.catalog_id, mode.self_order, mode.kassa, mode.pay_counter, mode.pay_bancontact, mode.tabs, mode.created_at, mode.notify_sms)
    .run();
  return eventResponse(env, orgId, eventId, 201);
}

export async function updateOrderMode(request: Request, env: Env, orgId: string, eventId: string, modeId: string): Promise<Response> {
  const refused = await admin(request, env, orgId);
  if (refused) return refused;
  const modes = await loadModes(env, eventId);
  const index = modes.findIndex((m) => m.id === modeId && m.org_id === orgId);
  if (index < 0) return errorJson('order_mode_not_found', 404);
  const body = (await request.json().catch(() => ({}))) as ModeBody;
  const mode = await applyModeBody(env, orgId, modes[index], body);
  if (mode instanceof Response) return mode;

  const statements = [
    env.DB.prepare(
      'UPDATE event_order_modes SET name = ?, catalog_id = ?, self_order = ?, kassa = ?, pay_counter = ?, pay_bancontact = ?, tabs = ?, notify_sms = ? WHERE id = ?'
    ).bind(mode.name, mode.catalog_id, mode.self_order, mode.kassa, mode.pay_counter, mode.pay_bancontact, mode.tabs, mode.notify_sms, modeId),
  ];
  // Up or down a place: swapped with its neighbour (the order guests choose from).
  const other = body.move === 'up' ? modes[index - 1] : body.move === 'down' ? modes[index + 1] : undefined;
  if (other) {
    const order = modes.map((m) => m.id);
    order.splice(order.indexOf(other.id), 1, modeId);
    order.splice(index, 1, other.id);
    statements.push(
      env.DB.prepare(
        'UPDATE event_order_modes SET position = (SELECT key FROM json_each(?) WHERE value = event_order_modes.id) WHERE event_id = ?'
      ).bind(JSON.stringify(order), eventId)
    );
  }
  statements.push(selfOrderStillUsable(env, eventId));
  await env.DB.batch(statements);
  return eventResponse(env, orgId, eventId);
}

// Removing a mode leaves the orders that came in by it as they are (their
// mode's name is on them); a guest's open tab of it takes no more rounds.
export async function deleteOrderMode(request: Request, env: Env, orgId: string, eventId: string, modeId: string): Promise<Response> {
  const refused = await admin(request, env, orgId);
  if (refused) return refused;
  const [removed] = await env.DB.batch([
    env.DB.prepare('DELETE FROM event_order_modes WHERE id = ? AND event_id = ? AND org_id = ?').bind(modeId, eventId, orgId),
    selfOrderStillUsable(env, eventId),
  ]);
  if (!removed.meta.changes) return errorJson('order_mode_not_found', 404);
  return eventResponse(env, orgId, eventId);
}

export async function newEventSelfOrderCode(request: Request, env: Env, orgId: string, eventId: string): Promise<Response> {
  const refused = await admin(request, env, orgId);
  if (refused) return refused;
  const res = await env.DB.prepare('UPDATE events SET self_order_code = ? WHERE id = ? AND org_id = ?').bind(newSelfOrderCode(), eventId, orgId).run();
  if (!res.meta.changes) return errorJson('event_not_found', 404);
  return eventResponse(env, orgId, eventId);
}

// The next order is #1 again (openTab skips numbers an open tab still uses).
export async function resetEventNumbers(request: Request, env: Env, orgId: string, eventId: string): Promise<Response> {
  const refused = await admin(request, env, orgId);
  if (refused) return refused;
  const res = await env.DB.prepare('UPDATE events SET order_counter = 0 WHERE id = ? AND org_id = ?').bind(eventId, orgId).run();
  if (!res.meta.changes) return errorJson('event_not_found', 404);
  return eventResponse(env, orgId, eventId);
}

// Listing is open to any active member (a cashier should be able to see
// what events exist, same reasoning as listMembers) — only creating one is
// admin-only.
export async function listEvents(request: Request, env: Env, orgId: string): Promise<Response> {
  const caller = extractCaller(request);
  if (!caller) return json({ error: 'Unauthorized' }, 401);

  const membership = await requireOrgRole(env, orgId, caller, ['admin', 'cashier']);
  if (!membership) return json({ error: 'Forbidden' }, 403);

  const [events, modes] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM events WHERE org_id = ? ORDER BY event_date DESC').bind(orgId),
    env.DB.prepare('SELECT * FROM event_order_modes WHERE org_id = ? ORDER BY position, created_at').bind(orgId),
  ]);
  const modeRows = (modes.results || []) as OrderModeRow[];
  return json(((events.results || []) as EventRow[]).map((e) => rowToEvent(env, e, modeRows)));
}

export async function createEvent(request: Request, env: Env, orgId: string): Promise<Response> {
  const caller = extractCaller(request);
  if (!caller) return json({ error: 'Unauthorized' }, 401);

  const membership = await requireOrgRole(env, orgId, caller, ['admin']);
  if (!membership) return json({ error: 'Forbidden' }, 403);

  const body = (await request.json().catch(() => ({}))) as { name?: string; date?: string };
  const name = (body.name || '').trim();
  const date = (body.date || '').trim();

  if (!name) return json({ error: 'name is required' }, 400);
  if (!DATE_RE.test(date)) return json({ error: 'date must be in YYYY-MM-DD format' }, 400);

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await env.DB.prepare('INSERT INTO events (id, org_id, name, event_date, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, orgId, name, date, now)
    .run();

  return eventResponse(env, orgId, id, 201);
}
