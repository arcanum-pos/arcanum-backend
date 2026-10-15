// Self-ordering — DOMAIN_MODEL.md "Self-ordering and station screens". The
// only routes in this Worker that answer someone who isn't signed in: a
// guest who scanned an event's QR code. arcanum-bff forwards /api/public/*
// here without a session (and clears any identity headers a client sent).
//
//   GET  /public/self-order/:code          the event's ordering modes guests can use (each its menu —
//                                          what a kassa could sell from it — and how to pay), or closed
//   POST /public/self-order/:code/orders   { modeId?, lines: [{ variantId, quantity, note? }],
//                                            contact?: { name, phone?, email? } (a tab whose mode asks it) }
//                                          → 201 { token, number }: a new tab (source self_order);
//                                          modeId may be left out when there's only one mode
//   GET  /public/orders/:token             a "follow your order" page: number, lines, state
//                                          per station, how it can be paid, and a ticket for
//                                          devicehub's order hub
//   POST /public/orders/:token/orders      { lines } — one more round on a tab paid when leaving
//                                          (when its ordering mode lets guests order on a tab)
//   POST /public/orders/:token/notify      { phone } — an SMS when a station's part is ready
//   DELETE /public/orders/:token/notify      (when its ordering mode has SMS on — MESSAGING.md); no SMS after all
//   POST /public/orders/:token/bancontact  pay it with Bancontact (when its ordering mode allows it):
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
import { codedError, errorBody, errorJson, type CodedError } from './errors';
import { json } from './http';
import { sellableCatalog } from './catalog';
import { orderHubTicket } from './devicehub-client';
import { cancelExpiredSelfOrders, followState, MODE_LABEL_SQL, type TicketStatus } from './prep-tickets';
import { addOrderToTab, openAmount, openTab, prepareOrderLines, prepareTabChargeFor } from './tabs';
import { getDecryptedPaymentCredential } from './organizations/payment-credentials';
import { startBancontactPayment } from './payments/bancontact';
import { maskPhone, normalizePhone, smsConfig } from './messaging';

const MAX_LINES = 30;
const MAX_QUANTITY = 20;
// Unpaid self-orders open at once, per event: beyond this, "too busy".
const MAX_UNPAID = 100;

interface SelfOrderEvent {
  id: string;
  org_id: string;
  name: string;
  self_order_enabled: number;
  org_name: string;
  org_locale: string | null;
}

// An ordering mode guests use with the event's QR (event_order_modes).
interface SelfOrderMode {
  id: string;
  name: string;
  catalog_id: string;
  pay_counter: number;
  pay_bancontact: number;
  tabs: number;
  tab_contact: number;
  notify_sms: number;
}

// How guests may pay in an ordering mode: at the counter, and/or with
// Bancontact — the latter only while the org has Bancontact set up. No mode
// (removed meanwhile): the counter.
async function paymentOptions(env: Env, orgId: string, m: { pay_counter: number | null; pay_bancontact: number | null }) {
  const bancontact = !!m.pay_bancontact && !!(await getDecryptedPaymentCredential(env, orgId, 'bancontact'))?.apiKey;
  return { counter: !!m.pay_counter || !bancontact, bancontact };
}

async function eventByCode(env: Env, code: string): Promise<SelfOrderEvent | null> {
  // The long code, or the readable link (<name>-<4 characters>).
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(code)) return null;
  return env.DB.prepare(
    `SELECT e.id, e.org_id, e.name, e.self_order_enabled, o.name AS org_name, o.locale AS org_locale
     FROM events e JOIN organizations o ON o.id = e.org_id WHERE e.self_order_code = ? OR e.self_order_slug = ?`
  )
    .bind(code, code.toLowerCase())
    .first<SelfOrderEvent>();
}

