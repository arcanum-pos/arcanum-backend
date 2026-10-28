// Ticket printers (arcanum/PRINTING.md). A printer is a device of the org;
// what it prints is a print job, made here and printed exactly once:
//
//   waiting -> claimed -> printed | failed
//
// Push (Epson ePOS-Print): every screen of the org hears `print_job
// {printer_id}` on its socket; a screen that uses that printer lists its
// waiting jobs and claims each - one conditional UPDATE, so of several
// screens exactly one wins (D1 is a single writer, as resolveCharge) - sends
// it to the printer on its network and reports the printer's answer. A claim
// not reported within CLAIM_SECONDS is claimable again (the screen closed).
// Polling (Server Direct Print) is phase 3.
//
// Routes (/organizations/:orgId/...):
//   GET    printers                    the org's printers (members, station screens)
//   POST   printers                    add one (admin)
//   PATCH  printers/:id                change it, incl. which stations it prints for (admin)
//   DELETE printers/:id                remove it (admin)
//   POST   printers/:id/test           a test page
//   POST   printers/:id/key            a new secret for a polling printer's URL (admin)
//   GET    printers/:id/jobs           waiting jobs, and the last hour's failed ones
//   POST   print-jobs/:id/claim        -> { claim, document, printer } or 409 print_job_taken
//   POST   print-jobs/:id/result       { claim, success, code } -> printed / failed
//   POST   print-jobs/:id/retry        a failed job waits again
//   PUT    stations/:stationId/printer { printerId } (admin, or that station's screen)
//   GET    receipt-settings            { enabled } - receipts switched on for the org?
//   PUT    receipt-settings            { enabled } (admin)
//   POST   printers/:id/receipt        { tabId, chargeId? } a receipt of a tab (members)
import { waitUntil } from 'cloudflare:workers';
import { deviceCaller } from './device-keys';
import { broadcastOrgEvent } from './devicehub-client';
import type { Env } from './env';
import { codedError, errorJson } from './errors';
import { json } from './http';
import { extractCaller, requireOrgRole, SERVICE_ROLES } from './organizations/auth';
import { MODE_LABEL_SQL } from './prep-tickets';
import { loadTabDetail } from './tabs';

const CLAIM_SECONDS = 30;
// Printed jobs are kept a day (the station screen shows what failed).
const KEEP_PRINTED_HOURS = 24;

// --- ePOS-Print XML (Epson's ePOS-Print XML User's Manual) ---

const EPOS_NS = 'http://www.epson-pos.com/schemas/2011/03/epos-print';
const xml = (s: string) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);
// Columns of Font A: 48 on 80 mm paper, 32 on 58 mm.
export const columns = (paperMm: number) => (paperMm === 58 ? 32 : 48);

const time = (iso: string) => new Date(iso).toLocaleTimeString('nl-BE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Brussels' });

// Words into lines of at most `width` characters (a longer word stays whole).
function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && (line + ' ' + word).length > width) {
      out.push(line);
      line = word;
    } else line = line ? line + ' ' + word : word;
  }
  if (line) out.push(line);
  return out;
}

// "2 x Name" and "> note", continued lines indented under the first.
const hanging = (prefix: string, text: string, width: number) =>
  wrap(text, width - prefix.length)
    .map((l, i) => (i ? ' '.repeat(prefix.length) : prefix) + l)
    .join('\n');

export interface TicketPrint {
  stationName: string;
  number: number;
  label: string;
  mode: string | null;
  createdAt: string;
  lines: { name: string; quantity: number; note: string | null }[];
  paperMm: number;
}

// A prep ticket as the kitchen reads it: the station and the number big,
// the tab and the time, then the lines - big enough to read at arm's length.
export function renderTicket(t: TicketPrint): string {
  const width = columns(t.paperMm) / 2; // the lines print double width
  const body = t.lines
    .map((l) => hanging(`${l.quantity} x `, l.name, width) + (l.note ? '\n' + hanging('> ', l.note, width) : ''))
    .join('\n');
  return (
    `<epos-print xmlns="${EPOS_NS}">` +
    `<text lang="en" smooth="true"/>` +
    `<text align="center"/>` +
    `<text width="2" height="2" em="true">${xml(t.stationName.toUpperCase())}&#10;</text>` +
    `<text width="3" height="3">#${t.number}&#10;</text>` +
    `<text width="1" height="1" em="false">${xml([t.label, t.mode].filter(Boolean).join(' - '))}&#10;${time(t.createdAt)}&#10;</text>` +
    `<feed line="1"/>` +
    `<text align="left"/>` +
    `<text width="2" height="2">${xml(body)}&#10;</text>` +
    `<text width="1" height="1"/>` +
    `<feed line="3"/>` +
    `<cut type="feed"/>` +
    `</epos-print>`
  );
}

