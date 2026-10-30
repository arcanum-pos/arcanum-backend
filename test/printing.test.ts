// Ticket printers (src/printing.ts, arcanum/PRINTING.md): printers of the
// org, a print job per prep ticket for its station's printer, and each job
// printed exactly once however many screens try.
import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderReceipt, renderTicket } from '../src/printing';
import { parseCertificate, pemToDer } from '../src/printer-cert';
import { EPSON_CERT, GOOD_CERT, OTHER_CERT, SIGNED_CERT } from './fixtures/printer-certs';
import { api, createTab, DEVICE, line, payCash, rows, seedOrg, tabsPath, type TestOrg } from './helpers';

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

  it('refuses what a printer can not be (Star comes later)', async () => {
    const org = await seedOrg();
    for (const [body, field] of [
      [{ ...PRINTER, host: '' }, 'host'],
      [{ ...PRINTER, host: 'not a host!' }, 'host'],
      [{ ...PRINTER, port: 70000 }, 'port'],
      [{ ...PRINTER, paperMm: 72 }, 'paperMm'],
      [{ ...PRINTER, brand: 'star' }, 'brand'],
      [{ ...PRINTER, connection: 'bluetooth' }, 'connection'],
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

// --- Polling (Server Direct Print, phase 3) ---

const POLLER = { name: 'Barprinter', brand: 'epson', connection: 'poll', paperMm: 80 };

async function asPrinter(printerId: string, key: string, form: Record<string, string>) {
  const res = await SELF.fetch(`https://backend.test/public/print/epson/${printerId}?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  return { status: res.status, type: res.headers.get('Content-Type'), body: await res.text() };
}
const result = (...responses: [boolean, string?][]) =>
  `<?xml version="1.0" encoding="utf-8"?><PrintResponseInfo Version="1.00">${responses
    .map(([ok, code = '']) => `<response xmlns="http://www.epson-pos.com/schemas/2011/03/epos-print" success="${ok}" code="${code}" status="251658262" battery="0"/>`)
    .join('')}</PrintResponseInfo>`;

describe('a printer that asks for its work', () => {
  it('gets its secret once; no address needed', async () => {
    const org = await seedOrg();
    const created = await admin(org, 'POST', '/printers', POLLER);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ connection: 'poll', host: null, port: null, lastPollAt: null });
    expect(created.body.pollInterval).toBeUndefined();
    expect(created.body.pollKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await api('GET', `${o(org)}/printers`, { user: org.admin })).body[0].pollKey).toBeUndefined();
    expect(JSON.stringify(await rows('SELECT * FROM printers'))).not.toContain(created.body.pollKey);
  });

  it('shows its URL again - to an admin, decrypted from the org key; a new link changes it', async () => {
    const org = await seedOrg();
    const p = (await admin(org, 'POST', '/printers', POLLER)).body;
    expect((await admin(org, 'GET', `/printers/${p.id}/key`)).body).toEqual({ pollKey: p.pollKey });
    expect((await api('GET', `${o(org)}/printers/${p.id}/key`, { user: org.cashier })).status).toBe(403);
    const fresh = (await admin(org, 'POST', `/printers/${p.id}/key`)).body;
    expect((await admin(org, 'GET', `/printers/${p.id}/key`)).body).toEqual({ pollKey: fresh.pollKey });
    // A printer made before the key was kept: nothing to show (a new link makes one).
    await env.DB.prepare('UPDATE printers SET poll_key_ciphertext = NULL, poll_key_iv = NULL WHERE id = ?').bind(p.id).run();
    expect((await admin(org, 'GET', `/printers/${p.id}/key`)).body).toEqual({ pollKey: null });
  });

  it("asks: nothing (an empty answer), then its station's ticket, prints it and reports", async () => {
    const org = await seedOrg();
    const v = await venue(org);
    const p = (await admin(org, 'POST', '/printers', { ...POLLER, stationIds: [v.bar.id] })).body;

    const nothing = await asPrinter(p.id, p.pollKey, { ConnectionType: 'GetRequest', ID: '' });
    expect(nothing).toMatchObject({ status: 200, body: '' });
    expect((await rows<{ last_poll_at: string }>('SELECT last_poll_at FROM printers WHERE id = ?', p.id))[0].last_poll_at).toBeTruthy();

    await order(org, v, [{ variantId: v.pils, quantity: 3 }]);
    const work = await asPrinter(p.id, p.pollKey, { ConnectionType: 'GetRequest', ID: '' });
    expect(work.type).toContain('text/xml');
    expect(work.body).toMatch(/^<\?xml version="1.0" encoding="utf-8"\?><PrintRequestInfo Version="1.00"><ePOSPrint><Parameter><devid>local_printer<\/devid><timeout>10000<\/timeout><\/Parameter><PrintData><epos-print /);
    expect(work.body).toContain('3 x Pils');
    // Taken: a screen can't claim it now, and the next ask is empty.
    const [job] = await rows<{ id: string; status: string }>('SELECT id, status FROM print_jobs WHERE printer_id = ?', p.id);
    expect(job.status).toBe('claimed');
    expect((await asPrinter(p.id, p.pollKey, { ConnectionType: 'GetRequest', ID: '' })).body).toBe('');

    expect((await asPrinter(p.id, p.pollKey, { ConnectionType: 'SetResponse', ID: '', ResponseFile: result([true]) })).status).toBe(200);
    expect((await rows('SELECT status FROM print_jobs WHERE id = ?', job.id))[0]).toEqual({ status: 'printed' });
  });

  it('several at once, results in the order sent; a failure is kept with its code and told to the screens', async () => {
    const org = await seedOrg();
    const v = await venue(org);
    const p = (await admin(org, 'POST', '/printers', { ...POLLER, stationIds: [v.bar.id] })).body;
    for (let i = 1; i <= 7; i++) await order(org, v, [{ variantId: v.pils, quantity: i }], `Tafel ${i}`);
    const work = await asPrinter(p.id, p.pollKey, { ConnectionType: 'GetRequest', ID: '' });
    // At most five per answer, oldest first.
    expect(work.body.match(/<ePOSPrint>/g)).toHaveLength(5);
    expect(work.body.indexOf('Tafel 1')).toBeLessThan(work.body.indexOf('Tafel 5'));
    expect(work.body).not.toContain('Tafel 6');

    pushes = [];
    await asPrinter(p.id, p.pollKey, { ConnectionType: 'SetResponse', ID: '', ResponseFile: result([true], [true], [false, 'EPTR_REC_EMPTY'], [false, 'EPTR_REC_EMPTY'], [false, 'EPTR_REC_EMPTY']) });
    const jobs = await rows<{ status: string; error: string | null }>('SELECT status, error FROM print_jobs WHERE printer_id = ? ORDER BY created_at, rowid', p.id);
    expect(jobs.map((j) => j.status)).toEqual(['printed', 'printed', 'failed', 'failed', 'failed', 'waiting', 'waiting']);
    expect(jobs[2].error).toBe('EPTR_REC_EMPTY');
    expect(pushes.some((x) => x.event === 'print_job')).toBe(true);
  });

  it('refuses a wrong or old key; a new one replaces it', async () => {
    const org = await seedOrg();
    const p = (await admin(org, 'POST', '/printers', POLLER)).body;
    expect((await asPrinter(p.id, 'x'.repeat(43), { ConnectionType: 'GetRequest' })).status).toBe(403);
    expect((await asPrinter(p.id, p.pollKey, { ConnectionType: 'SetResponse', ResponseFile: result([true]) })).status).toBe(200);
    const fresh = (await admin(org, 'POST', `/printers/${p.id}/key`)).body;
    expect(fresh.pollKey).not.toBe(p.pollKey);
    expect((await asPrinter(p.id, p.pollKey, { ConnectionType: 'GetRequest' })).status).toBe(403);
    expect((await asPrinter(p.id, fresh.pollKey, { ConnectionType: 'GetRequest' })).status).toBe(200);
    // A printer via a screen has no URL to ask at.
    const push = (await admin(org, 'POST', '/printers', PRINTER)).body;
    expect(push.pollKey).toBeUndefined();
    expect((await admin(org, 'POST', `/printers/${push.id}/key`)).status).toBe(404);
  });
});

// --- Receipts ---

describe('receipts', () => {
  it('are off until an admin switches them on', async () => {
    const org = await seedOrg();
    expect((await api('GET', `${o(org)}/receipt-settings`, { user: org.cashier })).body).toEqual({ enabled: false });
    expect((await api('PUT', `${o(org)}/receipt-settings`, { user: org.cashier, body: { enabled: true } })).status).toBe(403);
    expect((await admin(org, 'PUT', '/receipt-settings', { enabled: true })).body).toEqual({ enabled: true });
    expect((await api('GET', `${o(org)}/receipt-settings`, { user: org.cashier })).body).toEqual({ enabled: true });
  });

  it("print a paid tab's lines, total and payment - not a VAT receipt", async () => {
    const org = await seedOrg();
    const printer = (await admin(org, 'POST', '/printers', POLLER)).body;
    const tab = await createTab(org, { label: 'Tafel 4', lines: [line('pils', 'Pils', 250, 2), line('frieten', 'Frieten', 400, 1)] });
    const chargeId = await payCash(org, tab.id, 900);

    // Off: refused.
    expect((await api('POST', `${o(org)}/printers/${printer.id}/receipt`, { user: org.cashier, body: { tabId: tab.id, chargeId } })).body.code).toBe('receipts_off');
    await admin(org, 'PUT', '/receipt-settings', { enabled: true });
    const made = await api('POST', `${o(org)}/printers/${printer.id}/receipt`, { user: org.cashier, body: { tabId: tab.id, chargeId } });
    expect(made.status).toBe(201);

    const [job] = await rows<{ kind: string; ref_id: string; document: string }>('SELECT kind, ref_id, document FROM print_jobs WHERE id = ?', made.body.id);
    expect(job).toMatchObject({ kind: 'receipt', ref_id: tab.id });
    expect(job.document).toMatch(/2 x Pils +5,00/);
    expect(job.document).toMatch(/1 x Frieten +4,00/);
    expect(job.document).toMatch(/Totaal EUR +9,00/);
    expect(job.document).toMatch(/Contant +9,00/);
    expect(job.document).toContain('Geen BTW-kasticket');
    expect(job.document).toContain('Bonnummer');
    // The printer picks it up like any other job.
    expect((await asPrinter(printer.id, printer.pollKey, { ConnectionType: 'GetRequest' })).body).toContain('Totaal EUR');
  });

  it('only from a signed-in member', async () => {
    const org = await seedOrg();
    const printer = (await admin(org, 'POST', '/printers', POLLER)).body;
    await admin(org, 'PUT', '/receipt-settings', { enabled: true });
    const tab = await createTab(org, { lines: [line('pils', 'Pils', 250, 1)] });
    const res = await SELF.fetch(`https://backend.test${o(org)}/printers/${printer.id}/receipt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tabId: tab.id }) });
    expect(res.status).toBe(401);
  });

  it('a part of a split says what was paid now and what is still open', () => {
    const doc = renderReceipt({
      orgName: 'Scouts', eventName: 'Fuif', tabLabel: 'Jan', tabNumber: 7, receiptNumber: null, at: '2026-10-28T20:00:00Z',
      lines: [{ name: 'Pils', quantity: 4, unitPriceCents: 250 }], totalCents: 1000,
      payments: [{ method: 'cash', amountCents: 500, tipCents: 0 }, { method: 'bancontact', amountCents: 300, tipCents: 50 }],
      paidNowCents: 300, outstandingCents: 250, paperMm: 58, locale: 'fr',
    });
    expect(doc).toContain('Addition #7 - Jan');
    expect(doc).toMatch(/Bancontact \(pourboire 0,50\) +3,00/);
    expect(doc).toMatch(/Payé maintenant +3,00/);
    expect(doc).toMatch(/Reste à payer +2,50/);
    expect(doc).toContain('Pas un ticket TVA');
    expect(doc).not.toContain('Ticket n°');
  });
});

describe('trusting a push printer', () => {
  const upload = (printerId: string, code: string, body: string) =>
    SELF.fetch(`https://backend.test/public/print/cert/${printerId}?code=${encodeURIComponent(code)}`, { method: 'POST', headers: { 'Content-Type': 'application/x-pem-file' }, body });
  const profile = (printerId: string, token: string) => SELF.fetch(`https://backend.test/public/print/profile/${printerId}?token=${encodeURIComponent(token)}`);

  it('reads what a certificate names, and whether it is its own issuer', () => {
    const good = parseCertificate(pemToDer(GOOD_CERT)!)!;
    expect(good).toMatchObject({ selfSigned: true, isCa: true, commonName: '192.168.1.50', ipAddresses: ['192.168.1.50'] });
    expect(Math.round((good.notAfter!.getTime() - good.notBefore!.getTime()) / 86_400_000)).toBe(825);
    expect(parseCertificate(pemToDer(EPSON_CERT)!)).toMatchObject({ selfSigned: true, isCa: false, ipAddresses: [], dnsNames: [] });
    expect(parseCertificate(pemToDer(SIGNED_CERT)!)!.selfSigned).toBe(false);
    // Bare base64 (DER) too; junk is no certificate.
    expect(parseCertificate(pemToDer(GOOD_CERT.replace(/-----[A-Z ]+-----/g, ''))!)!.selfSigned).toBe(true);
    expect(pemToDer('<not a certificate>')).toBeNull();
    expect(parseCertificate(pemToDer('not a certificate')!)).toBeNull();
    expect(parseCertificate(new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x01]))).toBeNull();
  });

  it('a screen gets a one-time code; the command uploads the certificate; the iPad gets a profile', async () => {
    const org = await seedOrg();
    const printer = (await admin(org, 'POST', '/printers', PRINTER)).body;
    expect(printer.certFingerprint).toBeNull();
    // No certificate yet: no profile.
    expect((await api('POST', `${o(org)}/printers/${printer.id}/profile-link`, { user: org.cashier })).body.code).toBe('printer_no_certificate');

    const made = await api('POST', `${o(org)}/printers/${printer.id}/trust-code`, { user: org.cashier });
    expect(made.status).toBe(201);
    const res = await upload(printer.id, made.body.code, GOOD_CERT);
    expect(res.status).toBe(200);
    const said = await res.text();
    expect(said).toContain('Certificaat van "Keukenprinter" opgeslagen');
    expect(said).toMatch(/Vingerafdruk \(SHA-256\): ([0-9A-F]{2}:){31}[0-9A-F]{2}/);
    expect(said).not.toContain('Let op');
    // Once only.
    expect((await upload(printer.id, made.body.code, GOOD_CERT)).status).toBe(403);

    const listed = (await admin(org, 'GET', '/printers')).body[0];
    expect(listed.certFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(listed.certUploadedAt).toBeTruthy();
    expect(pushes.some((p) => p.event === 'print_job')).toBe(true);

    const link = (await api('POST', `${o(org)}/printers/${printer.id}/profile-link`, { user: org.cashier })).body;
    const first = await profile(printer.id, link.token);
    expect(first.status).toBe(200);
    expect(first.headers.get('Content-Type')).toBe('application/x-apple-aspen-config');
    expect(first.headers.get('Content-Disposition')).toBe('attachment; filename="arcanum-keukenprinter.mobileconfig"');
    const plist = await first.text();
    expect(plist).toContain('<string>com.apple.security.root</string>');
    expect(plist).toContain(`<data>${GOOD_CERT.replace(/-----[A-Z ]+-----|\s/g, '')}</data>`);
    // Safari may ask twice; the same printer and certificate give the same profile.
    expect(await (await profile(printer.id, link.token)).text()).toBe(plist);
    expect((await profile(printer.id, 'x'.repeat(32))).status).toBe(403);
  });

  it("warns about what Apple won't accept, and refuses another printer's or a signed certificate", async () => {
    const org = await seedOrg();
    const printer = (await admin(org, 'POST', '/printers', PRINTER)).body;
    const code = async () => (await api('POST', `${o(org)}/printers/${printer.id}/trust-code`, { user: org.cashier })).body.code as string;

    const other = await upload(printer.id, await code(), OTHER_CERT);
    expect(other.status).toBe(400);
    expect(await other.text()).toContain('niet voor 192.168.1.50');
    expect((await upload(printer.id, await code(), SIGNED_CERT)).status).toBe(400);
    expect((await upload(printer.id, await code(), 'hello')).status).toBe(400);

    // Epson-like: its common name only, ten years, not a CA - kept, with warnings.
    const epson = await upload(printer.id, await code(), EPSON_CERT);
    expect(epson.status).toBe(200);
    const said = await epson.text();
    expect(said).toContain('Subject Alternative Name');
    expect(said).toContain('hoogstens 825');
    expect(said).toContain('certificaatautoriteit');
  });

  it('a new address forgets the certificate; codes stay with their printer, push only, any screen of the org', async () => {
    const org = await seedOrg();
    const printer = (await admin(org, 'POST', '/printers', PRINTER)).body;
    const other = (await admin(org, 'POST', '/printers', { ...PRINTER, name: 'Bar', host: '10.0.0.9' })).body;
    const code = (await api('POST', `${o(org)}/printers/${printer.id}/trust-code`, { user: org.cashier })).body.code;
    // Not for another printer.
    expect((await upload(other.id, code, OTHER_CERT)).status).toBe(403);
    expect((await upload(printer.id, code, GOOD_CERT)).status).toBe(200);
    expect((await admin(org, 'PATCH', `/printers/${printer.id}`, { name: 'Keuken' })).body.certFingerprint).toBeTruthy();
    expect((await admin(org, 'PATCH', `/printers/${printer.id}`, { host: '192.168.1.51' })).body.certFingerprint).toBeNull();

    const polling = (await admin(org, 'POST', '/printers', { name: 'Haalt op', brand: 'epson', connection: 'poll', paperMm: 80 })).body;
    expect((await api('POST', `${o(org)}/printers/${polling.id}/trust-code`, { user: org.cashier })).status).toBe(404);
    const stranger = await seedOrg();
    expect((await api('POST', `${o(org)}/printers/${printer.id}/trust-code`, { user: stranger.admin })).status).toBe(403);
    // Removing the printer removes its codes.
    expect((await admin(org, 'DELETE', `/printers/${printer.id}`)).status).toBe(200);
  });
});
