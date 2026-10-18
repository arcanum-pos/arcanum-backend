// The customer display while the order is being entered (src/customer-view.ts):
// the kassa sends the order on its screen, its display on another device
// fetches it after an `order_shown` push — only its own kassa's.
import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, rows, seedOrg, type TestOrg } from './helpers';

interface Device {
  terminal_id: string;
  org_id: string;
  role: string;
  linked_to: string | null;
  name: string | null;
}
let registry: Map<string, Device>;
let broadcasts: { pos_terminal_id: string; event: string }[];

beforeEach(() => {
  registry = new Map();
  broadcasts = [];
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
    if (p === '/devices/link') {
      registry.get(body.terminal_id)!.linked_to = body.pos_terminal_id;
      return Response.json(registry.get(body.terminal_id));
    }
    if (p === '/devices/unlink') {
      registry.get(body.terminal_id)!.linked_to = null;
      return Response.json({ ok: true });
    }
    if (p === '/devices/broadcast') {
      broadcasts.push({ pos_terminal_id: body.pos_terminal_id, event: body.event });
      return Response.json({ ok: true });
    }
    let m = p.match(/^\/devices\/(.+)\/linked$/);
    if (m) return Response.json([...registry.values()].find((d) => d.linked_to === decodeURIComponent(m![1]) && d.role === 'cfd') ?? null);
    m = p.match(/^\/devices\/(.+)$/);
    if (m) return registry.has(decodeURIComponent(m[1])) ? Response.json(registry.get(decodeURIComponent(m[1]))) : Response.json({ error: 'Unknown terminal_id' }, { status: 404 });
    return Response.json({ ok: true });
  });
});

async function asDevice(key: string, path: string) {
  const res = await SELF.fetch(`https://backend.test${path}`, { headers: { 'X-Device-Key': key } });
  return { status: res.status, body: await res.json() as any };
}

// A kassa, and a customer display on another device linked to it (paired with its code alone: a key).
async function kassaWithDisplay(org: TestOrg) {
  const kassaCode = (await api('POST', `/organizations/${org.orgId}/device-pairings`, { user: org.admin, body: { role: 'pos', name: 'Kassa' } })).body.code;
  const kassa = (await api('POST', '/organizations/device-pairings/claim', { user: org.cashier, body: { code: kassaCode } })).body.terminalId as string;
  const displayCode = (await api('POST', `/organizations/${org.orgId}/device-pairings`, { user: org.admin, body: { role: 'cfd', name: 'Scherm', linkTo: kassa } })).body.code;
  const display = (await SELF.fetch('https://backend.test/public/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: displayCode }) }).then((r) => r.json())) as any;
  return { kassa, display: display.terminalId as string, key: display.deviceKey as string };
}

const ORDER = { label: 'Tafel 4', number: 12, eventName: 'Fuif', paidCents: 0, lines: [{ name: 'Pils', quantity: 2, unitPriceCents: 250 }, { name: 'Frieten', quantity: 1, unitPriceCents: 400 }] };
const put = (org: TestOrg, kassa: string, order: unknown, seq: number, user = org.cashier) =>
  api('PUT', `/organizations/${org.orgId}/devices/${kassa}/customer-view`, { user, body: { order, seq } });

describe('the customer display while the order is entered', () => {
  it("the kassa's order reaches its display: pushed (no data), fetched with the display's own key", async () => {
    const org = await seedOrg();
    const { kassa, display, key } = await kassaWithDisplay(org);
    expect((await put(org, kassa, ORDER, 1)).body).toEqual({ shown: true });
    expect(broadcasts).toEqual([{ pos_terminal_id: kassa, event: 'order_shown' }]);
    const view = await asDevice(key, `/organizations/${org.orgId}/devices/${display}/customer-view`);
    expect(view.status).toBe(200);
    expect(view.body).toEqual({ order: ORDER, seq: 1 });
    // Emptied (paid, or the cashier cleared it): nothing.
    await put(org, kassa, null, 2);
    expect((await asDevice(key, `/organizations/${org.orgId}/devices/${display}/customer-view`)).body).toEqual({ order: null, seq: 2 });
  });

  it('an older one never replaces a newer one', async () => {
    const org = await seedOrg();
    const { kassa, display, key } = await kassaWithDisplay(org);
    await put(org, kassa, ORDER, 5);
    await put(org, kassa, { ...ORDER, lines: [] }, 4);
    expect(broadcasts).toHaveLength(1);
    expect((await asDevice(key, `/organizations/${org.orgId}/devices/${display}/customer-view`)).body.order.lines).toHaveLength(2);
  });

  it('no display on another device: nothing kept, nothing pushed', async () => {
    const org = await seedOrg();
    const code = (await api('POST', `/organizations/${org.orgId}/device-pairings`, { user: org.admin, body: { role: 'pos', name: 'Kassa' } })).body.code;
    const kassa = (await api('POST', '/organizations/device-pairings/claim', { user: org.cashier, body: { code } })).body.terminalId;
    expect((await put(org, kassa, ORDER, 1)).body).toEqual({ shown: false });
    // Its own second window (the companion display) gets it directly, not through here.
    await api('POST', `/organizations/${org.orgId}/devices/${kassa}/display`, { user: org.cashier });
    expect((await put(org, kassa, ORDER, 2)).body).toEqual({ shown: false });
    expect(await rows('SELECT * FROM customer_views WHERE terminal_id = ?', kassa)).toEqual([]);
    expect(broadcasts).toEqual([]);
  });

  it('only what an order is: names cut short, odd lines left out', async () => {
    const org = await seedOrg();
    const { kassa, display, key } = await kassaWithDisplay(org);
    await put(org, kassa, { label: 'x'.repeat(200), number: 'zeven', lines: [{ name: 'Pils', quantity: 1, unitPriceCents: 250, secret: 'no' }, { name: 'Raar', quantity: 0.5, unitPriceCents: 1 }, 'junk'], extra: true }, 1);
    const { order } = (await asDevice(key, `/organizations/${org.orgId}/devices/${display}/customer-view`)).body;
    expect(order).toEqual({ label: 'x'.repeat(80), number: null, eventName: null, paidCents: 0, lines: [{ name: 'Pils', quantity: 1, unitPriceCents: 250 }] });
  });

  it("a display reads only its own kassa's; a kassa of another org, another display, or nobody: refused", async () => {
    const org = await seedOrg();
    const first = await kassaWithDisplay(org);
    const second = await kassaWithDisplay(org);
    await put(org, first.kassa, ORDER, 1);
    // Its own: the second kassa's, which has none.
    expect((await asDevice(second.key, `/organizations/${org.orgId}/devices/${second.display}/customer-view`)).body.order).toBeNull();
    // Another display's address with its own key: refused.
    expect((await asDevice(second.key, `/organizations/${org.orgId}/devices/${first.display}/customer-view`)).status).toBe(403);
    const other = await seedOrg();
    expect((await put(other, first.kassa, ORDER, 2, other.admin)).status).toBe(404);
    expect((await api('PUT', `/organizations/${org.orgId}/devices/${first.kassa}/customer-view`, { user: null, body: { order: ORDER, seq: 3 } })).status).toBe(401);
    expect((await api('GET', `/organizations/${org.orgId}/devices/${first.display}/customer-view`, { user: other.admin })).status).toBe(403);
  });
});
