// Staff on shared devices (src/staff.ts, DOMAIN_MODEL.md "Staff on shared
// devices", release B1): the list (admins manage it), a person chosen on a
// device with a signed token — after their PIN, if they have one — and that
// person recorded on what the device does; a requirement to choose one.
import { describe, expect, it } from 'vitest';
import { api, apiWith, chargeCash, DEVICE, line, orderBody, rows, seedOrg, tabsPath, type TestOrg } from './helpers';

const staffPath = (org: TestOrg, suffix = '') => `/organizations/${org.orgId}/staff${suffix}`;

async function addStaff(org: TestOrg, name: string, pin?: string) {
  const res = await api('POST', staffPath(org), { user: org.admin, body: { name, ...(pin ? { pin } : {}) } });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; name: string; hasPin: boolean };
}

async function tokenFor(org: TestOrg, staffId: string, pin?: string) {
  const res = await api('POST', staffPath(org, `/${staffId}/token`), { user: org.cashier, body: pin ? { pin } : {} });
  return res;
}

// The kassa as the cashier, with a person chosen on it.
const asPerson = (org: TestOrg, token: string | null, method: string, path: string, body?: unknown) =>
  apiWith({}, method, path, { user: org.cashier, body, headers: token ? { 'X-Staff': token } : {} });

describe('the staff list', () => {
  it('admins manage it; the kassa role reads it (names, whether there is a PIN - never the PIN)', async () => {
    const org = await seedOrg();
    expect((await api('POST', staffPath(org), { user: org.cashier, body: { name: 'Jan' } })).status).toBe(403);
    const jan = await addStaff(org, 'Jan', '1234');
    await addStaff(org, 'An');
    expect((await api('POST', staffPath(org), { user: org.admin, body: { name: 'jan' } })).body.code).toBe('staff_name_taken');
    expect((await api('POST', staffPath(org), { user: org.admin, body: { name: 'Piet', pin: '12' } })).body.code).toBe('staff_pin_invalid');

    const list = await api('GET', staffPath(org), { user: org.cashier });
    expect(list.body).toEqual({ required: false, staff: [{ id: expect.any(String), name: 'An', hasPin: false }, { id: jan.id, name: 'Jan', hasPin: true }] });
    expect(JSON.stringify(list.body)).not.toContain('1234');
    // Archived: gone from the list (an admin still sees it with ?all=1).
    expect((await api('PATCH', staffPath(org, `/${jan.id}`), { user: org.cashier, body: { archived: true } })).status).toBe(403);
    await api('PATCH', staffPath(org, `/${jan.id}`), { user: org.admin, body: { archived: true } });
    expect((await api('GET', staffPath(org), { user: org.cashier })).body.staff.map((s: any) => s.name)).toEqual(['An']);
    expect((await api('GET', staffPath(org, '?all=1'), { user: org.admin })).body.staff.map((s: any) => [s.name, s.archived])).toEqual([['An', false], ['Jan', true]]);
    // Another organisation sees none of it.
    const other = await seedOrg();
    expect((await api('GET', staffPath(org), { user: other.cashier })).status).toBe(403);
  });
});

