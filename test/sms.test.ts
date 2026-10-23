// "Your order is ready" by SMS — MESSAGING.md: the installation's Twilio
// account (MESSAGING_CONFIG), a number left on the order page, one SMS per
// station's ticket turning ready — only paid (or on a tab), never twice,
// within the daily maximum; the number gone once it's not needed.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiWith, payCash, rows, seedOrg, type TestOrg } from './helpers';

const CONFIG = { provider: 'twilio', accountSid: 'AC123', authToken: 'secret', sender: 'KABOUTERS', countries: ['+32', '+31'], dailyCap: 300 };
const withSms = (overrides: Partial<typeof CONFIG> = {}) => ({ MESSAGING_CONFIG: JSON.stringify({ ...CONFIG, ...overrides }) });

// Twilio's API, stubbed: what was sent.
let sent: { to: string; body: string; from: string | null; auth: string | null }[] = [];
let twilioStatus = 201;
function stubTwilio() {
  sent = [];
  twilioStatus = 201;
  const realFetch = globalThis.fetch;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
    const request = new Request(input, init);
    if (new URL(request.url).hostname === 'api.twilio.com') {
      const form = new URLSearchParams(await request.text());
      sent.push({ to: form.get('To')!, body: form.get('Body')!, from: form.get('From'), auth: request.headers.get('Authorization') });
      return twilioStatus === 201 ? Response.json({ sid: `SM${sent.length}` }, { status: 201 }) : Response.json({ code: 21211, message: "The 'To' number is not valid." }, { status: 400 });
    }
    return realFetch(input, init);
  });
}
afterEach(() => vi.restoreAllMocks());

// A venue: Frieten (Keuken), Pils (Bar); an event with one ordering mode on the QR.
async function venue(org: TestOrg, env: Record<string, string>) {
  const admin = async (method: string, path: string, body?: unknown) => {
    const res = await apiWith(env, method, `/organizations/${org.orgId}${path}`, { user: org.admin, body });
    if (res.status >= 300) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  };
  const kitchen = await admin('POST', '/catalog/stations', { name: 'Keuken' });
  const bar = await admin('POST', '/catalog/stations', { name: 'Bar' });
  const catalog = await admin('POST', '/catalogs', { name: 'Fuif' });
  const section = await admin('POST', `/catalogs/${catalog.id}/sections`, { name: 'Alles' });
  const add = async (name: string, priceCents: number, prepStationId: string) => {
    const product = await admin('POST', '/catalog/products', { name, prepStationId, variants: [{ name: '', code: name.toLowerCase() }] });
    await admin('POST', `/catalogs/${catalog.id}/entries`, { sectionId: section.id, variantId: product.variants[0].id, priceCents });
    return product.variants[0].id as string;
  };
  const frieten = await add('Frieten', 400, kitchen.id);
  const pils = await add('Pils', 250, bar.id);
  const event = await admin('POST', '/events', { name: 'Fuif', date: '2026-10-11' });
  const withMode = await admin('POST', `/events/${event.id}/modes`, { name: 'Take away', catalogId: catalog.id });
  const on = await admin('PATCH', `/events/${event.id}`, { selfOrderEnabled: true });
  return { admin, kitchen, bar, catalog, event, frieten, pils, modeId: withMode.modes[0].id as string, code: on.selfOrder.code as string };
}

const pub = (env: Record<string, string>, method: string, path: string, body?: unknown) => apiWith(env, method, `/public${path}`, { body });

async function placeAndPay(org: TestOrg, env: Record<string, string>, v: Awaited<ReturnType<typeof venue>>) {
  const placed = (await pub(env, 'POST', `/self-order/${v.code}/orders`, { lines: [{ variantId: v.frieten, quantity: 1 }, { variantId: v.pils, quantity: 1 }] })).body;
  const tabId = (await rows<{ id: string }>('SELECT id FROM tabs WHERE order_token = ?', placed.token))[0].id;
  return { ...placed, tabId, pay: () => payCash(org, tabId, 650) };
}

