// Self-ordering — DOMAIN_MODEL.md "Self-ordering and station screens". The
// only routes in this Worker that answer someone who isn't signed in: a
// guest who scanned an event's QR code. arcanum-bff forwards /api/public/*
// here without a session (and clears any identity headers a client sent).
//
//   GET  /public/self-order/:code          the event's menu (what a kassa could sell from it), or closed
//   POST /public/self-order/:code/orders   { lines: [{ variantId, quantity, note? }] }
//                                          → 201 { token, number }: a new tab (source self_order)
//   GET  /public/orders/:token             a "follow your order" page: number, lines, state
//                                          per station, how it can be paid, and a ticket for
//                                          devicehub's order hub
//   POST /public/orders/:token/bancontact  pay it with Bancontact (when the event allows it):
//                                          → { deeplinkUrl, checkoutUrl, qrCodeUrl } — the app opens,
//                                          and sends the phone back to /volg/<token>
//
// The code (in the event's URL/QR) and the token (in a follow page's URL)
// are long random strings: nothing here can be listed or guessed. Abuse is
// bounded per order (MAX_*), per event (MAX_UNPAID), and in time (an unpaid
// self-order is cancelled after SELF_ORDER_PAY_MINUTES) — and station
// screens only show paid orders by default. No per-IP limit: a venue's
// Wi-Fi or a mobile network puts many guests behind one address.
import type { Env } from './env';
import { codedError, errorBody, errorJson } from './errors';
import { json } from './http';
import { sellableCatalog } from './catalog';
import { orderHubTicket } from './devicehub-client';
import { cancelExpiredSelfOrders, followState, type TicketStatus } from './prep-tickets';
import { openAmount, openTab, prepareOrderLines, prepareTabChargeFor } from './tabs';
import { getDecryptedPaymentCredential } from './organizations/payment-credentials';
import { startBancontactPayment } from './payments/bancontact';

const MAX_LINES = 30;
const MAX_QUANTITY = 20;
// Unpaid self-orders open at once, per event: beyond this, "too busy".
const MAX_UNPAID = 100;

interface SelfOrderEvent {
  id: string;
  org_id: string;
  name: string;
  catalog_id: string | null;
  self_order_enabled: number;
  self_order_pay_counter: number;
  self_order_pay_bancontact: number;
  org_name: string;
  org_locale: string | null;
}

// How guests of this event may pay: at the counter, and/or with Bancontact —
// the latter only while the org has Bancontact set up.
async function paymentOptions(env: Env, e: { org_id: string; self_order_pay_counter: number | null; self_order_pay_bancontact: number | null }) {
  const bancontact = !!e.self_order_pay_bancontact && !!(await getDecryptedPaymentCredential(env, e.org_id, 'bancontact'))?.apiKey;
  return { counter: !!e.self_order_pay_counter || !bancontact, bancontact };
}

async function eventByCode(env: Env, code: string): Promise<SelfOrderEvent | null> {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(code)) return null;
  return env.DB.prepare(
    `SELECT e.id, e.org_id, e.name, e.catalog_id, e.self_order_enabled, e.self_order_pay_counter, e.self_order_pay_bancontact, o.name AS org_name, o.locale AS org_locale
     FROM events e JOIN organizations o ON o.id = e.org_id WHERE e.self_order_code = ?`
  )
    .bind(code)
    .first<SelfOrderEvent>();
}

const isOpen = (e: SelfOrderEvent | null): e is SelfOrderEvent & { catalog_id: string } => !!e && !!e.self_order_enabled && !!e.catalog_id;

async function menu(env: Env, code: string): Promise<Response> {
  const event = await eventByCode(env, code);
  if (!event) return errorJson('self_order_closed', 404);
  const base = { eventName: event.name, orgName: event.org_name, locale: event.org_locale || 'nl' };
  if (!isOpen(event)) return json({ ...base, open: false, catalog: null });
  const catalog = await sellableCatalog(env, event.org_id, event.catalog_id);
  if (!catalog) return json({ ...base, open: false, catalog: null });
  return json({
    ...base,
    open: true,
    payment: await paymentOptions(env, event),
    catalog: {
      id: catalog.id,
      sections: catalog.sections.map((s) => ({ id: s.id, name: s.name, entries: s.entries.map((e) => ({ variantId: e.variantId, name: e.name, priceCents: e.priceCents })) })),
    },
  });
}

