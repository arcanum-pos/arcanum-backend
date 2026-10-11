// Per-org events: name + date, what tabs (and so sales) are tagged with —
// and since 2026-10-11 (DOMAIN_MODEL.md "Self-ordering and station
// screens") an event's own short order numbers and its self-ordering: a
// menu, on/off, and the code in its public URL/QR (/bestel/<code>).
//
//   GET   /organizations/:org/events                          member
//   POST  /organizations/:org/events { name, date }           admin
//   PATCH /organizations/:org/events/:id                      admin  { name?, date?, catalogId?, selfOrderEnabled?,
//                                                                     payAtCounter?, payBancontact? (how guests pay),
//                                                                     tabs? (keep ordering on a tab, pay when leaving) }
//   POST  /organizations/:org/events/:id/self-order-code      admin  a new code (the old URL/QR stops working)
//   POST  /organizations/:org/events/:id/reset-numbers        admin  the next order is #1 again
import type { Env } from '../env';
import { errorJson } from '../errors';
import { json } from '../http';
import { extractCaller, requireOrgRole } from './auth';
import { getDecryptedPaymentCredential } from './payment-credentials';

export interface EventRow {
  id: string;
  org_id: string;
  name: string;
  event_date: string;
  created_at: string;
  catalog_id: string | null;
  self_order_enabled: number;
  self_order_code: string | null;
  order_counter: number;
  self_order_pay_counter: number;
  self_order_pay_bancontact: number;
  self_order_tabs: number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function rowToEvent(row: EventRow) {
  return {
    id: row.id,
    name: row.name,
    date: row.event_date,
    createdAt: row.created_at,
    catalogId: row.catalog_id,
    selfOrder: {
      enabled: !!row.self_order_enabled,
      code: row.self_order_code,
      // How guests may pay: at the counter, and/or with Bancontact on their phone.
      payAtCounter: !!row.self_order_pay_counter,
      payBancontact: !!row.self_order_pay_bancontact,
      // Guests keep ordering on their tab and pay when they leave.
      tabs: !!row.self_order_tabs,
    },
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

export async function updateEvent(request: Request, env: Env, orgId: string, eventId: string): Promise<Response> {
  const refused = await admin(request, env, orgId);
  if (refused) return refused;
  const event = await loadEvent(env, orgId, eventId);
  if (!event) return errorJson('event_not_found', 404);
  const body = (await request.json().catch(() => ({}))) as {
    name?: unknown;
    date?: unknown;
    catalogId?: unknown;
    selfOrderEnabled?: unknown;
    payAtCounter?: unknown;
    payBancontact?: unknown;
    tabs?: unknown;
  };

  let { name, event_date: date, catalog_id: catalogId, self_order_enabled: enabled, self_order_code: code } = event;
  let { self_order_pay_counter: payCounter, self_order_pay_bancontact: payBancontact, self_order_tabs: tabs } = event;
  if (body.name !== undefined) {
    name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return json({ error: 'name is required' }, 400);
  }
  if (body.date !== undefined) {
    date = typeof body.date === 'string' ? body.date.trim() : '';
    if (!DATE_RE.test(date)) return json({ error: 'date must be in YYYY-MM-DD format' }, 400);
  }
  if (body.catalogId !== undefined) {
    if (body.catalogId === null) catalogId = null;
    else {
      const catalog = typeof body.catalogId === 'string' ? await env.DB.prepare('SELECT id FROM catalogs WHERE id = ? AND org_id = ? AND archived_at IS NULL').bind(body.catalogId, orgId).first<{ id: string }>() : null;
      if (!catalog) return errorJson('unknown_catalog', 400);
      catalogId = catalog.id;
    }
  }
  if (body.selfOrderEnabled !== undefined) enabled = body.selfOrderEnabled === true ? 1 : 0;
  if (body.payAtCounter !== undefined) payCounter = body.payAtCounter === true ? 1 : 0;
  if (body.payBancontact !== undefined) payBancontact = body.payBancontact === true ? 1 : 0;
  if (body.tabs !== undefined) tabs = body.tabs === true ? 1 : 0;
  if (enabled && !catalogId) return errorJson('self_order_needs_menu', 400);
  if (!payCounter && !payBancontact) return errorJson('self_order_needs_payment', 400);
  // Bancontact only for an org that has it set up (Instellingen → Betalingen).
  if (body.payBancontact === true && !(await getDecryptedPaymentCredential(env, orgId, 'bancontact'))?.apiKey) return errorJson('bancontact_not_configured', 400);
  if (enabled && !code) code = newSelfOrderCode();

  await env.DB.prepare(
    'UPDATE events SET name = ?, event_date = ?, catalog_id = ?, self_order_enabled = ?, self_order_code = ?, self_order_pay_counter = ?, self_order_pay_bancontact = ?, self_order_tabs = ? WHERE id = ?'
  )
    .bind(name, date, catalogId, enabled, code, payCounter, payBancontact, tabs, eventId)
    .run();
  return json(rowToEvent((await loadEvent(env, orgId, eventId))!));
}

export async function newEventSelfOrderCode(request: Request, env: Env, orgId: string, eventId: string): Promise<Response> {
  const refused = await admin(request, env, orgId);
  if (refused) return refused;
  const res = await env.DB.prepare('UPDATE events SET self_order_code = ? WHERE id = ? AND org_id = ?').bind(newSelfOrderCode(), eventId, orgId).run();
  if (!res.meta.changes) return errorJson('event_not_found', 404);
  return json(rowToEvent((await loadEvent(env, orgId, eventId))!));
}

// The next order is #1 again (openTab skips numbers an open tab still uses).
export async function resetEventNumbers(request: Request, env: Env, orgId: string, eventId: string): Promise<Response> {
  const refused = await admin(request, env, orgId);
  if (refused) return refused;
  const res = await env.DB.prepare('UPDATE events SET order_counter = 0 WHERE id = ? AND org_id = ?').bind(eventId, orgId).run();
  if (!res.meta.changes) return errorJson('event_not_found', 404);
  return json(rowToEvent((await loadEvent(env, orgId, eventId))!));
}

// Listing is open to any active member (a cashier should be able to see
// what events exist, same reasoning as listMembers) — only creating one is
// admin-only.
export async function listEvents(request: Request, env: Env, orgId: string): Promise<Response> {
  const caller = extractCaller(request);
  if (!caller) return json({ error: 'Unauthorized' }, 401);

  const membership = await requireOrgRole(env, orgId, caller, ['admin', 'cashier']);
  if (!membership) return json({ error: 'Forbidden' }, 403);

  const { results } = await env.DB.prepare('SELECT * FROM events WHERE org_id = ? ORDER BY event_date DESC').bind(orgId).all<EventRow>();
  return json((results || []).map(rowToEvent));
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

  const row = await env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(id).first<EventRow>();
  return json(rowToEvent(row!), 201);
}
