// Self-ordering, prep tickets (bonnen) and station screens, and an event's
// own order numbers — DOMAIN_MODEL.md "Self-ordering and station screens".
import { env, SELF } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { api, chargeCash, confirmCharge, DEVICE, payCash, recordedCalls, rows, seedOrg, tabsPath, type TestOrg } from './helpers';

const BASE = 'https://backend';
const call = async (method: string, path: string, body?: unknown) => {
  const res = await SELF.fetch(`${BASE}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

// A menu with a kitchen and a bar: Frieten (Keuken), Pils (Bar), Bon (no station).
async function venue(org: TestOrg) {
  const admin = async (method: string, path: string, body?: unknown) => {
    const res = await api(method, `/organizations/${org.orgId}${path}`, { user: org.admin, body });
    if (res.status >= 300) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  };
  const kitchen = await admin('POST', '/catalog/stations', { name: 'Keuken' });
  const bar = await admin('POST', '/catalog/stations', { name: 'Bar' });
  const catalog = await admin('POST', '/catalogs', { name: 'Fuif' });
  const section = await admin('POST', `/catalogs/${catalog.id}/sections`, { name: 'Alles' });
  const add = async (name: string, priceCents: number, prepStationId: string | null) => {
    const product = await admin('POST', '/catalog/products', { name, prepStationId, variants: [{ name: '', code: name.toLowerCase() }] });
    await admin('POST', `/catalogs/${catalog.id}/entries`, { sectionId: section.id, variantId: product.variants[0].id, priceCents });
    return product.variants[0].id as string;
  };
  const frieten = await add('Frieten', 400, kitchen.id);
  const pils = await add('Pils', 250, bar.id);
  const bon = await add('Bon', 100, null);
  const event = await admin('POST', '/events', { name: 'Fuif', date: '2026-10-11' });
  return { admin, kitchen, bar, catalog, section, event, frieten, pils, bon };
}

const kassaTab = (org: TestOrg, v: Awaited<ReturnType<typeof venue>>, lines: { variantId: string; quantity: number }[], eventId: string | null = v.event.id) =>
  api('POST', tabsPath(org.orgId), { user: org.cashier, body: { ...DEVICE, eventId, catalogId: v.catalog.id, lines } });

const stationTickets = async (org: TestOrg, stationId: string, query = '') => (await api('GET', `/organizations/${org.orgId}/stations/${stationId}/tickets${query}`, { user: org.cashier })).body;
const setStatus = (org: TestOrg, ticketId: string, status: string) => api('POST', `/organizations/${org.orgId}/tickets/${ticketId}`, { user: org.cashier, body: { status } });

async function enableSelfOrder(org: TestOrg, v: Awaited<ReturnType<typeof venue>>) {
  const res = await api('PATCH', `/organizations/${org.orgId}/events/${v.event.id}`, { user: org.admin, body: { catalogId: v.catalog.id, selfOrderEnabled: true } });
  expect(res.status).toBe(200);
  return res.body.selfOrder.code as string;
}

describe('an event: its menu, self-ordering, its own numbers', () => {
  it('self-ordering needs a menu; switching it on makes a code; a new code replaces it; admins only', async () => {
    const org = await seedOrg();
    const v = await venue(org);
    const patch = (body: unknown, user = org.admin) => api('PATCH', `/organizations/${org.orgId}/events/${v.event.id}`, { user, body });
    expect((await patch({ selfOrderEnabled: true })).body.code).toBe('self_order_needs_menu');
    expect((await patch({ catalogId: v.catalog.id, selfOrderEnabled: true }, org.cashier)).status).toBe(403);
    const on = (await patch({ catalogId: v.catalog.id, selfOrderEnabled: true })).body;
    expect(on).toMatchObject({ catalogId: v.catalog.id, selfOrder: { enabled: true } });
    expect(on.selfOrder.code).toMatch(/^[A-Za-z0-9_-]{32}$/);
    // Off and on again: the same code (the printed QR keeps working).
    await patch({ selfOrderEnabled: false });
    expect((await patch({ selfOrderEnabled: true })).body.selfOrder.code).toBe(on.selfOrder.code);
    const renewed = (await api('POST', `/organizations/${org.orgId}/events/${v.event.id}/self-order-code`, { user: org.admin })).body;
    expect(renewed.selfOrder.code).not.toBe(on.selfOrder.code);
    expect((await call('GET', `/public/self-order/${on.selfOrder.code}`)).status).toBe(404);
    expect((await call('GET', `/public/self-order/${renewed.selfOrder.code}`)).body.open).toBe(true);
  });

  it("numbers the event's tabs 1, 2, 3…; a reset starts at 1 again, skipping numbers still open", async () => {
    const org = await seedOrg();
    const v = await venue(org);
    const numbers = [];
    for (let i = 0; i < 3; i++) numbers.push((await kassaTab(org, v, [{ variantId: v.pils, quantity: 1 }])).body.eventNumber);
    expect(numbers).toEqual([1, 2, 3]);
    // Tabs without an event: no event number.
    expect((await kassaTab(org, v, [{ variantId: v.pils, quantity: 1 }], null)).body.eventNumber).toBeNull();
    // #1 paid (closed), #2 and #3 still open: after the reset, #1 again, then #4.
    const first = (await api('GET', tabsPath(org.orgId), { user: org.cashier })).body.find((t: any) => t.eventNumber === 1);
    await payCash(org, first.id, 250);
    expect((await api('POST', `/organizations/${org.orgId}/events/${v.event.id}/reset-numbers`, { user: org.admin })).body.lastOrderNumber).toBe(0);
    expect((await kassaTab(org, v, [{ variantId: v.pils, quantity: 1 }])).body.eventNumber).toBe(1);
    expect((await kassaTab(org, v, [{ variantId: v.pils, quantity: 1 }])).body.eventNumber).toBe(4);
  });
});

describe('prep tickets and station screens', () => {
  it('an order makes a ticket per station with something on it; the station lists its own, paid or not', async () => {
    const org = await seedOrg();
    const v = await venue(org);
    const tab = (await kassaTab(org, v, [{ variantId: v.frieten, quantity: 2 }, { variantId: v.pils, quantity: 3 }, { variantId: v.bon, quantity: 5 }])).body;
    const kitchen = await stationTickets(org, v.kitchen.id);
    expect(kitchen).toHaveLength(1);
    expect(kitchen[0]).toMatchObject({ tabId: tab.id, status: 'ordered', number: 1, paid: false, selfOrder: false, lines: [{ name: 'Frieten', quantity: 2, voided: 0, note: null }] });
    expect((await stationTickets(org, v.bar.id))[0].lines).toEqual([{ name: 'Pils', quantity: 3, voided: 0, note: null }]);
    // Bonnen go nowhere.
    expect(await rows('SELECT station_name FROM prep_tickets WHERE tab_id = ? ORDER BY station_name', tab.id)).toEqual([{ station_name: 'Bar' }, { station_name: 'Keuken' }]);

    // Paid: the station sees it.
    await payCash(org, tab.id, 2050);
    expect((await stationTickets(org, v.kitchen.id))[0].paid).toBe(true);
  });

  it('moves on ordered → in progress → ready → delivered; delivered ones only when asked; voids show', async () => {
    const org = await seedOrg();
    const v = await venue(org);
    const tab = (await kassaTab(org, v, [{ variantId: v.frieten, quantity: 2 }])).body;
    const [ticket] = await stationTickets(org, v.kitchen.id);
    expect((await setStatus(org, ticket.id, 'klaar')).status).toBe(400);
    for (const status of ['in_progress', 'ready']) expect((await setStatus(org, ticket.id, status)).body.status).toBe(status);

    // Voided at the kassa: struck through on the screen.
    const lineId = (await api('GET', tabsPath(org.orgId, `/${tab.id}`), { user: org.cashier })).body.lines[0].id;
    await api('POST', tabsPath(org.orgId, `/${tab.id}/lines/${lineId}/void`), { user: org.cashier, body: { ...DEVICE, reason: 'fout', quantity: 1 } });
    expect((await stationTickets(org, v.kitchen.id))[0].lines).toEqual([{ name: 'Frieten', quantity: 2, voided: 1, note: null }]);

    await setStatus(org, ticket.id, 'delivered');
    expect(await stationTickets(org, v.kitchen.id)).toEqual([]);
    expect((await stationTickets(org, v.kitchen.id, '?delivered=1'))[0].status).toBe('delivered');
    // Another org can't touch it.
    const other = await seedOrg();
    expect((await api('POST', `/organizations/${other.orgId}/tickets/${ticket.id}`, { user: other.cashier, body: { status: 'ordered' } })).body.code).toBe('ticket_not_found');
    expect((await api('GET', `/organizations/${org.orgId}/stations/${v.kitchen.id}/tickets`, { user: other.cashier })).status).toBe(403);
  });

  it('every change reaches kassas, station screens and follow pages through one devicehub call', async () => {
    const org = await seedOrg();
    const v = await venue(org);
    const tab = (await kassaTab(org, v, [{ variantId: v.frieten, quantity: 1 }])).body;
    const [ticket] = await stationTickets(org, v.kitchen.id);
    await setStatus(org, ticket.id, 'ready');
    let calls: { path: string; body: any }[] = [];
    for (let i = 0; i < 50 && calls.length < 2; i++) {
      calls = (await recordedCalls('devicehub')).filter((c) => c.path === '/devices/tabs-changed' && c.body?.org_id === org.orgId);
      if (calls.length < 2) await new Promise((r) => setTimeout(r, 10));
    }
    expect(calls.map((c) => c.body)).toEqual([
      { org_id: org.orgId, tab_ids: [tab.id] },
      { org_id: org.orgId, tab_ids: [tab.id] },
    ]);
  });
});

describe('self-ordering (public, no sign-in)', () => {
  it("shows the event's menu — or that it's closed", async () => {
    const org = await seedOrg();
    const v = await venue(org);
    const code = await enableSelfOrder(org, v);
    const menu = (await call('GET', `/public/self-order/${code}`)).body;
    expect(menu).toMatchObject({ eventName: 'Fuif', orgName: 'Test org', locale: 'nl', open: true });
    expect(menu.catalog.sections[0].entries.map((e: any) => [e.name, e.priceCents])).toEqual([['Frieten', 400], ['Pils', 250], ['Bon', 100]]);
    await api('PATCH', `/organizations/${org.orgId}/events/${v.event.id}`, { user: org.admin, body: { selfOrderEnabled: false } });
    expect((await call('GET', `/public/self-order/${code}`)).body).toMatchObject({ open: false, catalog: null });
    expect((await call('POST', `/public/self-order/${code}/orders`, { lines: [{ variantId: v.pils, quantity: 1 }] })).body.code).toBe('self_order_closed');
    expect((await call('GET', '/public/self-order/nope')).status).toBe(404);
  });

  it('an order: a tab with the next event number, priced from the menu; then followed until delivered', async () => {
    const org = await seedOrg();
    const v = await venue(org);
    const code = await enableSelfOrder(org, v);
    await kassaTab(org, v, [{ variantId: v.pils, quantity: 1 }]); // #1, from a kassa
    const placed = await call('POST', `/public/self-order/${code}/orders`, { lines: [{ variantId: v.frieten, quantity: 2, unitPriceCents: 1 }, { variantId: v.pils, quantity: 1 }] });
    expect(placed.status).toBe(201);
    expect(placed.body.number).toBe(2);
    expect(placed.body.token).toMatch(/^[A-Za-z0-9_-]{24}$/);

    // At the kassa: an open tab #2, from self-ordering, at the menu's prices.
    const tab = (await api('GET', tabsPath(org.orgId), { user: org.cashier })).body.find((t: any) => t.eventNumber === 2);
    expect(tab).toMatchObject({ source: 'self_order', totalCents: 1050, status: 'open' });

    const follow = async () => (await call('GET', `/public/orders/${placed.body.token}`)).body;
    expect(await follow()).toMatchObject({
      number: 2,
      eventName: 'Fuif',
      selfOrder: true,
      state: 'awaiting_payment',
      totalCents: 1050,
      lines: [{ name: 'Frieten', quantity: 2, unitPriceCents: 400 }, { name: 'Pils', quantity: 1, unitPriceCents: 250 }],
      selfOrderCode: code,
      hubTicket: `ticket-for-${tab.id}`,
    });

    // Paid at the toog: being prepared, per station.
    await payCash(org, tab.id, 1050);
    expect(await follow()).toMatchObject({ state: 'preparing', stations: [{ name: 'Bar', status: 'ordered' }, { name: 'Keuken', status: 'ordered' }] });
    const kitchen = (await stationTickets(org, v.kitchen.id)).find((t: any) => t.number === 2);
    // The bar also has the kassa's #1.
    const bar = (await stationTickets(org, v.bar.id)).find((t: any) => t.number === 2);
    expect(kitchen).toMatchObject({ number: 2, paid: true, selfOrder: true });
    await setStatus(org, bar.id, 'ready');
    expect((await follow()).state).toBe('preparing');
    await setStatus(org, kitchen.id, 'ready');
    expect((await follow()).state).toBe('ready');
    await setStatus(org, kitchen.id, 'delivered');
    await setStatus(org, bar.id, 'delivered');
    expect(await follow()).toMatchObject({ state: 'delivered', hubTicket: null });
    expect((await call('GET', '/public/orders/not-a-real-token-at-all')).status).toBe(404);
  });

  it('unpaid after 10 minutes: cancelled, gone from the stations, and the guest sees it', async () => {
    const org = await seedOrg();
    const v = await venue(org);
    const code = await enableSelfOrder(org, v);
    const placed = (await call('POST', `/public/self-order/${code}/orders`, { lines: [{ variantId: v.frieten, quantity: 1 }] })).body;
    expect(await stationTickets(org, v.kitchen.id)).toHaveLength(1);
    await env.DB.prepare('UPDATE tabs SET opened_at = ? WHERE order_token = ?').bind(new Date(Date.now() - 11 * 60_000).toISOString(), placed.token).run();
    expect(await stationTickets(org, v.kitchen.id)).toEqual([]);
    expect((await call('GET', `/public/orders/${placed.token}`)).body).toMatchObject({ state: 'cancelled', hubTicket: null });
    expect((await rows<any>('SELECT status, cancel_reason FROM tabs WHERE order_token = ?', placed.token))[0]).toEqual({ status: 'cancelled', cancel_reason: 'Niet betaald binnen 10 minuten' });
  });

  it('a payment in progress keeps it; a kassa order is never cancelled', async () => {
    const org = await seedOrg();
    const v = await venue(org);
    const code = await enableSelfOrder(org, v);
    const placed = (await call('POST', `/public/self-order/${code}/orders`, { lines: [{ variantId: v.pils, quantity: 1 }] })).body;
    const kassa = (await kassaTab(org, v, [{ variantId: v.pils, quantity: 1 }])).body;
    const old = new Date(Date.now() - 30 * 60_000).toISOString();
    await env.DB.prepare('UPDATE tabs SET opened_at = ? WHERE order_token = ? OR id = ?').bind(old, placed.token, kassa.id).run();
    const tabId = (await rows<{ id: string }>('SELECT id FROM tabs WHERE order_token = ?', placed.token))[0].id;
    const charge = await chargeCash(org, tabId, 250);
    expect(charge.status).toBe(201);
    await api('GET', tabsPath(org.orgId), { user: org.cashier });
    expect((await rows<any>('SELECT status FROM tabs WHERE id IN (?, ?) ORDER BY source', kassa.id, tabId)).map((r) => r.status)).toEqual(['open', 'open']);
    await confirmCharge(org, charge.body.chargeId, true);
  });

  it('refuses an order too large, or with something not on the menu', async () => {
    const org = await seedOrg();
    const v = await venue(org);
    const code = await enableSelfOrder(org, v);
    const order = (lines: unknown) => call('POST', `/public/self-order/${code}/orders`, { lines });
    expect((await order([{ variantId: v.pils, quantity: 21 }])).body.code).toBe('self_order_too_large');
    expect((await order(Array.from({ length: 31 }, () => ({ variantId: v.pils, quantity: 1 })))).body.code).toBe('self_order_too_large');
    expect((await order([{ variantId: 'not-on-the-menu', quantity: 1 }])).body.code).toBe('product_not_on_catalog');
    expect((await order([])).status).toBe(400);
  });

  it("a kassa order with something to prepare: the customer display gets the follow link", async () => {
    const org = await seedOrg();
    const v = await venue(org);
    const prepared = (await kassaTab(org, v, [{ variantId: v.frieten, quantity: 1 }])).body;
    const nothing = (await kassaTab(org, v, [{ variantId: v.bon, quantity: 1 }])).body;
    const { customerOrder } = await import('../src/tabs');
    const token = (await rows<{ order_token: string }>('SELECT order_token FROM tabs WHERE id = ?', prepared.id))[0].order_token;
    expect(await customerOrder(env as any, org.orgId, prepared.id)).toMatchObject({ eventNumber: 1, followUrl: `https://arcanum.test/volg/${token}` });
    expect((await customerOrder(env as any, org.orgId, nothing.id))!.followUrl).toBeNull();
    // The kassa's tab detail carries it too (a customer display on the same device).
    expect((await api('GET', tabsPath(org.orgId, `/${prepared.id}`), { user: org.cashier })).body.followUrl).toBe(`https://arcanum.test/volg/${token}`);
    expect((await api('GET', tabsPath(org.orgId, `/${nothing.id}`), { user: org.cashier })).body.followUrl).toBeNull();
  });
});