async function ticketOf(org: TestOrg, env: Record<string, string>, stationId: string, number: number) {
  const list = (await apiWith(env, 'GET', `/organizations/${org.orgId}/stations/${stationId}/tickets`, { user: org.cashier })).body;
  return list.find((t: any) => t.number === number);
}
const setStatus = (org: TestOrg, env: Record<string, string>, id: string, status: string) =>
  apiWith(env, 'POST', `/organizations/${org.orgId}/tickets/${id}`, { user: org.cashier, body: { status } });

// The SMS goes out in the background: wait for the ticket's outcome.
async function smsStatus(ticketId: string, until = (s: string | null) => s !== null && s !== 'sending') {
  let status: string | null = null;
  for (let i = 0; i < 100; i++) {
    status = (await rows<{ sms_status: string | null }>('SELECT sms_status FROM prep_tickets WHERE id = ?', ticketId))[0].sms_status;
    if (until(status)) return status;
    await new Promise((r) => setTimeout(r, 10));
  }
  return status;
}

describe('SMS when a station is ready', () => {
  it('per ordering mode, only when the installation can send', async () => {
    const org = await seedOrg();
    const v = await venue(org, withSms());
    const patch = (env: Record<string, string>, body: unknown) => apiWith(env, 'PATCH', `/organizations/${org.orgId}/events/${v.event.id}/modes/${v.modeId}`, { user: org.admin, body });
    expect((await patch({}, { notifySms: true })).body.code).toBe('sms_not_configured');
    const on = (await patch(withSms(), { notifySms: true })).body;
    expect(on).toMatchObject({ sms: true, modes: [{ notifySms: true }] });
    expect((await apiWith({}, 'GET', `/organizations/${org.orgId}/events`, { user: org.cashier })).body.find((e: any) => e.id === v.event.id).sms).toBe(false);
  });

  it('a number on the order page; one SMS per station as it turns ready - never twice; the number gone afterwards', async () => {
    stubTwilio();
    const env = withSms();
    const org = await seedOrg();
    const v = await venue(org, env);
    await v.admin('PATCH', `/events/${v.event.id}/modes/${v.modeId}`, { notifySms: true });
    const order = await placeAndPay(org, env, v);
    const notify = (phone: string) => pub(env, 'POST', `/orders/${order.token}/notify`, { phone });

    expect((await notify('+44 7700 900123')).body).toMatchObject({ code: 'invalid_phone', params: { countries: '+32, +31' } });
    expect((await notify('12')).body.code).toBe('invalid_phone');
    expect((await notify('0470 12.34/56')).body).toEqual({ ok: true, phone: '••• 56' });
    expect((await rows<any>('SELECT notify_phone FROM tabs WHERE id = ?', order.tabId))[0].notify_phone).toBe('+32470123456');
    expect((await pub(env, 'GET', `/orders/${order.token}`)).body.sms).toEqual({ available: true, phone: '••• 56', stations: [] });

    // Unpaid: a station making it ready sends nothing.
    const kitchen = await ticketOf(org, env, v.kitchen.id, order.number);
    await setStatus(org, env, kitchen.id, 'in_progress');
    await order.pay();
    // Paid, the kitchen's part ready: one SMS.
    await setStatus(org, env, kitchen.id, 'ready');
    expect(await smsStatus(kitchen.id)).toBe('sent');
    expect(sent).toEqual([{ to: '+32470123456', body: `Test org: je bestelling #${order.number} is klaar - Keuken.`, from: 'KABOUTERS', auth: `Basic ${btoa('AC123:secret')}` }]);
    // Back and ready again (a tap by mistake): not twice.
    await setStatus(org, env, kitchen.id, 'in_progress');
    await setStatus(org, env, kitchen.id, 'ready');
    await new Promise((r) => setTimeout(r, 100));
    expect(sent).toHaveLength(1);
    // The number is still needed: the bar isn't ready.
    expect((await rows<any>('SELECT notify_phone FROM tabs WHERE id = ?', order.tabId))[0].notify_phone).toBe('+32470123456');

    const bar = await ticketOf(org, env, v.bar.id, order.number);
    await setStatus(org, env, bar.id, 'ready');
    expect(await smsStatus(bar.id)).toBe('sent');
    expect(sent.map((s) => s.body)).toEqual([`Test org: je bestelling #${order.number} is klaar - Keuken.`, `Test org: je bestelling #${order.number} is klaar - Bar.`]);
    // Every station sent, the tab paid: the number is gone; the page still says what went.
    expect((await rows<any>('SELECT notify_phone FROM tabs WHERE id = ?', order.tabId))[0].notify_phone).toBeNull();
    expect((await pub(env, 'GET', `/orders/${order.token}`)).body.sms).toEqual({
      available: true,
      phone: null,
      stations: [{ name: 'Bar', status: 'sent' }, { name: 'Keuken', status: 'sent' }],
    });
    // The log holds no number.
    expect(await rows<any>('SELECT status, error FROM sms_log WHERE org_id = ? ORDER BY created_at', org.orgId)).toEqual([
      { status: 'sent', error: null },
      { status: 'sent', error: null },
    ]);
  });

  it('a self-order never paid: no SMS, and the number goes with the cancelled order', async () => {
    stubTwilio();
    const env = withSms();
    const org = await seedOrg();
    const v = await venue(org, env);
    await v.admin('PATCH', `/events/${v.event.id}/modes/${v.modeId}`, { notifySms: true });
    const order = await placeAndPay(org, env, v);
    await pub(env, 'POST', `/orders/${order.token}/notify`, { phone: '0470123456' });
    const kitchen = await ticketOf(org, env, v.kitchen.id, order.number);
    await setStatus(org, env, kitchen.id, 'ready');
    await new Promise((r) => setTimeout(r, 100));
    expect(sent).toEqual([]);
    expect((await rows<any>('SELECT sms_status FROM prep_tickets WHERE id = ?', kitchen.id))[0].sms_status).toBeNull();

    const { env: workerEnv } = await import('cloudflare:test');
    await workerEnv.DB.prepare('UPDATE tabs SET opened_at = ? WHERE id = ?').bind(new Date(Date.now() - 11 * 60_000).toISOString(), order.tabId).run();
    await apiWith(env, 'GET', `/organizations/${org.orgId}/stations/${v.kitchen.id}/tickets`, { user: org.cashier });
    expect((await rows<any>('SELECT status, notify_phone FROM tabs WHERE id = ?', order.tabId))[0]).toEqual({ status: 'cancelled', notify_phone: null });
  });

  it('the daily maximum: beyond it, no SMS - the page says it failed', async () => {
    stubTwilio();
    const env = withSms({ dailyCap: 1 });
    const org = await seedOrg();
    const v = await venue(org, env);
    await v.admin('PATCH', `/events/${v.event.id}/modes/${v.modeId}`, { notifySms: true });
    // Earlier today the installation already sent one (another org's, even).
    const { env: workerEnv } = await import('cloudflare:test');
    await workerEnv.DB.prepare(`DELETE FROM sms_log`).run();
    await workerEnv.DB.prepare(`INSERT INTO sms_log (id, org_id, status, created_at) VALUES (?, ?, 'sent', ?)`).bind(crypto.randomUUID(), org.orgId, new Date().toISOString()).run();
    const order = await placeAndPay(org, env, v);
    await order.pay();
    await pub(env, 'POST', `/orders/${order.token}/notify`, { phone: '+31612345678' });
    const kitchen = await ticketOf(org, env, v.kitchen.id, order.number);
    await setStatus(org, env, kitchen.id, 'ready');
    expect(await smsStatus(kitchen.id)).toBe('capped');
    expect(sent).toEqual([]);
    expect((await pub(env, 'GET', `/orders/${order.token}`)).body.sms.stations).toEqual([{ name: 'Keuken', status: 'failed' }]);
    await workerEnv.DB.prepare(`DELETE FROM sms_log`).run();
  });

  it('Twilio refusing it: marked failed, with its reason in the log', async () => {
    stubTwilio();
    twilioStatus = 400;
    const env = withSms();
    const org = await seedOrg();
    const v = await venue(org, env);
    await v.admin('PATCH', `/events/${v.event.id}/modes/${v.modeId}`, { notifySms: true });
    const order = await placeAndPay(org, env, v);
    await order.pay();
    await pub(env, 'POST', `/orders/${order.token}/notify`, { phone: '0470123456' });
    const kitchen = await ticketOf(org, env, v.kitchen.id, order.number);
    await setStatus(org, env, kitchen.id, 'ready');
    expect(await smsStatus(kitchen.id)).toBe('failed');
    expect((await rows<any>('SELECT error FROM sms_log WHERE ticket_id = ?', kitchen.id))[0].error).toBe("400 21211: The 'To' number is not valid.");
  });

  it('not offered when the ordering mode has no SMS, nor without an SMS account; a number can be taken back', async () => {
    const env = withSms();
    const org = await seedOrg();
    const v = await venue(org, env);
    const order = await placeAndPay(org, env, v);
    expect((await pub(env, 'GET', `/orders/${order.token}`)).body.sms).toBeNull();
    expect((await pub(env, 'POST', `/orders/${order.token}/notify`, { phone: '0470123456' })).body.code).toBe('sms_unavailable');
    await v.admin('PATCH', `/events/${v.event.id}/modes/${v.modeId}`, { notifySms: true });
    expect((await pub({}, 'POST', `/orders/${order.token}/notify`, { phone: '0470123456' })).body.code).toBe('sms_unavailable');
    expect((await pub(env, 'POST', `/orders/${order.token}/notify`, { phone: '0470123456' })).status).toBe(200);
    expect((await pub(env, 'DELETE', `/orders/${order.token}/notify`)).body).toEqual({ ok: true });
    expect((await rows<any>('SELECT notify_phone FROM tabs WHERE id = ?', order.tabId))[0].notify_phone).toBeNull();
  });
});