async function placeOrder(request: Request, env: Env, code: string): Promise<Response> {
  const event = await eventByCode(env, code);
  if (!isOpen(event)) return errorJson('self_order_closed', 409);
  const body = (await request.json().catch(() => ({}))) as { lines?: unknown };
  const raw = Array.isArray(body.lines) ? body.lines : [];
  if (raw.length > MAX_LINES || raw.some((l) => Number((l as { quantity?: unknown })?.quantity) > MAX_QUANTITY)) return errorJson('self_order_too_large', 400);

  await cancelExpiredSelfOrders(env, event.org_id);
  const unpaid = await env.DB.prepare(`SELECT COUNT(*) AS n FROM tabs WHERE event_id = ? AND source = 'self_order' AND status = 'open'`)
    .bind(event.id)
    .first<{ n: number }>();
  if ((unpaid?.n ?? 0) >= MAX_UNPAID) return errorJson('self_order_busy', 429);

  // Priced from the event's menu, like any kassa order: a guest never sets a price.
  const prepared = await prepareOrderLines(env, event.org_id, { lines: raw, catalogId: event.catalog_id });
  if (typeof prepared === 'string' || 'code' in prepared) return json(errorBody(typeof prepared === 'string' ? codedError('self_order_too_large') : prepared), 400);

  const tabId = await openTab(env, {
    orgId: event.org_id,
    label: '',
    slotId: null,
    eventId: event.id,
    who: { deviceId: null, deviceName: null, userName: null, userEmail: null },
    source: 'self_order',
    lines: prepared.lines,
    catalogId: prepared.catalogId,
  });
  const tab = await env.DB.prepare('SELECT order_token, event_number FROM tabs WHERE id = ?').bind(tabId).first<{ order_token: string; event_number: number }>();
  return json({ token: tab!.order_token, number: tab!.event_number }, 201);
}

interface FollowTab {
  id: string;
  org_id: string;
  number: number;
  event_number: number | null;
  status: string;
  source: string;
  opened_at: string;
  event_name: string | null;
  self_order_code: string | null;
  self_order_enabled: number | null;
  self_order_pay_counter: number | null;
  self_order_pay_bancontact: number | null;
  org_name: string;
  org_locale: string | null;
}

async function follow(env: Env, token: string): Promise<Response> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return errorJson('order_not_found', 404);
  const tab = await env.DB.prepare(
    `SELECT t.id, t.org_id, t.number, t.event_number, t.status, t.source, t.opened_at, e.name AS event_name, e.self_order_code, e.self_order_enabled,
       e.self_order_pay_counter, e.self_order_pay_bancontact, o.name AS org_name, o.locale AS org_locale
     FROM tabs t JOIN organizations o ON o.id = t.org_id LEFT JOIN events e ON e.id = t.event_id WHERE t.order_token = ?`
  )
    .bind(token)
    .first<FollowTab>();
  if (!tab) return errorJson('order_not_found', 404);
  if (tab.source === 'self_order' && tab.status === 'open') await cancelExpiredSelfOrders(env, tab.org_id);

  const [current, tickets, lines, charges] = await env.DB.batch([
    env.DB.prepare('SELECT status FROM tabs WHERE id = ?').bind(tab.id),
    env.DB.prepare('SELECT station_name, status FROM prep_tickets WHERE tab_id = ? ORDER BY created_at, station_name').bind(tab.id),
    env.DB.prepare(
      `SELECT l.name, l.unit_price_cents, l.quantity + COALESCE((SELECT SUM(v.quantity) FROM order_lines v WHERE v.voids_line_id = l.id), 0) AS quantity
       FROM order_lines l WHERE l.tab_id = ? AND l.voids_line_id IS NULL ORDER BY l.created_at, l.rowid`
    ).bind(tab.id),
    env.DB.prepare('SELECT method, status FROM charges WHERE tab_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').bind(tab.id),
  ]);
  const lastCharge = ((charges.results || [])[0] ?? null) as { method: string; status: string } | null;
  const status = ((current.results || [])[0] as { status: string } | undefined)?.status ?? tab.status;
  // Several orders on one tab can each have a ticket for the same station:
  // per station, the least advanced one is how far it is.
  const order: TicketStatus[] = ['ordered', 'in_progress', 'ready', 'delivered'];
  const perStation = new Map<string, TicketStatus>();
  for (const t of (tickets.results || []) as { station_name: string; status: TicketStatus }[]) {
    const known = perStation.get(t.station_name);
    if (!known || order.indexOf(t.status) < order.indexOf(known)) perStation.set(t.station_name, t.status);
  }
  const { state, stations } = followState(status, [...perStation].map(([station_name, s]) => ({ station_name, status: s })));
  const shown = ((lines.results || []) as { name: string; unit_price_cents: number; quantity: number }[]).filter((l) => l.quantity > 0);

  return json({
    number: tab.event_number ?? tab.number,
    eventName: tab.event_name,
    orgName: tab.org_name,
    locale: tab.org_locale || 'nl',
    selfOrder: tab.source === 'self_order',
    state,
    stations,
    lines: shown.map((l) => ({ name: l.name, quantity: l.quantity, unitPriceCents: l.unit_price_cents })),
    totalCents: shown.reduce((sum, l) => sum + l.quantity * l.unit_price_cents, 0),
    // While it's waiting for payment: how it can be paid, a payment in
    // progress, the last one failed.
    payment:
      state === 'awaiting_payment' && tab.source === 'self_order'
        ? { ...(await paymentOptions(env, tab)), pending: lastCharge?.status === 'pending', failed: lastCharge?.status === 'failed' }
        : null,
    // Back to step 1 of this event's self-order page once it's all delivered.
    selfOrderCode: tab.self_order_enabled ? tab.self_order_code : null,
    // Live updates: devicehub's order hub, this tab only (null: no live updates).
    hubTicket: state === 'delivered' || state === 'cancelled' || state === 'nothing_to_prepare' ? null : await orderHubTicket(env, tab.org_id, tab.id),
  });
}