describe('choosing a person on a device', () => {
  it('without a PIN: a tap; with one: only the right PIN - 5 wrong a minute, then wait', async () => {
    const org = await seedOrg();
    const an = await addStaff(org, 'An');
    const jan = await addStaff(org, 'Jan', '4321');
    const free = await tokenFor(org, an.id);
    expect(free.body).toMatchObject({ token: expect.stringContaining('.'), staff: { id: an.id, name: 'An' } });
    expect((await tokenFor(org, jan.id)).body.code).toBe('staff_pin_wrong');
    expect((await tokenFor(org, jan.id, '4321')).status).toBe(200);
    for (let i = 0; i < 4; i++) expect((await tokenFor(org, jan.id, '0000')).status).toBe(403);
    expect((await tokenFor(org, jan.id, '4321')).body.code).toBe('staff_pin_too_many');
  });

  it('what a device does is recorded with its person - taken from the token, never from what a browser says', async () => {
    const org = await seedOrg();
    const an = await addStaff(org, 'An');
    const token = (await tokenFor(org, an.id)).body.token as string;
    const body = await orderBody(org, { ...DEVICE, lines: [line('pils', 'Pils', 300, 2)] });
    const tab = await asPerson(org, token, 'POST', tabsPath(org.orgId), body);
    expect(tab.status, JSON.stringify(tab.body)).toBe(201);
    expect(tab.body.openedByStaff).toBe('An');
    const charge = await apiWith({}, 'POST', '/sumup/charge', { user: org.cashier, body: { orgId: org.orgId, method: 'cash', tabId: tab.body.id, amount: 600, ...DEVICE }, headers: { 'X-Staff': token } });
    expect(charge.status).toBe(201);
    await api('POST', '/sumup/confirm', { user: org.cashier, body: { chargeId: charge.body.chargeId, success: true } });
    expect(await rows('SELECT staff_id, staff_name FROM orders WHERE tab_id = ?', tab.body.id)).toEqual([{ staff_id: an.id, staff_name: 'An' }]);
    expect(await rows('SELECT staff_name FROM charges WHERE tab_id = ?', tab.body.id)).toEqual([{ staff_name: 'An' }]);
    expect(await rows('SELECT staff_name FROM transactions WHERE tab_id = ?', tab.body.id)).toEqual([{ staff_name: 'An' }]);
    const detail = (await api('GET', tabsPath(org.orgId, `/${tab.body.id}`), { user: org.cashier })).body;
    expect(detail.orders[0].staffName).toBe('An');

    // A made-up token, another organisation's, or none: nobody (still allowed — S2).
    for (const bad of ['x.y', `${token}x`, null]) {
      const t = await asPerson(org, bad, 'POST', tabsPath(org.orgId), body);
      expect(t.status).toBe(201);
      expect(t.body.openedByStaff).toBeNull();
    }
    const other = await seedOrg();
    const elsewhere = (await tokenFor(other, (await addStaff(other, 'Mie')).id)).body.token;
    expect((await asPerson(org, elsewhere, 'POST', tabsPath(org.orgId), body)).body.openedByStaff).toBeNull();
  });

  it('archived, or a new PIN: devices that chose them before must choose again', async () => {
    const org = await seedOrg();
    const an = await addStaff(org, 'An');
    const body = await orderBody(org, { ...DEVICE, lines: [line('pils', 'Pils', 300, 1)] });
    const before = (await tokenFor(org, an.id)).body.token;
    await new Promise((r) => setTimeout(r, 5));
    await api('PATCH', staffPath(org, `/${an.id}`), { user: org.admin, body: { pin: '1111' } });
    expect((await asPerson(org, before, 'POST', tabsPath(org.orgId), body)).body.openedByStaff).toBeNull();
    const after = (await tokenFor(org, an.id, '1111')).body.token;
    expect((await asPerson(org, after, 'POST', tabsPath(org.orgId), body)).body.openedByStaff).toBe('An');
    await api('PATCH', staffPath(org, `/${an.id}`), { user: org.admin, body: { archived: true } });
    expect((await asPerson(org, after, 'POST', tabsPath(org.orgId), body)).body.openedByStaff).toBeNull();
  });
});