export function renderTestPage(p: { name: string; paperMm: number; requestedBy: string }): string {
  const width = columns(p.paperMm);
  return (
    `<epos-print xmlns="${EPOS_NS}">` +
    `<text align="center"/>` +
    `<text width="2" height="2" em="true">${xml(p.name)}&#10;</text>` +
    `<text width="1" height="1" em="false">Testafdruk - Arcanum&#10;${xml(time(new Date().toISOString()))} - ${xml(p.requestedBy)}&#10;</text>` +
    `<feed line="1"/>` +
    `<text align="left"/>` +
    `<text>${'1234567890'.repeat(Math.ceil(width / 10)).slice(0, width)}&#10;</text>` +
    `<text em="true">Vet</text><text em="false"> - </text><text ul="true">onderlijnd</text><text ul="false"> - </text><text reverse="true">omgekeerd</text><text reverse="false">&#10;</text>` +
    `<text width="2" height="2">Groot 2x2&#10;</text><text width="1" height="1"/>` +
    `<feed line="3"/>` +
    `<cut type="feed"/>` +
    `</epos-print>`
  );
}

// A receipt: not a VAT receipt (Arcanum isn't a certified cash register,
// a "witte kassa") - says so at the bottom. The org, the event, the tab and
// its number, the lines net of voids, the total, the payments with their
// tips; for one payment of several (a split), what was paid now. Amounts
// without the euro sign and plain ASCII where it can be: a printer's
// character set is checked on a real one (PRINTING.md).
const RECEIPT_TEXTS = {
  nl: { tab: 'Rekening', receipt: 'Bonnummer', total: 'Totaal', paidNow: 'Nu betaald', stillOpen: 'Nog open', tip: 'fooi', notVat: 'Geen BTW-kasticket', thanks: 'Bedankt!', methods: { cash: 'Contant', bancontact: 'Bancontact', sumup: 'Kaart', tap: 'Tap to Pay' } as Record<string, string> },
  fr: { tab: 'Addition', receipt: 'Ticket n°', total: 'Total', paidNow: 'Payé maintenant', stillOpen: 'Reste à payer', tip: 'pourboire', notVat: 'Pas un ticket TVA', thanks: 'Merci !', methods: { cash: 'Espèces', bancontact: 'Bancontact', sumup: 'Carte', tap: 'Tap to Pay' } as Record<string, string> },
  en: { tab: 'Tab', receipt: 'Receipt no.', total: 'Total', paidNow: 'Paid now', stillOpen: 'Still to pay', tip: 'tip', notVat: 'Not a VAT receipt', thanks: 'Thank you!', methods: { cash: 'Cash', bancontact: 'Bancontact', sumup: 'Card', tap: 'Tap to Pay' } as Record<string, string> },
};
type Locale = keyof typeof RECEIPT_TEXTS;

const amount = (cents: number) => {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, '0')}`;
};
// Text left, amount right, on one line of `width` (the text cut if needed).
const row = (text: string, value: string, width: number) => {
  const room = width - value.length - 1;
  const left = text.length > room ? text.slice(0, room) : text;
  return left + ' '.repeat(width - left.length - value.length) + value;
};

export interface ReceiptPrint {
  orgName: string;
  eventName: string | null;
  tabLabel: string;
  tabNumber: number;
  receiptNumber: number | null;
  at: string;
  lines: { name: string; quantity: number; unitPriceCents: number }[];
  totalCents: number;
  payments: { method: string; amountCents: number; tipCents: number }[];
  paidNowCents: number | null;
  outstandingCents: number;
  paperMm: number;
  locale: Locale;
}

export function renderReceipt(r: ReceiptPrint): string {
  const t = RECEIPT_TEXTS[r.locale] ?? RECEIPT_TEXTS.nl;
  const width = columns(r.paperMm);
  const rule = '-'.repeat(width);
  const when = new Date(r.at).toLocaleString('nl-BE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Brussels' });
  const body = [
    ...r.lines.map((l) => row(`${l.quantity} x ${l.name}`, amount(l.quantity * l.unitPriceCents), width)),
    rule,
  ].join('\n');
  const payments = [
    ...r.payments.map((p) => row(`${t.methods[p.method] ?? p.method}${p.tipCents ? ` (${t.tip} ${amount(p.tipCents)})` : ''}`, amount(p.amountCents), width)),
    ...(r.paidNowCents !== null ? [row(t.paidNow, amount(r.paidNowCents), width)] : []),
    ...(r.outstandingCents > 0 ? [row(t.stillOpen, amount(r.outstandingCents), width)] : []),
  ].join('\n');
  return (
    `<epos-print xmlns="${EPOS_NS}">` +
    `<text lang="en" smooth="true"/>` +
    `<text align="center"/>` +
    `<text width="2" height="2" em="true">${xml(r.orgName)}&#10;</text>` +
    `<text width="1" height="1" em="false"/>` +
    (r.eventName ? `<text>${xml(r.eventName)}&#10;</text>` : '') +
    `<text>${xml(`${t.tab} #${r.tabNumber}${r.tabLabel ? ` - ${r.tabLabel}` : ''}`)}&#10;</text>` +
    (r.receiptNumber ? `<text>${xml(`${t.receipt} ${r.receiptNumber}`)}&#10;</text>` : '') +
    `<text>${xml(when)}&#10;</text>` +
    `<feed line="1"/>` +
    `<text align="left"/>` +
    `<text>${xml(body)}&#10;</text>` +
    `<text width="1" height="2" em="true">${xml(row(t.total + ' EUR', amount(r.totalCents), width))}&#10;</text>` +
    `<text width="1" height="1" em="false"/>` +
    (payments ? `<text>${xml(payments)}&#10;</text>` : '') +
    `<feed line="1"/>` +
    `<text align="center"/>` +
    `<text em="true">${xml(t.notVat)}&#10;</text>` +
    `<text em="false">${xml(t.thanks)}&#10;</text>` +
    `<feed line="3"/>` +
    `<cut type="feed"/>` +
    `</epos-print>`
  );
}

