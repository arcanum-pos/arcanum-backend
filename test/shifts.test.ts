// Registers, shifts and kasopmaak (src/shifts.ts, DOMAIN_MODEL.md, release
// B2): a register (cash drawer) sells only while its shift is open; money
// belongs to the shift it was paid in; the kasopmaak counts the drawer
// against the cash formula; blind count hides the expected cash until then.
import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { api, chargeCash, confirmCharge, createTab, line, payCash, rows, seedOrg, type TestOrg } from './helpers';

const o = (org: TestOrg, path = '') => `/organizations/${org.orgId}${path}`;

async function register(org: TestOrg, name = 'Toog') {
  const res = await api('POST', o(org, '/registers'), { user: org.admin, body: { name } });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

const openShift = (org: TestOrg, registerId: string, body: Record<string, unknown>) => api('POST', o(org, `/registers/${registerId}/shift`), { user: org.cashier, body });
const current = async (org: TestOrg, registerId: string) => (await api('GET', o(org, `/registers/${registerId}/shift`), { user: org.cashier })).body;

describe('registers', () => {
  it('admins make and rename them; the kassa role lists them; an open one is not archived', async () => {
    const org = await seedOrg();
    expect((await api('POST', o(org, '/registers'), { user: org.cashier, body: { name: 'Toog' } })).status).toBe(403);
    const toog = await register(org);
    await api('PATCH', o(org, `/registers/${toog}`), { user: org.admin, body: { name: 'Toog 1' } });
    expect((await api('GET', o(org, '/registers'), { user: org.cashier })).body).toEqual({
      blindCount: false,
      registers: [{ id: toog, name: 'Toog 1', archived: false, open: false, createdAt: expect.any(String) }],
    });
    await openShift(org, toog, { floatCents: 5000 });
    expect((await api('PATCH', o(org, `/registers/${toog}`), { user: org.admin, body: { archived: true } })).body.code).toBe('register_open');
  });
});

describe('selling on a register', () => {
  it('only while its shift is open; a kassa without a register sells as before', async () => {
    const org = await seedOrg();
    const toog = await register(org);
    const sale = { lines: [line('pils', 'Pils', 300, 1)] };
    await expect(createTab(org, { ...sale, registerId: toog })).rejects.toThrow(/register_closed/);
    await expect(createTab(org, sale)).resolves.toMatchObject({ status: 'open' });
    await openShift(org, toog, { floatCents: 5000 });
    const tab = await createTab(org, { ...sale, registerId: toog });
    expect((await chargeCash(org, tab.id, 300, { registerId: 'nope' })).body.code).toBe('register_not_found');
  });

  it('money belongs to the shift it was paid in - a tab opened in shift 1, paid in shift 2', async () => {
    const org = await seedOrg();
    const toog = await register(org);
    const first = (await openShift(org, toog, { floatCents: 5000 })).body;
    const tab = await createTab(org, { lines: [line('pils', 'Pils', 300, 2)], registerId: toog });
    const closed = await api('POST', o(org, `/shifts/${first.id}/close`), { user: org.cashier, body: { countedCents: 5000, leftInDrawerCents: 5000 } });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    const second = (await openShift(org, toog, { floatCents: 5000 })).body;
    const charge = await chargeCash(org, tab.id, 600, { registerId: toog });
    await confirmCharge(org, charge.body.chargeId);
    expect(await rows('SELECT shift_id FROM charges WHERE id = ?', charge.body.chargeId)).toEqual([{ shift_id: second.id }]);
    expect(await rows('SELECT shift_id FROM transactions WHERE tab_id = ?', tab.id)).toEqual([{ shift_id: second.id }]);
  });
});

describe('a shift, from Kassa openen to kasopmaak', () => {
  it('opened once (counted per denomination), the cash formula live, closed with the count; the next one suggests what stayed', async () => {
    const org = await seedOrg();
    const toog = await register(org);
    const pushes: string[] = [];
    const spy = vi.spyOn(env.ARCANUM_DEVICEHUB_SERVICE, 'fetch').mockImplementation(async (input: any, init?: any) => {
      const req = new Request(input, init);
      if (new URL(req.url).pathname === '/devices/broadcast-org') pushes.push((await req.json() as any).event);
      return Response.json({ ok: true });
    });
    expect((await current(org, toog))).toMatchObject({ shift: null, suggestedFloatCents: null });

    // € 50 in notes and coins.
    const opened = await openShift(org, toog, { count: { '2000': 2, '500': 1, '200': 2, '100': 1 } });
    expect(opened.status).toBe(201);
    expect(opened.body).toMatchObject({ number: 1, status: 'open', openingFloatCents: 5000, expectedCents: 5000 });
    expect((await openShift(org, toog, { floatCents: 1000 })).body.code).toBe('shift_already_open');

    // Cash € 12 (with a € 1 tip), SumUp € 8, cash in € 20, out € 5.
    const t1 = await createTab(org, { lines: [line('pils', 'Pils', 300, 4)], registerId: toog });
    const cash = await chargeCash(org, t1.id, 1300, { registerId: toog, tipCents: 100 });
    await confirmCharge(org, cash.body.chargeId);
    const t2 = await createTab(org, { lines: [line('wijn', 'Wijn', 400, 2)], registerId: toog });
    const card = await api('POST', '/sumup/charge', { user: org.cashier, body: { orgId: org.orgId, method: 'sumup', tabId: t2.id, amount: 800, registerId: toog } });
    await confirmCharge(org, card.body.chargeId);
    const shiftId = opened.body.id;
    await api('POST', o(org, `/shifts/${shiftId}/movements`), { user: org.cashier, body: { direction: 'in', amountCents: 2000, reason: 'Extra wisselgeld' } });
    await api('POST', o(org, `/shifts/${shiftId}/movements`), { user: org.cashier, body: { direction: 'out', amountCents: 500, reason: 'IJs' } });
    expect((await api('POST', o(org, `/shifts/${shiftId}/movements`), { user: org.cashier, body: { direction: 'out', amountCents: 500 } })).body.code).toBe('movement_invalid');

    const live = (await current(org, toog)).shift;
    expect(live.totals).toEqual({ methods: { cash: { count: 1, cents: 1300, tipCents: 100 }, sumup: { count: 1, cents: 800, tipCents: 0 } }, cashIn: 2000, cashOut: 500 });
    // 50 + 13 + 20 − 5
    expect(live.expectedCents).toBe(7800);
    expect(live.movements.map((m: any) => [m.direction, m.amountCents, m.reason])).toEqual([['in', 2000, 'Extra wisselgeld'], ['out', 500, 'IJs']]);

    // € 2 short: a note is needed; what stays can't be more than what's there.
    const close = (body: Record<string, unknown>) => api('POST', o(org, `/shifts/${shiftId}/close`), { user: org.cashier, body });
    expect((await close({ countedCents: 7600, leftInDrawerCents: 5000 })).body.code).toBe('shift_note_required');
    expect((await close({ countedCents: 7600, leftInDrawerCents: 8000, note: 'x' })).body.code).toBe('shift_count_invalid');
    const done = await close({ countedCents: 7600, note: 'Fout teruggegeven', leftInDrawerCents: 5000 });
    expect(done.body).toMatchObject({ status: 'closed', countedCents: 7600, expectedCents: 7800, differenceCents: -200, note: 'Fout teruggegeven', leftInDrawerCents: 5000 });
    expect((await close({ countedCents: 7600 })).body.code).toBe('shift_closed');
    expect(pushes).toEqual(['shift_changed', 'shift_changed']);

    // Closed: selling refused again; the next shift starts from what stayed.
    expect((await chargeCash(org, t1.id, 100, { registerId: toog })).body.code).toBe('register_closed');
    expect(await current(org, toog)).toMatchObject({ shift: null, suggestedFloatCents: 5000 });
    expect((await api('GET', o(org, '/shifts'), { user: org.cashier })).body[0]).toMatchObject({ number: 1, registerName: 'Toog', differenceCents: -200 });
    spy.mockRestore();
  });

  it('who worked on it: everyone who took a payment (with how many), who opened and closed it - on the kassa and in the list', async () => {
    const org = await seedOrg();
    const toog = await register(org);
    const opened = await openShift(org, toog, { floatCents: 5000 });
    const pay = async (user: TestOrg['admin'], cents: number) => {
      const tab = await createTab(org, { lines: [line('pils', 'Pils', cents, 1)], registerId: toog });
      const charge = await api('POST', '/sumup/charge', { user, body: { orgId: org.orgId, method: 'cash', tabId: tab.id, amount: cents, registerId: toog } });
      await api('POST', '/sumup/confirm', { user, body: { chargeId: charge.body.chargeId } });
    };
    await pay(org.admin, 300);
    await pay(org.admin, 300);
    await pay(org.cashier, 300);
    expect((await current(org, toog)).shift.people).toEqual([
      { name: org.admin.name, payments: 2 },
      { name: org.cashier.name, payments: 1 },
    ]);
    const done = await api('POST', o(org, `/shifts/${opened.body.id}/close`), { user: org.admin, body: { countedCents: 5900, leftInDrawerCents: 5000 } });
    expect(done.body.people).toEqual([
      { name: org.admin.name, payments: 2 },
      { name: org.cashier.name, payments: 1 },
    ]);
    expect((await api('GET', o(org, '/shifts'), { user: org.cashier })).body[0].people).toEqual(done.body.people);
  });

  it('not closed while a payment on it is under way', async () => {
    const org = await seedOrg();
    const toog = await register(org);
    const shift = (await openShift(org, toog, { floatCents: 0 })).body;
    const tab = await createTab(org, { lines: [line('pils', 'Pils', 300, 1)], registerId: toog });
    const pending = await chargeCash(org, tab.id, 300, { registerId: toog });
    const close = () => api('POST', o(org, `/shifts/${shift.id}/close`), { user: org.cashier, body: { countedCents: 300, leftInDrawerCents: 0 } });
    expect((await close()).body.code).toBe('shift_payment_pending');
    await confirmCharge(org, pending.body.chargeId);
    expect((await close()).body.status).toBe('closed');
    // Open tabs only warn: they go on in the next shift.
    expect((await current(org, toog)).shift).toBeNull();
  });

  it('blind count (an admin setting): the expected cash only after the count - no note needed', async () => {
    const org = await seedOrg();
    const toog = await register(org);
    expect((await api('PUT', o(org, '/shift-settings'), { user: org.cashier, body: { blindCount: true } })).status).toBe(403);
    await api('PUT', o(org, '/shift-settings'), { user: org.admin, body: { blindCount: true } });
    const shift = (await openShift(org, toog, { floatCents: 5000 })).body;
    expect(shift.expectedCents).toBeNull();
    const tab = await createTab(org, { lines: [line('pils', 'Pils', 300, 1)], registerId: toog });
    await payCash(org, tab.id, 300).catch(() => null);
    expect((await current(org, toog)).shift.expectedCents).toBeNull();
    const done = await api('POST', o(org, `/shifts/${shift.id}/close`), { user: org.cashier, body: { countedCents: 4000, leftInDrawerCents: 0 } });
    expect(done.body).toMatchObject({ status: 'closed', expectedCents: 5000, differenceCents: -1000 });
  });
});