describe('phone numbers', () => {
  it('as typed → E.164 in an allowed country', async () => {
    const { normalizePhone } = await import('../src/messaging');
    expect(normalizePhone('0470 12 34 56', ['+32'])).toBe('+32470123456');
    expect(normalizePhone('0032 470 12 34 56', ['+32'])).toBe('+32470123456');
    expect(normalizePhone('+31 6 12345678', ['+32', '+31'])).toBe('+31612345678');
    expect(normalizePhone('06 12345678', ['+31', '+32'])).toBe('+31612345678');
    expect(normalizePhone('+33 6 12 34 56 78', ['+32'])).toBeNull();
    expect(normalizePhone('hallo', ['+32'])).toBeNull();
    expect(normalizePhone(undefined, ['+32'])).toBeNull();
  });
});

describe('a tab\'s contact number and the SMS', () => {
  it('the number given when opening a tab also gets the "ready" SMS, when the mode sends them', async () => {
    const env = withSms();
    const org = await seedOrg();
    const v = await venue(org, env);
    await v.admin('PATCH', `/events/${v.event.id}/modes/${v.modeId}`, { notifySms: true, tabs: true, tabContact: true });
    const placed = (await pub(env, 'POST', `/self-order/${v.code}/orders`, { lines: [{ variantId: v.pils, quantity: 1 }], contact: { name: 'Jan', phone: '0470123456' } })).body;
    expect((await pub(env, 'GET', `/orders/${placed.token}`)).body.sms).toMatchObject({ available: true, phone: '••• 56' });
  });
});
