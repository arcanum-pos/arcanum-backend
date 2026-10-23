// Tables and waiters (src/tables.ts, DOMAIN_MODEL.md "Tables and waiters",
// release C): tables per organisation, their status following their tab,
// guests seated by a waiter (role Bediening) with the event's "aan tafel"
// mode, rounds and payment on the table's tab, and the table's QR — for a
// guest, ordering on the tab while it's Bezet (T3).
import { env, SELF } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { api, chargeCash, confirmCharge, rows, seedOrg, type TestOrg, type TestUser } from './helpers';

const o = (org: TestOrg, path = '') => `/organizations/${org.orgId}${path}`;
const pub = async (method: string, path: string, body?: unknown) => {
  const res = await SELF.fetch(`https://backend${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

// A waiter: an active member with the role Bediening.
async function waiter(org: TestOrg): Promise<TestUser> {
  const sub = `waiter-${crypto.randomUUID()}`;
  const user = { sub, issuer: 'https://issuer.test/', name: 'Wout', email: `${sub}@test` };
  await env.DB.prepare(
    "INSERT INTO memberships (id, org_id, user_sub, issuer, invited_email, role, status, invited_at, accepted_at) VALUES (?, ?, ?, ?, ?, 'waiter', 'active', ?, ?)"
  )
    .bind(crypto.randomUUID(), org.orgId, sub, user.issuer, user.email, new Date().toISOString(), new Date().toISOString())
    .run();
  return user;
}

// A menu with Frieten (Keuken), an event, and a mode "Ter plaatse" — aan tafel, with the QR too when asked.
async function venue(org: TestOrg, opts: { qr?: boolean } = {}) {
  const admin = async (method: string, path: string, body?: unknown) => {
    const res = await api(method, o(org, path), { user: org.admin, body });
    if (res.status >= 300) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  };
  const kitchen = await admin('POST', '/catalog/stations', { name: 'Keuken' });
  const catalog = await admin('POST', '/catalogs', { name: 'Restaurant' });
  const section = await admin('POST', `/catalogs/${catalog.id}/sections`, { name: 'Alles' });
  const product = await admin('POST', '/catalog/products', { name: 'Frieten', prepStationId: kitchen.id, variants: [{ name: '' }] });
  await admin('POST', `/catalogs/${catalog.id}/entries`, { sectionId: section.id, variantId: product.variants[0].id, priceCents: 400 });
  const event = await admin('POST', '/events', { name: 'Restaurantdag', date: '2026-10-20' });
  const mode = (await admin('POST', `/events/${event.id}/modes`, { name: 'Ter plaatse', catalogId: catalog.id })).modes.at(-1);
  if (opts.qr) {
    await admin('PATCH', `/events/${event.id}`, { selfOrderEnabled: true });
    await admin('PATCH', `/events/${event.id}/modes/${mode.id}`, { tabs: true });
  }
  return { admin, event, mode, catalog, frieten: product.variants[0].id as string, kitchen };
}

const tables = async (org: TestOrg, user: TestUser) => (await api('GET', o(org, '/tables'), { user })).body;

describe('tables', () => {
  it('admins make them (in a zone); the Kassa role and Bediening see them; names unique', async () => {
    const org = await seedOrg();
    const wout = await waiter(org);
    expect((await api('POST', o(org, '/tables'), { user: wout, body: { name: '1' } })).status).toBe(403);
    expect((await api('POST', o(org, '/tables'), { user: org.cashier, body: { name: '1' } })).status).toBe(403);
    await api('POST', o(org, '/tables'), { user: org.admin, body: { name: '1', zone: 'Zaal' } });
    await api('POST', o(org, '/tables'), { user: org.admin, body: { name: 'T1', zone: 'Terras' } });
    expect((await api('POST', o(org, '/tables'), { user: org.admin, body: { name: '1' } })).body.code).toBe('table_name_taken');
    const list = await tables(org, wout);
    expect(list.map((t: any) => [t.name, t.zone, t.state])).toEqual([['T1', 'Terras', 'free'], ['1', 'Zaal', 'free']]);
    expect(list[0].qrToken).toMatch(/^[a-z2-9]{20}$/);
    // Bediening sees only the waiter screen: not the members, nor the organisation's settings.
    expect((await api('GET', o(org, '/members'), { user: wout })).status).toBe(403);
  });
});

describe('a table, from seating to cleared', () => {
  it(`seated with the event's "aan tafel" mode; rounds and payment on its tab; then Af te ruimen, then Vrij`, async () => {
    const org = await seedOrg();
    const wout = await waiter(org);
    const v = await venue(org);
    const t5 = (await api('POST', o(org, '/tables'), { user: org.admin, body: { name: '5' } })).body;
    const seat = () => api('POST', o(org, `/tables/${t5.id}/seat`), { user: wout, body: { eventId: v.event.id } });

    // No mode "aan tafel" yet.
    expect((await seat()).body.code).toBe('no_table_mode');
    await v.admin('PATCH', `/events/${v.event.id}/modes/${v.mode.id}`, { atTable: true });
    const seated = await seat();
    expect(seated.status, JSON.stringify(seated.body)).toBe(201);
    expect(seated.body).toMatchObject({ state: 'occupied', tab: { label: 'Tafel 5' } });
    expect((await seat()).body.code).toBe('table_occupied');
    const tabId = seated.body.tab.id as string;
    expect(await rows('SELECT source, pay_later, order_mode_name, table_id, opened_by_name FROM tabs WHERE id = ?', tabId)).toEqual([
      { source: 'table', pay_later: 1, order_mode_name: 'Ter plaatse', table_id: t5.id, opened_by_name: 'Wout' },
    ]);

    // A round by the waiter: to the kitchen as a normal order.
    const round = await api('POST', o(org, `/tabs/${tabId}/orders`), { user: wout, body: { catalogId: v.catalog.id, lines: [{ variantId: v.frieten, quantity: 2 }] } });
    expect(round.status, JSON.stringify(round.body)).toBe(201);
    expect(await rows('SELECT station_name FROM prep_tickets WHERE tab_id = ?', tabId)).toEqual([{ station_name: 'Keuken' }]);
    expect((await tables(org, wout))[0]).toMatchObject({ state: 'occupied', tab: { totalCents: 800 } });

    // Paid (here: at the till, in cash): Af te ruimen — not seated again before it's cleared.
    const charge = await chargeCash(org, tabId, 800);
    await confirmCharge(org, charge.body.chargeId);
    expect((await tables(org, wout))[0].state).toBe('clearing');
    expect((await seat()).body.code).toBe('table_not_cleared');
    expect((await api('POST', o(org, `/tables/${t5.id}/clear`), { user: wout })).body.state).toBe('free');
    expect((await seat()).status).toBe(201);
  });

  it("a scanned QR, signed in: that table; a new QR and the old one is gone", async () => {
    const org = await seedOrg();
    const wout = await waiter(org);
    const t = (await api('POST', o(org, '/tables'), { user: org.admin, body: { name: '7' } })).body;
    expect((await api('GET', o(org, `/tables/by-qr/${t.qrToken}`), { user: wout })).body.id).toBe(t.id);
    const fresh = (await api('POST', o(org, `/tables/${t.id}/new-qr`), { user: org.admin })).body;
    expect(fresh.qrToken).not.toBe(t.qrToken);
    expect((await api('GET', o(org, `/tables/by-qr/${t.qrToken}`), { user: wout })).status).toBe(404);
    expect((await pub('GET', `/public/tables/${t.qrToken}`)).status).toBe(404);
  });

  it("the waiter screen's live channel: a socket token from devicehub, for members only", async () => {
    const org = await seedOrg();
    const wout = await waiter(org);
    const spy = vi.spyOn(env.ARCANUM_DEVICEHUB_SERVICE, 'fetch').mockImplementation(async () => Response.json({ token: 'member-token' }));
    expect((await api('GET', o(org, '/live-token'), { user: wout })).body).toEqual({ token: 'member-token' });
    expect((await api('GET', o(org, '/live-token'), { user: null })).status).toBe(401);
    spy.mockRestore();
  });
});