describe('station screens as devices', () => {
  it('a pairing code for a station screen names its station; claimed, the device knows it', async () => {
    const org = await seedOrg();
    const v = await venue(org);
    const pair = (body: unknown) => api('POST', `/organizations/${org.orgId}/device-pairings`, { user: org.admin, body });
    expect((await pair({ role: 'station', name: 'Keukenscherm' })).body.code).toBe('station_not_found');
    const created = await pair({ role: 'station', name: 'Keukenscherm', stationId: v.kitchen.id });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ role: 'station', stationId: v.kitchen.id });
    const claimed = await api('POST', '/organizations/device-pairings/claim', { user: org.admin, body: { code: created.body.code } });
    expect(claimed.status).toBe(201);
    expect(claimed.body).toMatchObject({ role: 'station', stationId: v.kitchen.id });
    expect(await rows('SELECT station_id FROM station_devices WHERE terminal_id = ?', claimed.body.terminalId)).toEqual([{ station_id: v.kitchen.id }]);
  });
});

describe('self-ordering: how guests pay (per event)', () => {
  // Bancontact's API, stubbed (nothing reaches the network).
  let bancontactCalls: any[] = [];
  const stubBancontact = () => {
    bancontactCalls = []
    const realFetch = globalThis.fetch
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
      const request = new Request(input, init)
      if (new URL(request.url).hostname === 'merchant.api.preprod.bancontact.net') {
        bancontactCalls.push(await request.clone().json())
        return Response.json(
          {
            paymentId: `bc-${bancontactCalls.length}`,
            status: 'PENDING',
            amount: 650,
            currency: 'EUR',
            expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(),
            _links: { qrcode: { href: 'https://qr.test/1.png' }, deeplink: { href: 'https://payconiq.test/deeplink/1' }, checkout: { href: 'https://checkout.test/1' } },
          },
          { status: 201 }
        )
      }
      return realFetch(input, init)
    })
  }
  const withBancontact = async (org: TestOrg) =>
    expect((await api('PUT', `/organizations/${org.orgId}/payment-credentials/bancontact`, { user: org.admin, body: { apiKey: 'k', environment: 'preprod' } })).status).toBe(200)

  it('the counter by default; Bancontact only when set up; never neither', async () => {
    const org = await seedOrg();
    const v = await venue(org);
    const code = await enableSelfOrder(org, v);
    const patch = (body: unknown) => api('PATCH', `/organizations/${org.orgId}/events/${v.event.id}`, { user: org.admin, body });
    expect((await call('GET', `/public/self-order/${code}`)).body.payment).toEqual({ counter: true, bancontact: false, tab: false });
    expect((await patch({ payBancontact: true })).body.code).toBe('bancontact_not_configured');
    await withBancontact(org);
    expect((await patch({ payBancontact: true, payAtCounter: false })).body.selfOrder).toMatchObject({ payAtCounter: false, payBancontact: true });
    expect((await call('GET', `/public/self-order/${code}`)).body.payment).toEqual({ counter: false, bancontact: true, tab: false });
    expect((await patch({ payBancontact: false })).body.code).toBe('self_order_needs_payment');
  });

  it('a guest pays with Bancontact: exactly what is open, back to the follow page; a second tap reuses the payment', async () => {
    const spy = stubBancontact();
    const org = await seedOrg();
    const v = await venue(org);
    const code = await enableSelfOrder(org, v);
    await withBancontact(org);
    await api('PATCH', `/organizations/${org.orgId}/events/${v.event.id}`, { user: org.admin, body: { payBancontact: true } });
    const placed = (await call('POST', `/public/self-order/${code}/orders`, { lines: [{ variantId: v.frieten, quantity: 1 }, { variantId: v.pils, quantity: 1 }] })).body;

    const pay = await call('POST', `/public/orders/${placed.token}/bancontact`);
    expect(pay.status).toBe(201);
    expect(pay.body).toEqual({ deeplinkUrl: 'https://payconiq.test/deeplink/1', checkoutUrl: 'https://checkout.test/1', qrCodeUrl: 'https://qr.test/1.png' });
    expect(bancontactCalls).toEqual([
      expect.objectContaining({ amount: 650, currency: 'EUR', description: 'Test org #1', returnUrl: `https://arcanum.test/volg/${placed.token}` }),
    ]);
    // Waiting for it: the follow page says so; a payment in progress keeps the order from expiring.
    expect((await call('GET', `/public/orders/${placed.token}`)).body).toMatchObject({ state: 'awaiting_payment', payment: { counter: true, bancontact: true, pending: true, failed: false } });
    // Tapped again: the same payment, not a second one.
    expect((await call('POST', `/public/orders/${placed.token}/bancontact`)).body.deeplinkUrl).toBe('https://payconiq.test/deeplink/1');
    expect(bancontactCalls).toHaveLength(1);

    // Bancontact confirms (here through the generic resolve path): paid, being prepared.
    const chargeId = (await rows<{ id: string }>("SELECT id FROM charges WHERE method = 'bancontact' AND tab_id = (SELECT id FROM tabs WHERE order_token = ?)", placed.token))[0].id;
    const { resolveCharge } = await import('../src/payments/charges');
    await resolveCharge(env as any, chargeId, { success: true, providerStatus: 'SUCCEEDED' } as any);
    expect((await call('GET', `/public/orders/${placed.token}`)).body).toMatchObject({ state: 'preparing', payment: null });
    spy.mockRestore();
  });

  it('not when the event only takes the counter, and never for a kassa order', async () => {
    const org = await seedOrg();
    const v = await venue(org);
    const code = await enableSelfOrder(org, v);
    await withBancontact(org);
    const placed = (await call('POST', `/public/self-order/${code}/orders`, { lines: [{ variantId: v.pils, quantity: 1 }] })).body;
    expect((await call('POST', `/public/orders/${placed.token}/bancontact`)).body.code).toBe('self_order_payment_unavailable');
    await api('PATCH', `/organizations/${org.orgId}/events/${v.event.id}`, { user: org.admin, body: { payBancontact: true } });
    const kassa = (await kassaTab(org, v, [{ variantId: v.pils, quantity: 1 }])).body;
    const token = (await rows<{ order_token: string }>('SELECT order_token FROM tabs WHERE id = ?', kassa.id))[0].order_token;
    expect((await call('POST', `/public/orders/${token}/bancontact`)).body.code).toBe('self_order_payment_unavailable');
  });
});