// --- Jobs ---

function notifyPrinter(env: Env, orgId: string, printerIds: string[]): void {
  const push = Promise.all(
    [...new Set(printerIds)].flatMap((printerId) => [
      broadcastOrgEvent(env, orgId, 'print_job', { printer_id: printerId }, 'station'),
      broadcastOrgEvent(env, orgId, 'print_job', { printer_id: printerId }, 'pos'),
    ])
  );
  try {
    waitUntil(push);
  } catch {
    // Outside a request context: the push still runs, just unguarded.
  }
}

// The prep tickets of a tab that should print and haven't yet: one job each,
// for its station's printer. Called after an order (openTab, addOrderToTab)
// and when a tab is paid (settleTab) - a self-order paid first prints only
// once it's paid. Idempotent: a ticket is queued once (idx_print_jobs_ticket).
// Never throws: printing must not fail an order.
export async function queueTicketPrints(env: Env, orgId: string, tabId: string): Promise<void> {
  try {
    const { results } = await env.DB.prepare(
      `SELECT t.id, t.order_id, t.station_id, t.created_at, s.name AS station_name, s.printer_id, p.paper_mm,
         tabs.number, tabs.event_number, tabs.label, tabs.source, tabs.pay_later, tabs.status AS tab_status,
         ${MODE_LABEL_SQL('tabs')} AS mode_label
       FROM prep_tickets t
       JOIN prep_stations s ON s.id = t.station_id
       JOIN printers p ON p.id = s.printer_id
       JOIN tabs ON tabs.id = t.tab_id
       WHERE t.tab_id = ? AND t.org_id = ?
         AND NOT EXISTS (SELECT 1 FROM print_jobs j WHERE j.kind = 'ticket' AND j.ref_id = t.id)`
    )
      .bind(tabId, orgId)
      .all<{
        id: string; order_id: string; station_id: string; created_at: string; station_name: string; printer_id: string; paper_mm: number;
        number: number; event_number: number | null; label: string; source: string; pay_later: number; tab_status: string; mode_label: string | null;
      }>();
    const tickets = (results || []).filter((t) => !(t.source === 'self_order' && !t.pay_later && t.tab_status !== 'closed'));
    if (!tickets.length) return;

    const { results: lines } = await env.DB.prepare(
      `SELECT l.order_id, l.prep_station_id, l.name, l.note,
         l.quantity + COALESCE((SELECT SUM(v.quantity) FROM order_lines v WHERE v.voids_line_id = l.id), 0) AS quantity
       FROM order_lines l
       WHERE l.order_id IN (SELECT value FROM json_each(?)) AND l.voids_line_id IS NULL AND l.prep_station_id IS NOT NULL
       ORDER BY l.created_at, l.rowid`
    )
      .bind(JSON.stringify([...new Set(tickets.map((t) => t.order_id))]))
      .all<{ order_id: string; prep_station_id: string; name: string; note: string | null; quantity: number }>();

    const now = new Date().toISOString();
    const statements = tickets.map((t) => {
      const number = t.event_number ?? t.number;
      const document = renderTicket({
        stationName: t.station_name,
        number,
        label: t.label,
        mode: t.mode_label,
        createdAt: t.created_at,
        paperMm: t.paper_mm,
        lines: (lines || []).filter((l) => l.order_id === t.order_id && l.prep_station_id === t.station_id && l.quantity > 0),
      });
      return env.DB.prepare(
        `INSERT OR IGNORE INTO print_jobs (id, org_id, printer_id, kind, ref_id, title, document, status, created_at, updated_at)
         VALUES (?, ?, ?, 'ticket', ?, ?, ?, 'waiting', ?, ?)`
      ).bind(crypto.randomUUID(), orgId, t.printer_id, t.id, `${t.station_name} #${number}`, document, now, now);
    });
    statements.push(
      env.DB.prepare(`DELETE FROM print_jobs WHERE org_id = ? AND status = 'printed' AND updated_at < ?`).bind(
        orgId,
        new Date(Date.now() - KEEP_PRINTED_HOURS * 3600_000).toISOString()
      )
    );
    await env.DB.batch(statements);
    notifyPrinter(env, orgId, tickets.map((t) => t.printer_id));
  } catch (err) {
    console.error('Kon de tickets niet klaarzetten om te printen', err);
  }
}

// --- Access ---

type Who = { kind: 'member'; admin: boolean; name: string } | { kind: 'station'; terminalId: string; stationId: string | null; name: string };

// A member of the org, or a station screen of the org (its own key).
async function caller(request: Request, env: Env, orgId: string): Promise<Who | Response> {
  const person = extractCaller(request);
  if (person) {
    const membership = await requireOrgRole(env, orgId, person, SERVICE_ROLES);
    if (!membership) return json({ error: 'Forbidden' }, 403);
    return { kind: 'member', admin: membership.role === 'admin', name: person.name || person.email || person.sub };
  }
  const device = await deviceCaller(request, env);
  if (!device) return json({ error: 'Unauthorized' }, 401);
  if (device.role !== 'station' || device.orgId !== orgId) return json({ error: 'Forbidden' }, 403);
  const own = await env.DB.prepare('SELECT station_id FROM station_devices WHERE terminal_id = ? AND org_id = ?').bind(device.terminalId, orgId).first<{ station_id: string }>();
  return { kind: 'station', terminalId: device.terminalId, stationId: own?.station_id ?? null, name: 'Stationscherm' };
}

