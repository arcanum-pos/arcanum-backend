// Device keys (src/device-keys.ts, DOMAIN_MODEL.md "Devices"): a station
// screen or customer display paired with its code alone gets its own key —
// and that key reaches only the device's own few things. Each "can't" here
// is a promise the design depends on.
import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, DEVICE, rows, seedOrg, tabsPath, type TestOrg } from './helpers';

interface Device {
  terminal_id: string;
  org_id: string;
  role: string;
  linked_to: string | null;
  name: string | null;
}
let registry: Map<string, Device>;

beforeEach(() => {
  registry = new Map();
  // arcanum-devicehub, in memory.
  vi.spyOn(env.ARCANUM_DEVICEHUB_SERVICE, 'fetch').mockImplementation(async (input: any, init?: any) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body = (request.method === 'GET' ? null : await request.json().catch(() => null)) as any;
    const p = url.pathname;
    if (p === '/devices/register') {
      registry.set(body.terminal_id, { terminal_id: body.terminal_id, org_id: body.org_id, role: body.role, linked_to: null, name: body.name ?? null });
      return Response.json(registry.get(body.terminal_id));
    }
    if (p === '/devices/remove') {
      registry.delete(body.terminal_id);
      return Response.json({ ok: true });
    }
    if (p === '/devices/link') {
      registry.get(body.terminal_id)!.linked_to = body.pos_terminal_id;
      return Response.json(registry.get(body.terminal_id));
    }
    if (p === '/devices/unlink') return Response.json({ ok: true });
    if (p === '/devices/ws-token') return Response.json({ token: `ws-for-${url.searchParams.get('terminal_id')}` });
    if (p === '/devices/tabs-changed') return Response.json({ ok: true });
    let m = p.match(/^\/devices\/(.+)\/linked$/);
    if (m) return Response.json([...registry.values()].find((d) => d.linked_to === decodeURIComponent(m![1])) ?? null);
    m = p.match(/^\/devices\/(.+)$/);
    if (m) return registry.has(decodeURIComponent(m[1])) ? Response.json(registry.get(decodeURIComponent(m[1]))) : Response.json({ error: 'Unknown terminal_id' }, { status: 404 });
    return Response.json({ ok: true });
  });
});