// A guest pays their own self-order with Bancontact: exactly what's open on
// it, no tip. A payment already in progress is handed out again (a second
// tap, or back from the app before it's done) rather than starting another.
async function payBancontact(env: Env, token: string): Promise<Response> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return errorJson('order_not_found', 404);
  const tab = await env.DB.prepare(
    `SELECT t.id, t.org_id, t.number, t.event_number, t.status, t.source, e.self_order_pay_counter, e.self_order_pay_bancontact, o.name AS org_name
     FROM tabs t JOIN organizations o ON o.id = t.org_id LEFT JOIN events e ON e.id = t.event_id WHERE t.order_token = ?`
  )
    .bind(token)
    .first<{ id: string; org_id: string; number: number; event_number: number | null; status: string; source: string; self_order_pay_counter: number | null; self_order_pay_bancontact: number | null; org_name: string }>();
  if (!tab) return errorJson('order_not_found', 404);
  if (tab.source !== 'self_order' || !(await paymentOptions(env, tab)).bancontact) return errorJson('self_order_payment_unavailable', 409);

  const pending = await env.DB.prepare(`SELECT provider_data FROM charges WHERE tab_id = ? AND status = 'pending' AND method = 'bancontact'`)
    .bind(tab.id)
    .first<{ provider_data: string | null }>();
  if (pending) {
    const links = JSON.parse(pending.provider_data || '{}') as { deeplinkUrl?: string; checkoutUrl?: string; qrCodeUrl?: string };
    return json({ deeplinkUrl: links.deeplinkUrl ?? null, checkoutUrl: links.checkoutUrl ?? null, qrCodeUrl: links.qrCodeUrl ?? null });
  }

  const amount = await openAmount(env, tab.org_id, tab.id);
  if (amount === null) return errorJson('tab_not_open', 409);
  const prepared = await prepareTabChargeFor(env, tab.org_id, tab.id, amount, 0);
  if (!prepared.ok) return prepared.response;
  const res = await startBancontactPayment(env, {
    orgId: tab.org_id,
    amountCents: amount,
    tipCents: 0,
    description: `${tab.org_name} #${tab.event_number ?? tab.number}`.slice(0, 140),
    items: prepared.context.items,
    tabId: tab.id,
    splitPart: 0,
    lines: [],
    posTerminalId: null,
    slotId: null,
    deviceId: null,
    deviceName: null,
    userName: null,
    userEmail: null,
    returnUrl: `${env.PUBLIC_BASE_URL}/volg/${token}`,
  });
  if (!res.ok) return res;
  const data = (await res.json()) as { deeplinkUrl?: string; checkoutUrl?: string; qrCodeUrl?: string };
  return json({ deeplinkUrl: data.deeplinkUrl ?? null, checkoutUrl: data.checkoutUrl ?? null, qrCodeUrl: data.qrCodeUrl ?? null }, 201);
}

// Handles /public/*. Returns null for anything it doesn't recognize.
export async function dispatchSelfOrderRoute(request: Request, env: Env, pathname: string): Promise<Response | null> {
  const menuMatch = pathname.match(/^\/public\/self-order\/([^/]+)$/);
  if (menuMatch && request.method === 'GET') return menu(env, menuMatch[1]);
  const orderMatch = pathname.match(/^\/public\/self-order\/([^/]+)\/orders$/);
  if (orderMatch && request.method === 'POST') return placeOrder(request, env, orderMatch[1]);
  const followMatch = pathname.match(/^\/public\/orders\/([^/]+)$/);
  if (followMatch && request.method === 'GET') return follow(env, followMatch[1]);
  const payMatch = pathname.match(/^\/public\/orders\/([^/]+)\/bancontact$/);
  if (payMatch && request.method === 'POST') return payBancontact(env, payMatch[1]);
  return null;
}
