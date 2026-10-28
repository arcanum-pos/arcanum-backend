// Ticket printers (src/printing.ts, arcanum/PRINTING.md): printers of the
// org, a print job per prep ticket for its station's printer, and each job
// printed exactly once however many screens try.
import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderTicket } from '../src/printing';
import { api, DEVICE, rows, seedOrg, tabsPath, type TestOrg } from './helpers';

let pushes: { role: string; event: string; payload: any }[];
beforeEach(() => {
  pushes = [];
  // arcanum-devicehub: pairing a station screen, and the pushes.
  vi.spyOn(env.ARCANUM_DEVICEHUB_SERVICE, 'fetch').mockImplementation(async (input: any, init?: any) => {
    const request = new Request(input, init);
    const body = (request.method === 'GET' ? null : await request.json().catch(() => null)) as any;
    const p = new URL(request.url).pathname;
    if (p === '/devices/broadcast-org') pushes.push({ role: body.role, event: body.event, payload: body.payload });
    if (p === '/devices/register') return Response.json({ terminal_id: body.terminal_id, org_id: body.org_id, role: body.role, linked_to: null, name: body.name ?? null });
    return Response.json({ ok: true });
  });
});

const o = (org: TestOrg) => `/organizations/${org.orgId}`;
const admin = async (org: TestOrg, method: string, path: string, body?: unknown) => api(method, `${o(org)}${path}`, { user: org.admin, body });