const isAdmin = (who: Who) => who.kind === 'member' && who.admin;

// --- Printers ---

interface PrinterRow {
  id: string;
  name: string;
  brand: string;
  connection: string;
  host: string | null;
  port: number | null;
  device_id: string;
  paper_mm: number;
  poll_interval: number;
  last_poll_at: string | null;
}

async function listPrinters(env: Env, orgId: string): Promise<Response> {
  const [printers, stations] = await env.DB.batch([
    env.DB.prepare('SELECT id, name, brand, connection, host, port, device_id, paper_mm, poll_interval, last_poll_at FROM printers WHERE org_id = ? ORDER BY name COLLATE NOCASE, created_at').bind(orgId),
    env.DB.prepare('SELECT id, name, printer_id FROM prep_stations WHERE org_id = ? AND printer_id IS NOT NULL ORDER BY position, created_at').bind(orgId),
  ]);
  const byPrinter = new Map<string, { id: string; name: string }[]>();
  for (const s of (stations.results || []) as { id: string; name: string; printer_id: string }[]) {
    byPrinter.set(s.printer_id, [...(byPrinter.get(s.printer_id) || []), { id: s.id, name: s.name }]);
  }
  return json(((printers.results || []) as PrinterRow[]).map((p) => toPrinter(p, byPrinter.get(p.id) || [])));
}

const toPrinter = (p: PrinterRow, stations: { id: string; name: string }[]) => ({
  id: p.id,
  name: p.name,
  brand: p.brand,
  connection: p.connection,
  host: p.host,
  port: p.port,
  deviceId: p.device_id,
  paperMm: p.paper_mm,
  // Polling: how often it asks, and when it last did (to the minute).
  pollInterval: p.poll_interval,
  lastPollAt: p.last_poll_at,
  stations,
});

// A host as typed in the console: a name or an IPv4/IPv6 address, no scheme or path.
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*|\[?[0-9a-f:]+\]?)$/i;

type PrinterFields = Omit<PrinterRow, 'id' | 'last_poll_at'>;

function parsePrinter(body: Record<string, unknown>, existing?: PrinterRow): { ok: true; value: PrinterFields } | { ok: false; field: string } {
  const name = body.name !== undefined ? String(body.name).trim() : existing?.name;
  if (!name || name.length > 60) return { ok: false, field: 'name' };
  const brand = String(body.brand ?? existing?.brand ?? 'epson');
  // Star is shown in the console as "later": not accepted yet.
  if (brand !== 'epson') return { ok: false, field: 'brand' };
  // How it gets its work - fixed once the printer exists.
  const connection = existing?.connection ?? String(body.connection ?? 'poll');
  if (connection !== 'push' && connection !== 'poll') return { ok: false, field: 'connection' };
  // Via a screen: where the screen finds it. Polling: no address needed.
  let host: string | null = null;
  let port: number | null = null;
  if (connection === 'push') {
    host = String(body.host ?? existing?.host ?? '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
    if (!host || host.length > 253 || !HOST.test(host)) return { ok: false, field: 'host' };
    port = body.port === undefined || body.port === null || body.port === '' ? (existing?.port ?? 443) : Number(body.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, field: 'port' };
  }
  const pollInterval = Number(body.pollInterval ?? existing?.poll_interval ?? 10);
  if (!Number.isInteger(pollInterval) || pollInterval < 3 || pollInterval > 300) return { ok: false, field: 'pollInterval' };
  const deviceId = String(body.deviceId ?? existing?.device_id ?? 'local_printer').trim();
  if (!/^[A-Za-z0-9_.-]{1,30}$/.test(deviceId)) return { ok: false, field: 'deviceId' };
  const paper = Number(body.paperMm ?? existing?.paper_mm ?? 80);
  if (paper !== 58 && paper !== 80) return { ok: false, field: 'paperMm' };
  return { ok: true, value: { name, brand, connection, host, port, device_id: deviceId, paper_mm: paper, poll_interval: pollInterval } };
}

// Which stations a printer prints for: exactly the ones listed (others it
// printed for are let go). Stations of this org only.
function stationStatements(env: Env, orgId: string, printerId: string, stationIds: unknown): D1PreparedStatement[] {
  if (!Array.isArray(stationIds)) return [];
  const ids = JSON.stringify(stationIds.map(String));
  return [
    env.DB.prepare('UPDATE prep_stations SET printer_id = NULL WHERE org_id = ? AND printer_id = ? AND id NOT IN (SELECT value FROM json_each(?))').bind(orgId, printerId, ids),
    env.DB.prepare('UPDATE prep_stations SET printer_id = ? WHERE org_id = ? AND id IN (SELECT value FROM json_each(?))').bind(printerId, orgId, ids),
  ];
}

async function createPrinter(request: Request, env: Env, orgId: string): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const parsed = parsePrinter(body);
  if (!parsed.ok) return errorJson(codedError('printer_invalid', { field: parsed.field }), 400);
  const id = crypto.randomUUID();
  const p = parsed.value;
  // A polling printer gets its secret now - shown this once (pollKey).
  const key = p.connection === 'poll' ? newPollKey() : null;
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO printers (id, org_id, name, brand, connection, host, port, device_id, paper_mm, poll_interval, poll_key_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(id, orgId, p.name, p.brand, p.connection, p.host, p.port, p.device_id, p.paper_mm, p.poll_interval, key ? await sha256(key) : null, new Date().toISOString()),
    ...stationStatements(env, orgId, id, body.stationIds),
  ]);
  return printerResponse(env, orgId, id, 201, key ? { pollKey: key } : {});
}