// The event's modes guests can order with, in the order they choose from.
async function selfOrderModes(env: Env, eventId: string): Promise<SelfOrderMode[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, name, catalog_id, pay_counter, pay_bancontact, tabs, tab_contact, notify_sms FROM event_order_modes
     WHERE event_id = ? AND self_order = 1 AND catalog_id IS NOT NULL ORDER BY position, created_at`
  )
    .bind(eventId)
    .all<SelfOrderMode>();
  return results || [];
}

async function menu(env: Env, code: string): Promise<Response> {
  const event = await eventByCode(env, code);
  if (!event) return errorJson('self_order_closed', 404);
  const base = { eventName: event.name, orgName: event.org_name, locale: event.org_locale || 'nl' };
  const closed = json({ ...base, open: false, modes: [] });
  if (!event.self_order_enabled) return closed;
  const modes = [];
  // Bancontact's settings read once, a menu shared by modes fetched once
  // (Free plan: at most 50 queries per request).
  const bancontact = !!(await getDecryptedPaymentCredential(env, event.org_id, 'bancontact'))?.apiKey;
  const catalogs = new Map<string, Awaited<ReturnType<typeof sellableCatalog>>>();
  for (const mode of await selfOrderModes(env, event.id)) {
    if (!catalogs.has(mode.catalog_id)) catalogs.set(mode.catalog_id, await sellableCatalog(env, event.org_id, mode.catalog_id));
    const catalog = catalogs.get(mode.catalog_id);
    if (!catalog) continue;
    const payBancontact = !!mode.pay_bancontact && bancontact;
    modes.push({
      id: mode.id,
      name: mode.name,
      // tab: guests keep ordering on their tab and pay when they leave.
      payment: { counter: !!mode.pay_counter || !payBancontact, bancontact: payBancontact, tab: !!mode.tabs },
      // On a tab: a name and a mobile number or e-mail asked when it opens.
      contact: !!mode.tabs && !!mode.tab_contact,
      catalog: {
        id: catalog.id,
        sections: catalog.sections.map((s) => ({ id: s.id, name: s.name, entries: s.entries.map((e) => ({ variantId: e.variantId, name: e.name, priceCents: e.priceCents })) })),
      },
    });
  }
  if (!modes.length) return closed;
  return json({ ...base, open: true, modes });
}

async function placeOrder(request: Request, env: Env, code: string): Promise<Response> {
  const event = await eventByCode(env, code);
  if (!event || !event.self_order_enabled) return errorJson('self_order_closed', 409);
  const modes = await selfOrderModes(env, event.id);
  if (!modes.length) return errorJson('self_order_closed', 409);
  const body = (await request.json().catch(() => ({}))) as { modeId?: unknown; lines?: unknown; contact?: unknown };
  // Which mode: the one asked for; left out, the only one there is.
  const mode = body.modeId === undefined || body.modeId === null ? (modes.length === 1 ? modes[0] : null) : modes.find((m) => m.id === body.modeId);
  if (!mode) return errorJson(body.modeId === undefined || body.modeId === null ? 'order_mode_required' : 'unknown_order_mode', 400);
  const raw = Array.isArray(body.lines) ? body.lines : [];
  if (raw.length > MAX_LINES || raw.some((l) => Number((l as { quantity?: unknown })?.quantity) > MAX_QUANTITY)) return errorJson('self_order_too_large', 400);
  const contact = mode.tabs && mode.tab_contact ? readContact(env, body.contact) : null;
  if (contact && 'code' in contact) return errorJson(contact, 400);

  await cancelExpiredSelfOrders(env, event.org_id);
  // Tabs paid when leaving are unpaid on purpose: not counted.
  const unpaid = await env.DB.prepare(`SELECT COUNT(*) AS n FROM tabs WHERE event_id = ? AND source = 'self_order' AND pay_later = 0 AND status = 'open'`)
    .bind(event.id)
    .first<{ n: number }>();
  if ((unpaid?.n ?? 0) >= MAX_UNPAID) return errorJson('self_order_busy', 429);

  // Priced from the mode's menu, like any kassa order: a guest never sets a price.
  const prepared = await prepareOrderLines(env, event.org_id, { lines: raw, catalogId: mode.catalog_id });
  if (typeof prepared === 'string' || 'code' in prepared) return json(errorBody(typeof prepared === 'string' ? codedError('self_order_too_large') : prepared), 400);

  const tabId = await openTab(env, {
    orgId: event.org_id,
    // Its guest's name, when the mode asks it: what the kassa calls the tab.
    label: contact?.name ?? '',
    slotId: null,
    eventId: event.id,
    who: { deviceId: null, deviceName: null, userName: null, userEmail: null },
    source: 'self_order',
    lines: prepared.lines,
    catalogId: prepared.catalogId,
    payLater: !!mode.tabs,
    orderMode: { id: mode.id, name: mode.name },
  });
  if (contact) {
    // Not verified; kept only while the tab is open (tabs.ts sweepContacts).
    // A number given here also gets the "ready" SMS, when the mode sends them.
    const sms = contact.phone && mode.notify_sms && smsConfig(env) ? contact.phone : null;
    await env.DB.prepare('UPDATE tabs SET contact_phone = ?, contact_email = ?, notify_phone = COALESCE(?, notify_phone) WHERE id = ?')
      .bind(contact.phone, contact.email, sms, tabId)
      .run();
  }
  const tab = await env.DB.prepare('SELECT order_token, event_number FROM tabs WHERE id = ?').bind(tabId).first<{ order_token: string; event_number: number }>();
  return json({ token: tab!.order_token, number: tab!.event_number }, 201);
}

// Who's behind a tab (an ordering mode that asks it): a name, and a mobile
// number or e-mail — at least one. Not verified (no codes to send, no cost):
// enough to find the guest back if the tab is left unpaid.
function readContact(env: Env, raw: unknown): { name: string; phone: string | null; email: string | null } | CodedError {
  const c = (raw && typeof raw === 'object' ? raw : {}) as { name?: unknown; phone?: unknown; email?: unknown };
  const name = typeof c.name === 'string' ? c.name.trim().slice(0, 40) : '';
  if (!name) return codedError('tab_contact_name');
  const phoneText = typeof c.phone === 'string' ? c.phone.trim() : '';
  const emailText = typeof c.email === 'string' ? c.email.trim().toLowerCase() : '';
  if (!phoneText && !emailText) return codedError('tab_contact_reach');
  const countries = smsConfig(env)?.countries ?? ['+32'];
  const phone = phoneText ? normalizePhone(phoneText, countries) : null;
  if (phoneText && !phone) return codedError('invalid_phone', { countries: countries.join(', ') });
  if (emailText && (emailText.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailText))) return codedError('invalid_email');
  return { name, phone, email: emailText || null };
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
  self_order_slug: string | null;
  self_order_enabled: number | null;
  order_mode_id: string | null;
  mode_label: string | null;
  pay_counter: number | null;
  pay_bancontact: number | null;
  notify_sms: number | null;
  notify_phone: string | null;
  pay_later: number;
  org_name: string;
  org_locale: string | null;
}

async function follow(env: Env, token: string): Promise<Response> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return errorJson('order_not_found', 404);
  const tab = await env.DB.prepare(
    `SELECT t.id, t.org_id, t.number, t.event_number, t.status, t.source, t.opened_at, t.pay_later, t.order_mode_id, ${MODE_LABEL_SQL('t')} AS mode_label,
       e.name AS event_name, e.self_order_code, e.self_order_slug, e.self_order_enabled, m.pay_counter, m.pay_bancontact, m.notify_sms, t.notify_phone,
       o.name AS org_name, o.locale AS org_locale
     FROM tabs t JOIN organizations o ON o.id = t.org_id LEFT JOIN events e ON e.id = t.event_id
       LEFT JOIN event_order_modes m ON m.id = t.order_mode_id WHERE t.order_token = ?`
  )
    .bind(token)
    .first<FollowTab>();
  if (!tab) return errorJson('order_not_found', 404);
  if (tab.source === 'self_order' && tab.status === 'open') await cancelExpiredSelfOrders(env, tab.org_id);

  const [current, tickets, lines, charges] = await env.DB.batch([
    env.DB.prepare('SELECT status FROM tabs WHERE id = ?').bind(tab.id),
    env.DB.prepare('SELECT station_name, status, sms_status FROM prep_tickets WHERE tab_id = ? ORDER BY created_at, station_name').bind(tab.id),
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
  const payLater = !!tab.pay_later;
  const tabOpen = payLater && status === 'open';
  const { state, stations } = followState(status, [...perStation].map(([station_name, s]) => ({ station_name, status: s })), payLater);
  const shown = ((lines.results || []) as { name: string; unit_price_cents: number; quantity: number }[]).filter((l) => l.quantity > 0);
  // Per station, how its SMS went (any one sent counts; else a failure shows).
  const smsByStation = new Map<string, string>();
  for (const t of (tickets.results || []) as { station_name: string; sms_status: string | null }[]) {
    if (!t.sms_status || smsByStation.get(t.station_name) === 'sent') continue;
    smsByStation.set(t.station_name, t.sms_status === 'capped' ? 'failed' : t.sms_status);
  }
  const smsOn = !!tab.notify_sms && !!smsConfig(env);

  return json({
    number: tab.event_number ?? tab.number,
    eventName: tab.event_name,
    orgName: tab.org_name,
    locale: tab.org_locale || 'nl',
    selfOrder: tab.source === 'self_order',
    // The ordering mode it came in by (its menu for another round), and its
    // name when the event has more than one ("Take away").
    modeId: tab.order_mode_id,
    mode: tab.mode_label,
    // A tab paid when leaving, still open: more rounds can be added, and it
    // can be settled (payment below).
    payLater,
    tabOpen,
    state,
    stations,
    lines: shown.map((l) => ({ name: l.name, quantity: l.quantity, unitPriceCents: l.unit_price_cents })),
    totalCents: shown.reduce((sum, l) => sum + l.quantity * l.unit_price_cents, 0),
    // While it's waiting for payment: how it can be paid, a payment in
    // progress, the last one failed.
    payment:
      (state === 'awaiting_payment' || tabOpen) && tab.source === 'self_order'
        ? { ...(await paymentOptions(env, tab.org_id, tab)), pending: lastCharge?.status === 'pending', failed: lastCharge?.status === 'failed' }
        : null,
    // An SMS when a station's part is ready: offered while there's
    // something left to make ready; the number only ever shown masked.
    sms: smsOn || smsByStation.size
      ? {
          available: smsOn && state !== 'cancelled' && (tabOpen || !(state === 'delivered' || state === 'nothing_to_prepare')),
          phone: tab.notify_phone ? maskPhone(tab.notify_phone) : null,
          stations: [...smsByStation].map(([name, status]) => ({ name, status })),
        }
      : null,
    // Back to step 1 of this event's self-order page once it's all delivered.
    selfOrderCode: tab.self_order_enabled ? (tab.self_order_slug ?? tab.self_order_code) : null,
    // Live updates: devicehub's order hub, this tab only (null: no live updates).
    hubTicket: !tabOpen && (state === 'delivered' || state === 'cancelled' || state === 'nothing_to_prepare') ? null : await orderHubTicket(env, tab.org_id, tab.id),
  });
}

// One more round on a guest's tab (paid when leaving): priced from its
// ordering mode's menu, its prep tickets made, like any order.
async function addRound(request: Request, env: Env, token: string): Promise<Response> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return errorJson('order_not_found', 404);
  const tab = await env.DB.prepare(
    `SELECT t.id, t.org_id, t.status, t.source, t.pay_later, CASE WHEN m.self_order = 1 THEN m.catalog_id END AS catalog_id, e.self_order_enabled
     FROM tabs t LEFT JOIN events e ON e.id = t.event_id LEFT JOIN event_order_modes m ON m.id = t.order_mode_id WHERE t.order_token = ?`
  )
    .bind(token)
    .first<{ id: string; org_id: string; status: string; source: string; pay_later: number; catalog_id: string | null; self_order_enabled: number | null }>();
  if (!tab) return errorJson('order_not_found', 404);
  // A guest's own tab — or a table's (release C, T3: its QR lets the guests order on it).
  if ((tab.source !== 'self_order' && tab.source !== 'table') || !tab.pay_later || !tab.self_order_enabled || !tab.catalog_id) return errorJson('self_order_closed', 409);
  if (tab.status !== 'open') return errorJson('tab_not_open', 409);

  const body = (await request.json().catch(() => ({}))) as { lines?: unknown };
  const raw = Array.isArray(body.lines) ? body.lines : [];
  if (raw.length > MAX_LINES || raw.some((l) => Number((l as { quantity?: unknown })?.quantity) > MAX_QUANTITY)) return errorJson('self_order_too_large', 400);
  const prepared = await prepareOrderLines(env, tab.org_id, { lines: raw, catalogId: tab.catalog_id });
  if (typeof prepared === 'string' || 'code' in prepared) return json(errorBody(typeof prepared === 'string' ? codedError('self_order_too_large') : prepared), 400);

  const added = await addOrderToTab(env, {
    orgId: tab.org_id,
    tabId: tab.id,
    lines: prepared.lines,
    catalogId: prepared.catalogId,
    source: 'self_order',
    who: { deviceId: null, deviceName: null, userName: null, userEmail: null },
  });
  // A payment in progress (or just finished) on it: no more rounds now.
  if (!added) return errorJson('tab_payment_pending', 409);
  return json({ ok: true }, 201);
}

// A guest pays their own self-order with Bancontact: exactly what's open on
// it, no tip. A payment already in progress is handed out again (a second
// tap, or back from the app before it's done) rather than starting another.
async function payBancontact(env: Env, token: string): Promise<Response> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return errorJson('order_not_found', 404);
  const tab = await env.DB.prepare(
    `SELECT t.id, t.org_id, t.number, t.event_number, t.status, t.source, m.pay_counter, m.pay_bancontact, o.name AS org_name
     FROM tabs t JOIN organizations o ON o.id = t.org_id LEFT JOIN event_order_modes m ON m.id = t.order_mode_id WHERE t.order_token = ?`
  )
    .bind(token)
    .first<{ id: string; org_id: string; number: number; event_number: number | null; status: string; source: string; pay_counter: number | null; pay_bancontact: number | null; org_name: string }>();
  if (!tab) return errorJson('order_not_found', 404);
  if (tab.source !== 'self_order' || !(await paymentOptions(env, tab.org_id, tab)).bancontact) return errorJson('self_order_payment_unavailable', 409);

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

// A guest's number for "ready" SMS (or none after all): only when the
// order's ordering mode has SMS on, the installation can send, and the
// order isn't cancelled. Kept on the tab until no longer needed (messaging.ts).
async function setNotifyPhone(request: Request, env: Env, token: string, remove: boolean): Promise<Response> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return errorJson('order_not_found', 404);
  const tab = await env.DB.prepare(
    `SELECT t.id, t.org_id, t.status, m.notify_sms FROM tabs t LEFT JOIN event_order_modes m ON m.id = t.order_mode_id WHERE t.order_token = ?`
  )
    .bind(token)
    .first<{ id: string; org_id: string; status: string; notify_sms: number | null }>();
  if (!tab) return errorJson('order_not_found', 404);
  if (remove) {
    await env.DB.prepare('UPDATE tabs SET notify_phone = NULL WHERE id = ?').bind(tab.id).run();
    return json({ ok: true });
  }
  const config = smsConfig(env);
  if (!config || !tab.notify_sms || tab.status === 'cancelled') return errorJson('sms_unavailable', 409);
  const body = (await request.json().catch(() => ({}))) as { phone?: unknown };
  const phone = normalizePhone(body.phone, config.countries);
  if (!phone) return errorJson(codedError('invalid_phone', { countries: config.countries.join(', ') }), 400);
  await env.DB.prepare('UPDATE tabs SET notify_phone = ? WHERE id = ?').bind(phone, tab.id).run();
  return json({ ok: true, phone: maskPhone(phone) });
}

// Handles /public/*. Returns null for anything it doesn't recognize.
export async function dispatchSelfOrderRoute(request: Request, env: Env, pathname: string): Promise<Response | null> {
  const menuMatch = pathname.match(/^\/public\/self-order\/([^/]+)$/);
  if (menuMatch && request.method === 'GET') return menu(env, menuMatch[1]);
  const orderMatch = pathname.match(/^\/public\/self-order\/([^/]+)\/orders$/);
  if (orderMatch && request.method === 'POST') return placeOrder(request, env, orderMatch[1]);
  const followMatch = pathname.match(/^\/public\/orders\/([^/]+)$/);
  if (followMatch && request.method === 'GET') return follow(env, followMatch[1]);
  const roundMatch = pathname.match(/^\/public\/orders\/([^/]+)\/orders$/);
  if (roundMatch && request.method === 'POST') return addRound(request, env, roundMatch[1]);
  const notifyMatch = pathname.match(/^\/public\/orders\/([^/]+)\/notify$/);
  if (notifyMatch && (request.method === 'POST' || request.method === 'DELETE')) return setNotifyPhone(request, env, notifyMatch[1], request.method === 'DELETE');
  const payMatch = pathname.match(/^\/public\/orders\/([^/]+)\/bancontact$/);
  if (payMatch && request.method === 'POST') return payBancontact(env, payMatch[1]);
  return null;
}
