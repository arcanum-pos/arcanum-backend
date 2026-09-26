// Events as an optional reporting tag (DOMAIN_MODEL.md decision 1): the
// kassa sends its chosen event when it opens a tab; every sale paid on
// that tab carries it into the transactions ledger.
import { describe, expect, it } from 'vitest';
import { api, chargeCash, confirmCharge, createTab, line, payCash, rows, seedOrg, tabsPath, type TestOrg } from './helpers';

async function createEvent(org: TestOrg, name = 'Fietstocht 2026') {
  const res = await api('POST', `/organizations/${org.orgId}/events`, { user: org.admin, body: { name, date: '2026-10-04' } });
  expect(res.status).toBe(201);
  return res.body as { id: string; name: string };
}

describe('event on a tab', () => {
  it('tags the tab and every sale paid on it', async () => {
    const org = await seedOrg();
    const event = await createEvent(org);
    const tab = await createTab(org, { label: 'Toog', eventId: event.id, lines: [line('bon', 'Bonnen', 100, 5)] });
    expect([tab.eventId, tab.eventName]).toEqual([event.id, 'Fietstocht 2026']);

    await payCash(org, tab.id, 500);
    const [tx] = await rows<{ event_id: string | null }>('SELECT event_id FROM transactions WHERE tab_id = ?', tab.id);
    expect(tx.event_id).toBe(event.id);
    // The existing per-event report filter now finds it.
    const listed = await api('GET', `/transactions?orgId=${org.orgId}&eventId=${event.id}`, { user: org.admin });
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(1);
  });

  it('is optional: no event, no tag', async () => {
    const org = await seedOrg();
    const tab = await createTab(org, { label: 'Tafel 1', lines: [line('bon', 'Bonnen', 100, 2)] });
    expect([tab.eventId, tab.eventName]).toEqual([null, null]);
    await payCash(org, tab.id, 200);
    const [tx] = await rows<{ event_id: string | null }>('SELECT event_id FROM transactions WHERE tab_id = ?', tab.id);
    expect(tx.event_id).toBeNull();
    expect((await createTab(org, { label: 'Tafel 2', eventId: null })).eventId).toBeNull();
  });

  it("refuses another org's event or an unknown one", async () => {
    const org = await seedOrg();
    const other = await seedOrg();
    const foreign = await createEvent(other);
    for (const eventId of [foreign.id, 'nope', 42]) {
      const res = await api('POST', tabsPath(org.orgId), { user: org.cashier, body: { label: 'X', eventId } });
      expect(res.status, String(eventId)).toBe(400);
    }
    expect(await rows('SELECT id FROM tabs WHERE org_id = ?', org.orgId)).toHaveLength(0);
  });

  it('the customer display gets the event name with the order', async () => {
    const org = await seedOrg();
    const event = await createEvent(org, 'Spaghettiavond');
    const tab = await createTab(org, { label: 'Tafel 3', eventId: event.id, lines: [line('bon', 'Bonnen', 100, 3)] });
    const charge = await chargeCash(org, tab.id, 300);
    const status = await api('GET', `/sumup/status/${charge.body.chargeId}`, { user: org.cashier });
    expect(status.body.order.eventName).toBe('Spaghettiavond');
    await confirmCharge(org, charge.body.chargeId);
  });
});