// A new secret for a polling printer's URL (the old one stops working).
async function newKey(env: Env, orgId: string, id: string): Promise<Response> {
  const key = newPollKey();
  const result = await env.DB.prepare("UPDATE printers SET poll_key_hash = ? WHERE id = ? AND org_id = ? AND connection = 'poll'").bind(await sha256(key), id, orgId).run();
  return (result.meta.changes || 0) > 0 ? printerResponse(env, orgId, id, 200, { pollKey: key }) : errorJson('printer_not_found', 404);
}

function newPollKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function printerResponse(env: Env, orgId: string, id: string, status = 200, extra: Record<string, unknown> = {}): Promise<Response> {
  const [printer, stations] = await env.DB.batch([
    env.DB.prepare('SELECT id, name, brand, connection, host, port, device_id, paper_mm, poll_interval, last_poll_at FROM printers WHERE id = ? AND org_id = ?').bind(id, orgId),
    env.DB.prepare('SELECT id, name FROM prep_stations WHERE org_id = ? AND printer_id = ? ORDER BY position, created_at').bind(orgId, id),
  ]);
  const row = (printer.results || [])[0] as PrinterRow | undefined;
  if (!row) return errorJson('printer_not_found', 404);
  return json({ ...toPrinter(row, (stations.results || []) as { id: string; name: string }[]), ...extra }, status);
}

async function updatePrinter(request: Request, env: Env, orgId: string, id: string): Promise<Response> {
  const existing = await env.DB.prepare('SELECT id, name, brand, connection, host, port, device_id, paper_mm, poll_interval, last_poll_at FROM printers WHERE id = ? AND org_id = ?').bind(id, orgId).first<PrinterRow>();
  if (!existing) return errorJson('printer_not_found', 404);
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const parsed = parsePrinter(body, existing);
  if (!parsed.ok) return errorJson(codedError('printer_invalid', { field: parsed.field }), 400);
  const p = parsed.value;
  await env.DB.batch([
    env.DB.prepare('UPDATE printers SET name = ?, host = ?, port = ?, device_id = ?, paper_mm = ?, poll_interval = ? WHERE id = ?').bind(p.name, p.host, p.port, p.device_id, p.paper_mm, p.poll_interval, id),
    ...stationStatements(env, orgId, id, body.stationIds),
  ]);
  return printerResponse(env, orgId, id);
}

async function deletePrinter(env: Env, orgId: string, id: string): Promise<Response> {
  const [, , removed] = await env.DB.batch([
    env.DB.prepare('UPDATE prep_stations SET printer_id = NULL WHERE org_id = ? AND printer_id = ?').bind(orgId, id),
    env.DB.prepare('DELETE FROM print_jobs WHERE org_id = ? AND printer_id = ?').bind(orgId, id),
    env.DB.prepare('DELETE FROM printers WHERE id = ? AND org_id = ?').bind(id, orgId),
  ]);
  return (removed.meta.changes || 0) > 0 ? json({ ok: true }) : errorJson('printer_not_found', 404);
}