async function asDevice(key: string, method: string, path: string, body?: unknown) {
  const res = await SELF.fetch(`https://backend.test${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Device-Key': key, 'CF-Connecting-IP': '203.0.113.7' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

// A kitchen with a product, a bar with another, and a menukaart with both.
async function venue(org: TestOrg) {
  const kitchen = (await admin(org, 'POST', '/catalog/stations', { name: 'Keuken' })).body;
  const bar = (await admin(org, 'POST', '/catalog/stations', { name: 'Bar' })).body;
  const catalog = (await admin(org, 'POST', '/catalogs', { name: 'Fuif' })).body;
  const section = (await admin(org, 'POST', `/catalogs/${catalog.id}/sections`, { name: 'Alles' })).body;
  const add = async (name: string, prepStationId: string) => {
    const product = (await admin(org, 'POST', '/catalog/products', { name, prepStationId, variants: [{ name: '' }] })).body;
    await admin(org, 'POST', `/catalogs/${catalog.id}/entries`, { sectionId: section.id, variantId: product.variants[0].id, priceCents: 300 });
    return product.variants[0].id as string;
  };
  return { kitchen, bar, catalogId: catalog.id, frieten: await add('Frieten', kitchen.id), pils: await add('Pils', bar.id) };
}

const order = (org: TestOrg, v: Awaited<ReturnType<typeof venue>>, lines: { variantId: string; quantity: number }[], label = 'Tafel 4') =>
  api('POST', tabsPath(org.orgId), { user: org.cashier, body: { ...DEVICE, label, catalogId: v.catalogId, lines } });

const PRINTER = { name: 'Keukenprinter', brand: 'epson', connection: 'push', host: '192.168.1.50', port: 443, paperMm: 80 };

describe('printers', () => {
  it('are added, listed with their stations, changed and removed - by an admin', async () => {
    const org = await seedOrg();
    const v = await venue(org);
    const created = await admin(org, 'POST', '/printers', { ...PRINTER, stationIds: [v.kitchen.id] });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'Keukenprinter', brand: 'epson', connection: 'push', host: '192.168.1.50', port: 443, deviceId: 'local_printer', paperMm: 80, stations: [{ id: v.kitchen.id, name: 'Keuken' }] });

    const listed = await api('GET', `${o(org)}/printers`, { user: org.cashier });
    expect(listed.body).toHaveLength(1);

    const changed = await admin(org, 'PATCH', `/printers/${created.body.id}`, { host: 'https://192.168.1.51/', stationIds: [v.bar.id] });
    expect(changed.body).toMatchObject({ host: '192.168.1.51', stations: [{ id: v.bar.id, name: 'Bar' }] });

    expect((await api('POST', `${o(org)}/printers`, { user: org.cashier, body: PRINTER })).status).toBe(403);
    expect((await admin(org, 'DELETE', `/printers/${created.body.id}`)).status).toBe(200);
    expect(await rows('SELECT printer_id FROM prep_stations WHERE id = ?', v.bar.id)).toEqual([{ printer_id: null }]);
  });

  it('refuses what a printer can not be (Star and polling come later)', async () => {
    const org = await seedOrg();
    for (const [body, field] of [
      [{ ...PRINTER, host: '' }, 'host'],
      [{ ...PRINTER, host: 'not a host!' }, 'host'],
      [{ ...PRINTER, port: 70000 }, 'port'],
      [{ ...PRINTER, paperMm: 72 }, 'paperMm'],
      [{ ...PRINTER, brand: 'star' }, 'brand'],
      [{ ...PRINTER, connection: 'poll' }, 'connection'],
    ] as const) {
      const res = await admin(org, 'POST', '/printers', body);
      expect(res.body, field).toMatchObject({ code: 'printer_invalid', params: { field } });
    }
  });
});

describe('print jobs', () => {
  it("an order makes a job per printed station, rendered in ePOS-Print, and tells the screens", async () => {
    const org = await seedOrg();
    const v = await venue(org);
    const printer = (await admin(org, 'POST', '/printers', { ...PRINTER, stationIds: [v.kitchen.id] })).body;
    await order(org, v, [{ variantId: v.frieten, quantity: 2 }, { variantId: v.pils, quantity: 1 }]);

    // The bar has no printer: only the kitchen's ticket prints.
    const jobs = await rows<{ printer_id: string; kind: string; title: string; document: string; status: string }>('SELECT printer_id, kind, title, document, status FROM print_jobs WHERE org_id = ?', org.orgId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ printer_id: printer.id, kind: 'ticket', status: 'waiting' });
    expect(jobs[0].title).toMatch(/^Keuken #\d+$/);
    expect(jobs[0].document).toContain('<epos-print xmlns="http://www.epson-pos.com/schemas/2011/03/epos-print">');
    expect(jobs[0].document).toContain('2 x Frieten');
    expect(jobs[0].document).not.toContain('Pils');
    expect(pushes.filter((p) => p.event === 'print_job').map((p) => p.role).sort()).toEqual(['pos', 'station']);
    expect(pushes.find((p) => p.event === 'print_job')!.payload).toEqual({ printer_id: printer.id });
  });

  it('is claimed by exactly one screen, reported, and a stale claim is claimable again', async () => {
    const org = await seedOrg();
    const v = await venue(org);
    const printer = (await admin(org, 'POST', '/printers', { ...PRINTER, stationIds: [v.kitchen.id] })).body;
    await order(org, v, [{ variantId: v.frieten, quantity: 1 }]);
    const [job] = (await api('GET', `${o(org)}/printers/${printer.id}/jobs`, { user: org.cashier })).body;
    expect(job).toMatchObject({ kind: 'ticket', status: 'waiting' });

    const first = await api('POST', `${o(org)}/print-jobs/${job.id}/claim`, { user: org.cashier });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ printer: { host: '192.168.1.50', port: 443, deviceId: 'local_printer' } });
    expect(first.body.document).toContain('Frieten');
    // A second screen, at the same moment: too late.
    expect((await api('POST', `${o(org)}/print-jobs/${job.id}/claim`, { user: org.admin })).body.code).toBe('print_job_taken');

    // Its screen closed before reporting: after 30 s it's waiting again.
    await env.DB.prepare('UPDATE print_jobs SET claimed_at = ? WHERE id = ?').bind(new Date(Date.now() - 31_000).toISOString(), job.id).run();
    expect((await api('GET', `${o(org)}/printers/${printer.id}/jobs`, { user: org.cashier })).body[0].status).toBe('waiting');
    const second = await api('POST', `${o(org)}/print-jobs/${job.id}/claim`, { user: org.admin });
    expect(second.status).toBe(200);
    // The first screen's late answer no longer counts; the second's does.
    expect((await api('POST', `${o(org)}/print-jobs/${job.id}/result`, { user: org.cashier, body: { claim: first.body.claim, success: true } })).status).toBe(409);
    expect((await api('POST', `${o(org)}/print-jobs/${job.id}/result`, { user: org.admin, body: { claim: second.body.claim, success: true } })).status).toBe(200);
    expect((await rows('SELECT status, attempts FROM print_jobs WHERE id = ?', job.id))[0]).toEqual({ status: 'printed', attempts: 2 });
    expect((await api('GET', `${o(org)}/printers/${printer.id}/jobs`, { user: org.cashier })).body).toEqual([]);
  });

  it('a failure (paper out) is listed with its code, and printed again on retry', async () => {
    const org = await seedOrg();
    const v = await venue(org);
    const printer = (await admin(org, 'POST', '/printers', { ...PRINTER, stationIds: [v.kitchen.id] })).body;
    await order(org, v, [{ variantId: v.frieten, quantity: 1 }]);
    const [job] = (await api('GET', `${o(org)}/printers/${printer.id}/jobs`, { user: org.cashier })).body;
    const { claim } = (await api('POST', `${o(org)}/print-jobs/${job.id}/claim`, { user: org.cashier })).body;
    await api('POST', `${o(org)}/print-jobs/${job.id}/result`, { user: org.cashier, body: { claim, success: false, code: 'EPTR_REC_EMPTY' } });
    expect((await api('GET', `${o(org)}/printers/${printer.id}/jobs`, { user: org.cashier })).body[0]).toMatchObject({ status: 'failed', error: 'EPTR_REC_EMPTY' });

    pushes = [];
    expect((await api('POST', `${o(org)}/print-jobs/${job.id}/retry`, { user: org.cashier })).status).toBe(200);
    expect((await api('GET', `${o(org)}/printers/${printer.id}/jobs`, { user: org.cashier })).body[0]).toMatchObject({ status: 'waiting', error: null });
    expect(pushes.some((p) => p.event === 'print_job')).toBe(true);
  });

  it("a ticket is queued once, and a further round makes the next ticket's job", async () => {
    const org = await seedOrg();
    const v = await venue(org);
    await admin(org, 'POST', '/printers', { ...PRINTER, stationIds: [v.kitchen.id] });
    const tab = (await order(org, v, [{ variantId: v.frieten, quantity: 1 }])).body;
    await api('POST', tabsPath(org.orgId, `/${tab.id}/orders`), { user: org.cashier, body: { ...DEVICE, catalogId: v.catalogId, lines: [{ variantId: v.frieten, quantity: 3 }] } });
    const jobs = await rows<{ document: string }>('SELECT document FROM print_jobs WHERE org_id = ? ORDER BY created_at, rowid', org.orgId);
    expect(jobs).toHaveLength(2);
    expect(jobs[1].document).toContain('3 x Frieten');
  });

  it('a test page, from the console', async () => {
    const org = await seedOrg();
    const printer = (await admin(org, 'POST', '/printers', PRINTER)).body;
    expect((await admin(org, 'POST', `/printers/${printer.id}/test`)).status).toBe(201);
    expect((await api('GET', `${o(org)}/printers/${printer.id}/jobs`, { user: org.cashier })).body[0]).toMatchObject({ kind: 'test', title: 'Testafdruk' });
  });

  it("stays inside its org", async () => {
    const org = await seedOrg();
    const other = await seedOrg();
    const v = await venue(org);
    const printer = (await admin(org, 'POST', '/printers', { ...PRINTER, stationIds: [v.kitchen.id] })).body;
    await order(org, v, [{ variantId: v.frieten, quantity: 1 }]);
    const [job] = (await api('GET', `${o(org)}/printers/${printer.id}/jobs`, { user: org.cashier })).body;
    expect((await api('POST', `${o(other)}/print-jobs/${job.id}/claim`, { user: other.cashier })).body.code).toBe('print_job_not_found');
    expect((await api('POST', `${o(org)}/print-jobs/${job.id}/claim`, { user: other.cashier })).status).toBe(403);
    // Another org's station can't be given this printer.
    const foreign = (await admin(other, 'POST', '/catalog/stations', { name: 'Elders' })).body;
    await admin(org, 'PATCH', `/printers/${printer.id}`, { stationIds: [v.kitchen.id, foreign.id] });
    expect(await rows('SELECT printer_id FROM prep_stations WHERE id = ?', foreign.id)).toEqual([{ printer_id: null }]);
  });
});

describe('a station screen', () => {
  it('lists, claims and reports with its own key, and may choose its own station\'s printer only', async () => {
    const org = await seedOrg();
    const v = await venue(org);
    const printer = (await admin(org, 'POST', '/printers', PRINTER)).body;
    const code = (await admin(org, 'POST', '/device-pairings', { role: 'station', name: 'Scherm keuken', stationId: v.kitchen.id })).body.code;
    const paired = (await SELF.fetch('https://backend.test/public/pair', { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.8' }, body: JSON.stringify({ code }) }).then((r) => r.json())) as any;
    const key = paired.deviceKey as string;
    expect(key).toBeTruthy();

    expect((await asDevice(key, 'PUT', `${o(org)}/stations/${v.bar.id}/printer`, { printerId: printer.id })).status).toBe(403);
    expect((await asDevice(key, 'PUT', `${o(org)}/stations/${v.kitchen.id}/printer`, { printerId: printer.id })).status).toBe(200);
    expect((await asDevice(key, 'GET', `${o(org)}/printers`)).body[0].stations).toEqual([{ id: v.kitchen.id, name: 'Keuken' }]);

    await order(org, v, [{ variantId: v.frieten, quantity: 1 }]);
    const [job] = (await asDevice(key, 'GET', `${o(org)}/printers/${printer.id}/jobs`)).body;
    const claimed = await asDevice(key, 'POST', `${o(org)}/print-jobs/${job.id}/claim`);
    expect(claimed.status).toBe(200);
    expect((await asDevice(key, 'POST', `${o(org)}/print-jobs/${job.id}/result`, { claim: claimed.body.claim, success: true })).status).toBe(200);
    // Managing printers is the console's.
    expect((await asDevice(key, 'POST', `${o(org)}/printers`, PRINTER)).status).toBe(403);
  });
});

describe('the ticket', () => {
  it('names the station and number, the tab and mode, and wraps long lines under themselves', () => {
    const doc = renderTicket({
      stationName: 'Keuken',
      number: 12,
      label: 'Tafel 4',
      mode: 'Take away',
      createdAt: '2026-10-28T19:15:00Z',
      paperMm: 58,
      lines: [{ name: 'Spaghetti bolognese met extra kaas', quantity: 2, note: 'zonder ui' }],
    });
    expect(doc).toContain('KEUKEN&#10;');
    expect(doc).toContain('#12&#10;');
    expect(doc).toContain('Tafel 4 - Take away&#10;20:15&#10;');
    // 58 mm, double width: 16 columns; the name continues under itself.
    expect(doc).toContain('2 x Spaghetti\n    bolognese\n    met extra\n    kaas\n&gt; zonder ui');
    expect(doc).toContain('<cut type="feed"/>');
  });
});