describe('self-ordering on a tab (pay when leaving)', () => {
  it('keeps ordering on one tab, prepared unpaid, never cancelled for being unpaid; settled at the end', async () => {
    const org = await seedOrg();
    const v = await venue(org);
    const code = await enableSelfOrder(org, v);
    const patch = await api('PATCH', `/organizations/${org.orgId}/events/${v.event.id}`, { user: org.admin, body: { tabs: true } });
    expect(patch.body.selfOrder.tabs).toBe(true);
    expect((await call('GET', `/public/self-order/${code}`)).body.payment).toEqual({ counter: true, bancontact: false, tab: true });

    const placed = (await call('POST', `/public/self-order/${code}/orders`, { lines: [{ variantId: v.pils, quantity: 2 }] })).body;
    const follow = async () => (await call('GET', `/public/orders/${placed.token}`)).body;
    // Being prepared right away — unpaid, on the tab.
    expect(await follow()).toMatchObject({ payLater: true, tabOpen: true, state: 'preparing', payment: { counter: true, bancontact: false, pending: false, failed: false } });
    const [bar] = await stationTickets(org, v.bar.id);
    expect(bar).toMatchObject({ paid: false, payLater: true, selfOrder: true });

    // Delivered, still open: not the end — no "delivered", a ticket for live updates.
    await setStatus(org, bar.id, 'delivered');
    expect(await follow()).toMatchObject({ state: 'delivered', tabOpen: true, hubTicket: expect.any(String) });

    // An hour later: a second round, on the same tab and number.
    await env.DB.prepare('UPDATE tabs SET opened_at = ? WHERE order_token = ?').bind(new Date(Date.now() - 60 * 60_000).toISOString(), placed.token).run();
    expect((await call('POST', `/public/orders/${placed.token}/orders`, { lines: [{ variantId: v.frieten, quantity: 1 }] })).status).toBe(201);
    expect(await follow()).toMatchObject({ number: 1, state: 'preparing', totalCents: 900, tabOpen: true });
    expect((await rows<any>('SELECT status FROM tabs WHERE order_token = ?', placed.token))[0].status).toBe('open');
    expect(await stationTickets(org, v.kitchen.id)).toHaveLength(1);

    // Leaving: paid at the toog as a whole — closed, no more rounds.
    const tabId = (await rows<{ id: string }>('SELECT id FROM tabs WHERE order_token = ?', placed.token))[0].id;
    await payCash(org, tabId, 900);
    expect(await follow()).toMatchObject({ tabOpen: false, payment: null });
    expect((await call('POST', `/public/orders/${placed.token}/orders`, { lines: [{ variantId: v.pils, quantity: 1 }] })).body.code).toBe('tab_not_open');
  });

  it('a pay-now order (no tab) takes no extra rounds', async () => {
    const org = await seedOrg();
    const v = await venue(org);
    const code = await enableSelfOrder(org, v);
    const placed = (await call('POST', `/public/self-order/${code}/orders`, { lines: [{ variantId: v.pils, quantity: 1 }] })).body;
    expect((await call('POST', `/public/orders/${placed.token}/orders`, { lines: [{ variantId: v.pils, quantity: 1 }] })).body.code).toBe('self_order_closed');
    expect((await call('GET', `/public/orders/${placed.token}`)).body).toMatchObject({ payLater: false, tabOpen: false, state: 'awaiting_payment' });
  });
});