async function testPrint(env: Env, orgId: string, id: string, who: Who): Promise<Response> {
  const p = await env.DB.prepare('SELECT name, paper_mm FROM printers WHERE id = ? AND org_id = ?').bind(id, orgId).first<{ name: string; paper_mm: number }>();
  if (!p) return errorJson('printer_not_found', 404);
  const now = new Date().toISOString();
  const jobId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO print_jobs (id, org_id, printer_id, kind, title, document, status, created_at, updated_at) VALUES (?, ?, ?, 'test', 'Testafdruk', ?, 'waiting', ?, ?)`
  )
    .bind(jobId, orgId, id, renderTestPage({ name: p.name, paperMm: p.paper_mm, requestedBy: who.name }), now, now)
    .run();
  notifyPrinter(env, orgId, [id]);
  return json({ id: jobId }, 201);
}

// --- Jobs, for the screens that print ---

// Receipts: switched on per organisation (most have no printer).
async function receiptSettings(request: Request, env: Env, orgId: string, who: Who): Promise<Response> {
  if (request.method === 'PUT') {
    if (!isAdmin(who)) return json({ error: 'Forbidden' }, 403);
    const body = (await request.json().catch(() => ({}))) as { enabled?: unknown };
    if (typeof body.enabled !== 'boolean') return json({ error: 'enabled must be true or false' }, 400);
    await env.DB.prepare('UPDATE organizations SET receipts_enabled = ? WHERE id = ?').bind(body.enabled ? 1 : 0, orgId).run();
    return json({ enabled: body.enabled });
  }
  const row = await env.DB.prepare('SELECT receipts_enabled FROM organizations WHERE id = ?').bind(orgId).first<{ receipts_enabled: number }>();
  return json({ enabled: !!row?.receipts_enabled });
}

async function printReceipt(request: Request, env: Env, orgId: string, printerId: string): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { tabId?: unknown; chargeId?: unknown };
  const [org, printer] = await env.DB.batch([
    env.DB.prepare('SELECT name, locale, receipts_enabled FROM organizations WHERE id = ?').bind(orgId),
    env.DB.prepare('SELECT paper_mm FROM printers WHERE id = ? AND org_id = ?').bind(printerId, orgId),
  ]);
  const o = (org.results || [])[0] as { name: string; locale: string; receipts_enabled: number } | undefined;
  if (!o?.receipts_enabled) return errorJson('receipts_off', 409);
  const p = (printer.results || [])[0] as { paper_mm: number } | undefined;
  if (!p) return errorJson('printer_not_found', 404);
  const tab = await loadTabDetail(env, orgId, String(body.tabId || ''));
  if (!tab) return errorJson('tab_not_found', 404);

  // Lines net of voids, fully voided ones and tips left out.
  const net = new Map<string, { name: string; quantity: number; unitPriceCents: number }>();
  for (const l of tab.lines) {
    if (l.voidsLineId || l.itemCode === 'fooi') continue;
    const quantity = l.quantity - l.voidedQuantity;
    if (quantity > 0) net.set(l.id, { name: l.name, quantity, unitPriceCents: l.unitPriceCents });
  }
  const paid = tab.payments.filter((c) => c.status === 'succeeded');
  const now = body.chargeId ? paid.find((c) => c.id === body.chargeId) : null;
  const document = renderReceipt({
    orgName: o.name,
    eventName: tab.eventName,
    tabLabel: tab.label,
    tabNumber: tab.eventNumber ?? tab.number,
    receiptNumber: tab.receiptNumber,
    at: new Date().toISOString(),
    lines: [...net.values()],
    totalCents: tab.totalCents,
    payments: paid.map((c) => ({ method: c.method, amountCents: c.amountCents, tipCents: c.tipCents })),
    paidNowCents: now && paid.length > 1 ? now.amountCents : null,
    outstandingCents: tab.outstandingCents,
    paperMm: p.paper_mm,
    locale: (['nl', 'fr', 'en'].includes(o.locale) ? o.locale : 'nl') as Locale,
  });
  const at = new Date().toISOString();
  const jobId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO print_jobs (id, org_id, printer_id, kind, ref_id, title, document, status, created_at, updated_at) VALUES (?, ?, ?, 'receipt', ?, ?, ?, 'waiting', ?, ?)`
  )
    .bind(jobId, orgId, printerId, tab.id, `Bon #${tab.eventNumber ?? tab.number}`, document, at, at)
    .run();
  notifyPrinter(env, orgId, [printerId]);
  return json({ id: jobId }, 201);
}