// A request as arcanum-bff sends it for a device: no person, its key.
async function asDevice(key: string | null, method: string, path: string, body?: unknown, ip = '203.0.113.7') {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip };
  if (key) headers['X-Device-Key'] = key;
  const res = await SELF.fetch(`https://backend.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function code(org: TestOrg, body: Record<string, unknown>) {
  const res = await api('POST', `/organizations/${org.orgId}/device-pairings`, { user: org.admin, body });
  expect(res.status).toBe(201);
  return res.body.code as string;
}

// A kitchen and a bar, a product each, and a kassa order for both: a ticket per station.
async function venue(org: TestOrg) {
  const admin = async (method: string, path: string, body?: unknown) => (await api(method, `/organizations/${org.orgId}${path}`, { user: org.admin, body })).body;
  const kitchen = await admin('POST', '/catalog/stations', { name: 'Keuken' });
  const bar = await admin('POST', '/catalog/stations', { name: 'Bar' });
  const catalog = await admin('POST', '/catalogs', { name: 'Fuif' });
  const section = await admin('POST', `/catalogs/${catalog.id}/sections`, { name: 'Alles' });
  const add = async (name: string, prepStationId: string) => {
    const product = await admin('POST', '/catalog/products', { name, prepStationId, variants: [{ name: '' }] });
    await admin('POST', `/catalogs/${catalog.id}/entries`, { sectionId: section.id, variantId: product.variants[0].id, priceCents: 300 });
    return product.variants[0].id as string;
  };
  const frieten = await add('Frieten', kitchen.id);
  const pils = await add('Pils', bar.id);
  await api('POST', tabsPath(org.orgId), { user: org.cashier, body: { ...DEVICE, catalogId: catalog.id, lines: [{ variantId: frieten, quantity: 1 }, { variantId: pils, quantity: 1 }] } });
  const ticketOf = async (stationId: string) => (await rows<{ id: string }>('SELECT id FROM prep_tickets WHERE org_id = ? AND station_id = ?', org.orgId, stationId))[0].id;
  return { kitchen, bar, kitchenTicket: await ticketOf(kitchen.id), barTicket: await ticketOf(bar.id) };
}

describe('pairing with the code alone', () => {
  it('a station screen: paired without anyone signed in, with its own key (only its hash kept)', async () => {
    const org = await seedOrg();
    const v = await venue(org);
    const paired = await asDevice(null, 'POST', '/public/pair', { code: await code(org, { role: 'station', name: 'Scherm keuken', stationId: v.kitchen.id }) });
    expect(paired.status).toBe(201);
    expect(paired.body).toMatchObject({ role: 'station', orgId: org.orgId, name: 'Scherm keuken', stationId: v.kitchen.id, deviceKey: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
    expect(registry.get(paired.body.terminalId)).toMatchObject({ role: 'station', org_id: org.orgId });
    const stored = await rows<any>('SELECT key_hash, role FROM device_keys WHERE terminal_id = ?', paired.body.terminalId);
    expect(stored).toEqual([{ key_hash: expect.stringMatching(/^[0-9a-f]{64}$/), role: 'station' }]);
    expect(JSON.stringify(stored)).not.toContain(paired.body.deviceKey);
    // Once.
    expect((await asDevice(null, 'POST', '/public/pair', { code: 'XXXX-XXXX' })).body.code).toBe('pairing_code_invalid');
  });

  it("a kassa's code: needs someone signed in — and isn't used up by trying", async () => {
    const org = await seedOrg();
    const kassaCode = await code(org, { role: 'pos', name: 'Kassa 2' });
    expect((await asDevice(null, 'POST', '/public/pair', { code: kassaCode })).body).toMatchObject({ code: 'pairing_needs_login', role: 'pos' });
    const claimed = await api('POST', '/organizations/device-pairings/claim', { user: org.cashier, body: { code: kassaCode } });
    expect(claimed.status).toBe(201);
    expect(claimed.body.deviceKey).toBeUndefined();
  });

  it('wrong codes are limited per address', async () => {
    const ip = `198.51.100.${Math.floor(Math.random() * 200)}`;
    for (let i = 0; i < 10; i++) expect((await asDevice(null, 'POST', '/public/pair', { code: 'AAAA-AAAA' }, ip)).status).toBe(400);
    expect((await asDevice(null, 'POST', '/public/pair', { code: 'AAAA-AAAA' }, ip)).body.code).toBe('pairing_too_many_attempts');
  });
});

describe("a station screen's key: its own station, nothing else", () => {
  it('its tickets and moving them on; never another station, another device, or the rest of the organisation', async () => {
    const org = await seedOrg();
    const v = await venue(org);
    const paired = (await asDevice(null, 'POST', '/public/pair', { code: await code(org, { role: 'station', name: 'Scherm keuken', stationId: v.kitchen.id }) })).body;
    const key = paired.deviceKey as string;
    const o = `/organizations/${org.orgId}`;

    expect((await asDevice(key, 'GET', `${o}/devices/${paired.terminalId}`)).body).toMatchObject({ terminal_id: paired.terminalId, station_id: v.kitchen.id });
    const tickets = await asDevice(key, 'GET', `${o}/stations/${v.kitchen.id}/tickets`);
    expect(tickets.status).toBe(200);
    expect(tickets.body.map((t: any) => t.id)).toEqual([v.kitchenTicket]);
    const moved = await asDevice(key, 'POST', `${o}/tickets/${v.kitchenTicket}`, { status: 'ready' });
    expect(moved.body.status).toBe('ready');
    expect((await rows<any>('SELECT updated_by FROM prep_tickets WHERE id = ?', v.kitchenTicket))[0].updated_by).toBe('Scherm Keuken');
    expect((await asDevice(key, 'GET', `/organizations/device-ws-token?terminal_id=${paired.terminalId}`)).body).toEqual({ token: `ws-for-${paired.terminalId}` });

    // Not another station's, nor its tickets.
    expect((await asDevice(key, 'GET', `${o}/stations/${v.bar.id}/tickets`)).status).toBe(403);
    expect((await asDevice(key, 'POST', `${o}/tickets/${v.barTicket}`, { status: 'ready' })).status).toBe(403);
    // Not another device, nor its socket.
    const other = (await asDevice(null, 'POST', '/public/pair', { code: await code(org, { role: 'station', name: 'Scherm bar', stationId: v.bar.id }) })).body;
    expect((await asDevice(key, 'GET', `${o}/devices/${other.terminalId}`)).status).toBe(401);
    expect((await asDevice(key, 'GET', `/organizations/device-ws-token?terminal_id=${other.terminalId}`)).status).toBe(403);
    // Not the rest: tabs, events, menus, members, devices, the organisation itself.
    for (const path of [`${o}/tabs`, `${o}/events`, `${o}/catalogs`, `${o}/members`, `${o}/devices`, o]) {
      expect((await asDevice(key, 'GET', path)).status, path).toBe(401);
    }
    // Not another organisation's station, even with the same key.
    const elsewhere = await seedOrg();
    expect((await asDevice(key, 'GET', `/organizations/${elsewhere.orgId}/stations/${v.kitchen.id}/tickets`)).status).toBe(403);
  });

  it('removed in the console: its key stops working at once', async () => {
    const org = await seedOrg();
    const v = await venue(org);
    const paired = (await asDevice(null, 'POST', '/public/pair', { code: await code(org, { role: 'station', name: 'Scherm keuken', stationId: v.kitchen.id }) })).body;
    expect((await asDevice(paired.deviceKey, 'GET', `/organizations/${org.orgId}/stations/${v.kitchen.id}/tickets`)).status).toBe(200);
    expect((await api('DELETE', `/organizations/${org.orgId}/devices/${paired.terminalId}`, { user: org.admin })).status).toBe(200);
    expect((await asDevice(paired.deviceKey, 'GET', `/organizations/${org.orgId}/stations/${v.kitchen.id}/tickets`)).status).toBe(401);
    expect((await asDevice(paired.deviceKey, 'GET', `/organizations/device-ws-token?terminal_id=${paired.terminalId}`)).status).toBe(401);
  });

  it('a made-up key, or none: nobody', async () => {
    const org = await seedOrg();
    const v = await venue(org);
    expect((await asDevice('x'.repeat(43), 'GET', `/organizations/${org.orgId}/stations/${v.kitchen.id}/tickets`)).status).toBe(401);
    expect((await asDevice(null, 'GET', `/organizations/${org.orgId}/stations/${v.kitchen.id}/tickets`)).status).toBe(401);
  });
});

describe("a customer display's key: its kassa's payments, nothing else", () => {
  it("follows a payment of the kassa it's linked to — not another kassa's", async () => {
    const org = await seedOrg();
    const kassa = await api('POST', '/organizations/device-pairings/claim', { user: org.cashier, body: { code: await code(org, { role: 'pos', name: 'Kassa 1' }) } });
    const otherKassa = await api('POST', '/organizations/device-pairings/claim', { user: org.cashier, body: { code: await code(org, { role: 'pos', name: 'Kassa 2' }) } });
    const display = (await asDevice(null, 'POST', '/public/pair', { code: await code(org, { role: 'cfd', name: 'Klantscherm', linkTo: kassa.body.terminalId }) })).body;
    expect(display).toMatchObject({ role: 'cfd', linkedTo: kassa.body.terminalId, deviceKey: expect.any(String) });
    const charge = async (posTerminalId: string) => {
      const id = crypto.randomUUID().replace(/-/g, '');
      await env.DB.prepare(`INSERT INTO charges (id, org_id, method, status, amount_cents, pos_terminal_id, created_at, provider_data) VALUES (?, ?, 'cash', 'pending', 500, ?, ?, '{}')`)
        .bind(id, org.orgId, posTerminalId, new Date().toISOString())
        .run();
      return id;
    };
    const mine = await charge(kassa.body.terminalId);
    const theirs = await charge(otherKassa.body.terminalId);
    expect((await asDevice(display.deviceKey, 'GET', `/sumup/status/${mine}`)).body).toMatchObject({ status: 'pending', amountCents: 500 });
    expect((await asDevice(display.deviceKey, 'GET', `/sumup/status/${theirs}`)).status).toBe(403);
    // Not a station's tickets, not the organisation.
    expect((await asDevice(display.deviceKey, 'GET', `/organizations/${org.orgId}/tabs`)).status).toBe(401);
    expect((await asDevice(display.deviceKey, 'GET', `/organizations/${org.orgId}/devices/${display.terminalId}`)).status).toBe(200);
  });
});