describe("a guest scanning the table's QR (T3)", () => {
  it("orders on the table's tab while it's Bezet - when the mode lets guests order with the QR", async () => {
    const org = await seedOrg();
    const wout = await waiter(org);
    const v = await venue(org, { qr: true });
    await v.admin('PATCH', `/events/${v.event.id}/modes/${v.mode.id}`, { atTable: true });
    const t = (await api('POST', o(org, '/tables'), { user: org.admin, body: { name: '3' } })).body;

    // Nobody seated yet: just the table.
    expect((await pub('GET', `/public/tables/${t.qrToken}`)).body).toMatchObject({ table: '3', occupied: false, orderToken: null });
    await api('POST', o(org, `/tables/${t.id}/seat`), { user: wout, body: { eventId: v.event.id } });
    const seen = (await pub('GET', `/public/tables/${t.qrToken}`)).body;
    expect(seen).toMatchObject({ table: '3', occupied: true, orderToken: expect.any(String) });
    const added = await pub('POST', `/public/orders/${seen.orderToken}/orders`, { lines: [{ variantId: v.frieten, quantity: 1 }] });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect((await pub('GET', `/public/orders/${seen.orderToken}`)).status).toBe(200);

    // The mode without the QR: guests see the table, nothing to order on.
    await v.admin('PATCH', `/events/${v.event.id}/modes/${v.mode.id}`, { selfOrder: false });
    expect((await pub('GET', `/public/tables/${t.qrToken}`)).body).toMatchObject({ occupied: true, orderToken: null });
  });
});