async function listJobs(env: Env, orgId: string, printerId: string): Promise<Response> {
  const stale = new Date(Date.now() - CLAIM_SECONDS * 1000).toISOString();
  const lastHour = new Date(Date.now() - 3600_000).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT id, kind, title, status, error, attempts, created_at FROM print_jobs
     WHERE org_id = ? AND printer_id = ?
       AND (status = 'waiting' OR (status = 'claimed' AND claimed_at < ?) OR (status = 'failed' AND updated_at >= ?))
     ORDER BY created_at, rowid LIMIT 50`
  )
    .bind(orgId, printerId, stale, lastHour)
    .all<{ id: string; kind: string; title: string; status: string; error: string | null; attempts: number; created_at: string }>();
  return json(
    (results || []).map((j) => ({
      id: j.id,
      kind: j.kind,
      title: j.title,
      // A claim left unreported is waiting again.
      status: j.status === 'claimed' ? 'waiting' : j.status,
      error: j.error,
      attempts: j.attempts,
      createdAt: j.created_at,
    }))
  );
}

async function claimJob(env: Env, orgId: string, jobId: string, who: Who): Promise<Response> {
  const claim = crypto.randomUUID();
  const now = new Date().toISOString();
  const stale = new Date(Date.now() - CLAIM_SECONDS * 1000).toISOString();
  const row = await env.DB.prepare(
    `UPDATE print_jobs SET status = 'claimed', claim_token = ?, claimed_by = ?, claimed_at = ?, attempts = attempts + 1, updated_at = ?
     WHERE id = ? AND org_id = ? AND (status = 'waiting' OR (status = 'claimed' AND claimed_at < ?))
     RETURNING printer_id, document`
  )
    .bind(claim, who.kind === 'station' ? `station:${who.terminalId}` : who.name, now, now, jobId, orgId, stale)
    .first<{ printer_id: string; document: string }>();
  if (!row) {
    const exists = await env.DB.prepare('SELECT 1 FROM print_jobs WHERE id = ? AND org_id = ?').bind(jobId, orgId).first();
    return exists ? errorJson('print_job_taken', 409) : errorJson('print_job_not_found', 404);
  }
  const printer = await env.DB.prepare('SELECT host, port, device_id FROM printers WHERE id = ?').bind(row.printer_id).first<{ host: string; port: number; device_id: string }>();
  return json({ claim, document: row.document, printer: { host: printer?.host, port: printer?.port, deviceId: printer?.device_id } });
}

async function jobResult(request: Request, env: Env, orgId: string, jobId: string): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { claim?: unknown; success?: unknown; code?: unknown };
  const success = body.success === true;
  const code = success ? null : String(body.code || 'unknown').slice(0, 60);
  const result = await env.DB.prepare(
    `UPDATE print_jobs SET status = ?, error = ?, claim_token = NULL, updated_at = ?
     WHERE id = ? AND org_id = ? AND status = 'claimed' AND claim_token = ?`
  )
    .bind(success ? 'printed' : 'failed', code, new Date().toISOString(), jobId, orgId, String(body.claim || ''))
    .run();
  // A claim that expired and went to someone else: their answer counts.
  return (result.meta.changes || 0) > 0 ? json({ ok: true }) : errorJson('print_job_taken', 409);
}

async function retryJob(env: Env, orgId: string, jobId: string): Promise<Response> {
  const row = await env.DB.prepare(
    `UPDATE print_jobs SET status = 'waiting', error = NULL, updated_at = ? WHERE id = ? AND org_id = ? AND status = 'failed' RETURNING printer_id`
  )
    .bind(new Date().toISOString(), jobId, orgId)
    .first<{ printer_id: string }>();
  if (!row) return errorJson('print_job_not_found', 404);
  notifyPrinter(env, orgId, [row.printer_id]);
  return json({ ok: true });
}

// A station's printer: set in the console with the printer, or on the
// station screen itself (its own station only).
async function setStationPrinter(request: Request, env: Env, orgId: string, stationId: string, who: Who): Promise<Response> {
  if (!isAdmin(who) && !(who.kind === 'station' && who.stationId === stationId)) return json({ error: 'Forbidden' }, 403);
  const body = (await request.json().catch(() => ({}))) as { printerId?: unknown };
  const printerId = body.printerId ? String(body.printerId) : null;
  if (printerId && !(await env.DB.prepare('SELECT 1 FROM printers WHERE id = ? AND org_id = ?').bind(printerId, orgId).first())) return errorJson('printer_not_found', 404);
  const result = await env.DB.prepare('UPDATE prep_stations SET printer_id = ? WHERE id = ? AND org_id = ?').bind(printerId, stationId, orgId).run();
  return (result.meta.changes || 0) > 0 ? json({ ok: true, printerId }) : errorJson('station_not_found', 404);
}

export async function dispatchPrintingRoute(request: Request, env: Env, pathname: string): Promise<Response | null> {
  const m = pathname.match(/^\/organizations\/([^/]+)\/(printers|print-jobs|stations|receipt-settings)(?:\/([^/]+))?(?:\/([^/]+))?$/);
  if (!m) return null;
  const [, orgId, root, id, sub] = m;
  const method = request.method;
  if (root === 'stations' && !(id && sub === 'printer' && method === 'PUT')) return null;

  const who = await caller(request, env, orgId);
  if (who instanceof Response) return who;

  if (root === 'stations') return setStationPrinter(request, env, orgId, id!, who);
  if (root === 'receipt-settings' && !id && (method === 'GET' || method === 'PUT')) return receiptSettings(request, env, orgId, who);
  if (root === 'receipt-settings') return null;
  if (root === 'printers') {
    if (!id && method === 'GET') return listPrinters(env, orgId);
    if (id && sub === 'jobs' && method === 'GET') return listJobs(env, orgId, id);
    // A test page: from the console, or the station screen's settings.
    if (id && sub === 'test' && method === 'POST') return testPrint(env, orgId, id, who);
    // A receipt: from a kassa or the waiter's screen (a signed-in member).
    if (id && sub === 'receipt' && method === 'POST') return who.kind === 'member' ? printReceipt(request, env, orgId, id) : json({ error: 'Forbidden' }, 403);
    if (!isAdmin(who)) return json({ error: 'Forbidden' }, 403);
    if (id && sub === 'key' && method === 'POST') return newKey(env, orgId, id);
    if (!id && method === 'POST') return createPrinter(request, env, orgId);
    if (id && !sub && method === 'PATCH') return updatePrinter(request, env, orgId, id);
    if (id && !sub && method === 'DELETE') return deletePrinter(env, orgId, id);
    return null;
  }
  if (root === 'print-jobs' && id && method === 'POST') {
    if (sub === 'claim') return claimJob(env, orgId, id, who);
    if (sub === 'result') return jobResult(request, env, orgId, id);
    if (sub === 'retry') return retryJob(env, orgId, id);
  }
  return null;
}

// --- A printer asking for its work (Epson Server Direct Print) ---
//
// POST /public/print/epson/:printerId?key=<secret>, a form:
//   ConnectionType=GetRequest   -> an empty answer (nothing to print) or a
//                                  <PrintRequestInfo> with up to POLL_JOBS
//                                  jobs, claimed for this printer
//   ConnectionType=SetResponse  -> ResponseFile: <PrintResponseInfo>, a
//                                  <response success code> per job, in order
// Version 1.00 (every SDP printer; no job ids): the results are matched to
// the jobs in the order they were sent. Nothing to print costs one round
// trip to D1.
const POLL_JOBS = 5;

export async function dispatchPublicPrintRoute(request: Request, env: Env, pathname: string): Promise<Response | null> {
  const m = pathname.match(/^\/public\/print\/epson\/([^/]+)$/);
  if (!m) return null;
  if (request.method !== 'POST') return new Response(null, { status: 405 });
  const printerId = decodeURIComponent(m[1]);
  const key = new URL(request.url).searchParams.get('key') || '';
  if (key.length < 20 || key.length > 100) return new Response(null, { status: 403 });
  const keyHash = await sha256(key);
  const form = new URLSearchParams(await request.text());
  const type = form.get('ConnectionType');
  if (type === 'GetRequest') return getRequest(env, printerId, keyHash);
  if (type === 'SetResponse') return setResponse(env, printerId, keyHash, form.get('ResponseFile') || '');
  // Anything else (a status notification): heard, nothing to do.
  return (await pollingPrinter(env, printerId, keyHash)) ? new Response(null, { status: 200 }) : new Response(null, { status: 403 });
}

const pollingPrinter = (env: Env, printerId: string, keyHash: string) =>
  env.DB.prepare("SELECT org_id FROM printers WHERE id = ? AND poll_key_hash = ? AND connection = 'poll'").bind(printerId, keyHash).first<{ org_id: string }>();

async function getRequest(env: Env, printerId: string, keyHash: string): Promise<Response> {
  const now = new Date();
  const at = now.toISOString();
  const stale = new Date(now.getTime() - CLAIM_SECONDS * 1000).toISOString();
  const minuteAgo = new Date(now.getTime() - 60_000).toISOString();
  const isPrinter = `EXISTS (SELECT 1 FROM printers p WHERE p.id = ? AND p.poll_key_hash = ? AND p.connection = 'poll')`;
  const [printer, , claimed] = await env.DB.batch([
    env.DB.prepare("SELECT id FROM printers WHERE id = ? AND poll_key_hash = ? AND connection = 'poll'").bind(printerId, keyHash),
    // When it last asked: to the minute, so asking costs no write each time.
    env.DB.prepare(`UPDATE printers SET last_poll_at = ? WHERE id = ? AND poll_key_hash = ? AND (last_poll_at IS NULL OR last_poll_at < ?)`).bind(at, printerId, keyHash, minuteAgo),
    env.DB.prepare(
      `UPDATE print_jobs SET status = 'claimed', claim_token = 'poll', claimed_by = 'printer', claimed_at = ?, attempts = attempts + 1, updated_at = ?
       WHERE id IN (
         SELECT id FROM print_jobs
         WHERE printer_id = ? AND (status = 'waiting' OR (status = 'claimed' AND claimed_at < ?))
         ORDER BY created_at, rowid LIMIT ${POLL_JOBS}
       ) AND ${isPrinter}
       RETURNING id, document, created_at`
    ).bind(at, at, printerId, stale, printerId, keyHash),
  ]);
  if (!(printer.results || []).length) return new Response(null, { status: 403 });
  const jobs = ((claimed.results || []) as { id: string; document: string; created_at: string }[]).sort((a, b) => a.created_at.localeCompare(b.created_at));
  if (!jobs.length) return new Response(null, { status: 200 });
  const body =
    '<?xml version="1.0" encoding="utf-8"?><PrintRequestInfo Version="1.00">' +
    jobs.map((j) => `<ePOSPrint><Parameter><devid>local_printer</devid><timeout>10000</timeout></Parameter><PrintData>${j.document}</PrintData></ePOSPrint>`).join('') +
    '</PrintRequestInfo>';
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/xml; charset=utf-8' } });
}

async function setResponse(env: Env, printerId: string, keyHash: string, file: string): Promise<Response> {
  const printer = await pollingPrinter(env, printerId, keyHash);
  if (!printer) return new Response(null, { status: 403 });
  const results = [...file.matchAll(/<response\b([^>]*)>/g)].map((r) => ({
    success: /\bsuccess="true"/.test(r[1]),
    code: r[1].match(/\bcode="([^"]*)"/)?.[1] || null,
  }));
  if (!results.length) return new Response(null, { status: 200 });
  // The jobs it took, in the order they were sent.
  const { results: jobs } = await env.DB.prepare(
    `SELECT id FROM print_jobs WHERE printer_id = ? AND status = 'claimed' AND claimed_by = 'printer' ORDER BY created_at, rowid LIMIT ?`
  )
    .bind(printerId, results.length)
    .all<{ id: string }>();
  const at = new Date().toISOString();
  const statements = (jobs || []).map((j, i) =>
    env.DB.prepare(`UPDATE print_jobs SET status = ?, error = ?, claim_token = NULL, updated_at = ? WHERE id = ? AND status = 'claimed'`).bind(
      results[i].success ? 'printed' : 'failed',
      results[i].success ? null : (results[i].code || 'unknown').slice(0, 60),
      at,
      j.id
    )
  );
  if (statements.length) await env.DB.batch(statements);
  // A failure shows on the screens that use this printer.
  if (results.some((r) => !r.success)) notifyPrinter(env, printer.org_id, [printerId]);
  return new Response(null, { status: 200 });
}