describe('an organisation that requires a person (S2)', () => {
  it('refuses selling and payments without one - admins switch it on', async () => {
    const org = await seedOrg();
    expect((await api('PUT', `/organizations/${org.orgId}/staff-settings`, { user: org.cashier, body: { required: true } })).status).toBe(403);
    expect((await api('PUT', `/organizations/${org.orgId}/staff-settings`, { user: org.admin, body: { required: true } })).body).toEqual({ required: true });
    expect((await api('GET', staffPath(org), { user: org.cashier })).body.required).toBe(true);
    const body = await orderBody(org, { ...DEVICE, lines: [line('pils', 'Pils', 300, 1)] });
    expect((await asPerson(org, null, 'POST', tabsPath(org.orgId), body)).body.code).toBe('staff_required');
    const token = (await tokenFor(org, (await addStaff(org, 'An')).id)).body.token;
    const tab = await asPerson(org, token, 'POST', tabsPath(org.orgId), body);
    expect(tab.status).toBe(201);
    expect((await chargeCash(org, tab.body.id, 300)).body.code).toBe('staff_required');
  });

  it("doesn't apply to a personal device: the account says who, or its linked staff member", async () => {
    const org = await seedOrg();
    await api('PUT', `/organizations/${org.orgId}/staff-settings`, { user: org.admin, body: { required: true } });
    const body = await orderBody(org, { ...DEVICE, lines: [line('pils', 'Pils', 300, 1)] });
    const personal = (b: unknown) => apiWith({}, 'POST', tabsPath(org.orgId), { user: org.cashier, body: b, headers: { 'X-Arcanum-Device': 'personal' } });
    const tab = await personal(body);
    expect(tab.status).toBe(201);
    expect(tab.body.openedByStaff).toBeNull();
    // Linked to the cashier's membership: that person is recorded.
    const [membership] = await rows<{ id: string }>('SELECT id FROM memberships WHERE org_id = ? AND user_sub = ?', org.orgId, org.cashier.sub);
    const an = await addStaff(org, 'An');
    await api('PATCH', staffPath(org, `/${an.id}`), { user: org.admin, body: { memberId: membership.id } });
    expect((await personal(body)).body.openedByStaff).toBe('An');
    // Someone else's account isn't linked: nobody.
    const mine = await apiWith({}, 'POST', tabsPath(org.orgId), { user: org.admin, body, headers: { 'X-Arcanum-Device': 'personal' } });
    expect(mine.body.openedByStaff).toBeNull();
  });
});

describe('who is making a ticket', () => {
  async function kitchenTicket(org: TestOrg) {
    const admin = async (method: string, path: string, b?: unknown) => (await api(method, `/organizations/${org.orgId}${path}`, { user: org.admin, body: b })).body;
    const kitchen = await admin('POST', '/catalog/stations', { name: 'Keuken' });
    const catalog = await admin('POST', '/catalogs', { name: 'Fuif' });
    const section = await admin('POST', `/catalogs/${catalog.id}/sections`, { name: 'Alles' });
    const product = await admin('POST', '/catalog/products', { name: 'Frieten', prepStationId: kitchen.id, variants: [{ name: '' }] });
    await admin('POST', `/catalogs/${catalog.id}/entries`, { sectionId: section.id, variantId: product.variants[0].id, priceCents: 300 });
    await api('POST', tabsPath(org.orgId), { user: org.cashier, body: { ...DEVICE, catalogId: catalog.id, lines: [{ variantId: product.variants[0].id, quantity: 1 }] } });
    const [ticket] = await rows<{ id: string }>('SELECT id FROM prep_tickets WHERE org_id = ?', org.orgId);
    return { stationId: kitchen.id as string, ticketId: ticket.id };
  }
  const listed = async (org: TestOrg, stationId: string) => (await api('GET', `/organizations/${org.orgId}/stations/${stationId}/tickets`, { user: org.cashier })).body[0];

  it("Start records the device's person; back to Besteld frees it (S3); passed on to someone else; no person is fine (S4)", async () => {
    const org = await seedOrg();
    const { stationId, ticketId } = await kitchenTicket(org);
    const an = await addStaff(org, 'An');
    const jan = await addStaff(org, 'Jan');
    const token = (await tokenFor(org, an.id)).body.token;
    const move = (status: string, t: string | null = token) => asPerson(org, t, 'POST', `/organizations/${org.orgId}/tickets/${ticketId}`, { status });

    expect((await move('in_progress')).body.claimedBy).toBe('An');
    expect((await listed(org, stationId)).claimedBy).toMatchObject({ id: an.id, name: 'An' });
    // Ready and back keeps who makes it.
    await move('ready');
    await move('in_progress', null);
    expect((await listed(org, stationId)).claimedBy.name).toBe('An');
    // Passed on.
    const passed = await api('POST', `/organizations/${org.orgId}/tickets/${ticketId}/claim`, { user: org.cashier, body: { staffId: jan.id } });
    expect(passed.body.claimedBy).toEqual({ id: jan.id, name: 'Jan' });
    expect((await api('POST', `/organizations/${org.orgId}/tickets/${ticketId}/claim`, { user: org.cashier, body: { staffId: 'nobody' } })).status).toBe(404);
    // Given back: in the queue again, nobody's.
    await move('ordered');
    expect((await listed(org, stationId)).claimedBy).toBeNull();
    // Started with nobody chosen: no name.
    await move('in_progress', null);
    expect((await listed(org, stationId)).claimedBy).toBeNull();
  });
});