describe('table management (release D)', () => {
  async function room(org: TestOrg) {
    const wout = await waiter(org);
    const v = await venue(org);
    await v.admin('PATCH', `/events/${v.event.id}/modes/${v.mode.id}`, { atTable: true });
    const make = async (name: string) => (await api('POST', o(org, '/tables'), { user: org.admin, body: { name } })).body
    const [t1, t2, t3] = [await make('1'), await make('2'), await make('3')];
    const seat = async (t: { id: string }) => (await api('POST', o(org, `/tables/${t.id}/seat`), { user: wout, body: { eventId: v.event.id } })).body;
    const round = (tabId: string, quantity: number) => api('POST', o(org, `/tabs/${tabId}/orders`), { user: wout, body: { catalogId: v.catalog.id, lines: [{ variantId: v.frieten, quantity }] } });
    const state = async () => Object.fromEntries((await tables(org, wout)).map((t: any) => [t.name, t]));
    return { wout, v, t1, t2, t3, seat, round, state };
  }

  it('Verplaatsen: the guests and their tab to a free table; the one they left is Af te ruimen (D1)', async () => {
    const org = await seedOrg();
    const r = await room(org);
    const tab = (await r.seat(r.t1)).tab;
    await r.round(tab.id, 1);
    expect((await api('POST', o(org, `/tables/${r.t1.id}/move`), { user: r.wout, body: { toTableId: r.t1.id } })).body.code).toBe('table_occupied');
    const moved = await api('POST', o(org, `/tables/${r.t1.id}/move`), { user: r.wout, body: { toTableId: r.t2.id } });
    expect(moved.body).toMatchObject({ name: '2', state: 'occupied', tab: { id: tab.id, label: 'Tafel 2', totalCents: 400, preparing: true } });
    const s = await r.state();
    expect([s['1'].state, s['2'].state]).toEqual(['clearing', 'occupied']);
    // Not to a table still to be cleared.
    await r.seat(r.t3);
    expect((await api('POST', o(org, `/tables/${r.t3.id}/move`), { user: r.wout, body: { toTableId: r.t1.id } })).body.code).toBe('table_not_cleared');
  });

  it("Samenvoegen: one table's orders onto the other's tab; refused once something was paid (D2)", async () => {
    const org = await seedOrg();
    const r = await room(org);
    const a = (await r.seat(r.t1)).tab;
    const b = (await r.seat(r.t2)).tab;
    await r.round(a.id, 1);
    await r.round(b.id, 2);
    const merged = await api('POST', o(org, `/tables/${r.t2.id}/merge`), { user: r.wout, body: { intoTableId: r.t1.id } });
    expect(merged.body).toMatchObject({ name: '1', tab: { id: a.id, totalCents: 1200 } });
    expect(await rows('SELECT status, cancel_reason FROM tabs WHERE id = ?', b.id)).toEqual([{ status: 'cancelled', cancel_reason: 'Samengevoegd met Tafel 1' }]);
    expect(await rows('SELECT COUNT(*) AS n FROM prep_tickets WHERE tab_id = ?', a.id)).toEqual([{ n: 2 }]);
    expect((await r.state())['2'].state).toBe('clearing');
    // Paid in part: no merging.
    const c = (await r.seat(r.t3)).tab;
    await r.round(c.id, 1);
    const charge = await chargeCash(org, c.id, 200, { partial: true });
    await confirmCharge(org, charge.body.chargeId);
    expect((await api('POST', o(org, `/tables/${r.t3.id}/merge`), { user: r.wout, body: { intoTableId: r.t1.id } })).body.code).toBe('table_merge_paid');
  });

  it('Beloven: a table that will come free, promised to waiting guests; the entrance screen sees it get ready; seating them ends it (D4, D5)', async () => {
    const org = await seedOrg();
    const r = await room(org);
    const pushes: string[] = [];
    const spy = vi.spyOn(env.ARCANUM_DEVICEHUB_SERVICE, 'fetch').mockImplementation(async (input: any, init?: any) => {
      const req = new Request(input, init);
      if (new URL(req.url).pathname === '/devices/broadcast-org') pushes.push((await req.json() as any).role ?? 'pos');
      return Response.json({ ok: true });
    });
    expect((await api('POST', o(org, `/tables/${r.t1.id}/promise`), { user: r.wout, body: {} })).body.code).toBe('table_free');
    const tab = (await r.seat(r.t1)).tab;
    expect((await api('POST', o(org, `/tables/${r.t1.id}/promise`), { user: r.wout, body: {} })).body.promised).toBe(true);
    const list = () => api('GET', o(org, '/promised-tables'), { user: r.wout });
    expect((await list()).body).toEqual([{ name: '1', zone: null, ready: false, promisedAt: expect.any(String) }]);
    // Paid, then cleaned: ready.
    await env.DB.prepare("UPDATE tabs SET status = 'closed', closed_at = ? WHERE id = ?").bind(new Date().toISOString(), tab.id).run();
    await new Promise((res) => setTimeout(res, 5));
    await api('POST', o(org, `/tables/${r.t1.id}/clear`), { user: r.wout });
    expect((await list()).body[0].ready).toBe(true);
    // The waiter screens and the entrance screens were told.
    expect(pushes).toContain('pos');
    expect(pushes).toContain('station');
    // Seated: no longer promised.
    await r.seat(r.t1);
    expect((await list()).body).toEqual([]);
    spy.mockRestore();
  });
});
