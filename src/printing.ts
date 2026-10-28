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
//   GET    printers/:id/jobs           waiting jobs, and the last hour's failed ones
//   POST   print-jobs/:id/claim        -> { claim, document, printer } or 409 print_job_taken
//   POST   print-jobs/:id/result       { claim, success, code } -> printed / failed
//   POST   print-jobs/:id/retry        a failed job waits again
//   PUT    stations/:stationId/printer { printerId } (admin, or that station's screen)
import { waitUntil } from 'cloudflare:workers';
import { deviceCaller } from './device-keys';
import { broadcastOrgEvent } from './devicehub-client';
import type { Env } from './env';
import { codedError, errorJson } from './errors';
import { json } from './http';
import { extractCaller, requireOrgRole, SERVICE_ROLES } from './organizations/auth';
import { MODE_LABEL_SQL } from './prep-tickets';

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
}

async function listPrinters(env: Env, orgId: string): Promise<Response> {
  const [printers, stations] = await env.DB.batch([
    env.DB.prepare('SELECT id, name, brand, connection, host, port, device_id, paper_mm FROM printers WHERE org_id = ? ORDER BY name COLLATE NOCASE, created_at').bind(orgId),
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
  stations,
});

// A host as typed in the console: a name or an IPv4/IPv6 address, no scheme or path.
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*|\[?[0-9a-f:]+\]?)$/i;

function parsePrinter(body: Record<string, unknown>, existing?: PrinterRow): { ok: true; value: Omit<PrinterRow, 'id'> } | { ok: false; field: string } {
  const name = body.name !== undefined ? String(body.name).trim() : existing?.name;
  if (!name || name.length > 60) return { ok: false, field: 'name' };
  const brand = String(body.brand ?? existing?.brand ?? 'epson');
  // Star is shown in the console as "later": not accepted yet.
  if (brand !== 'epson') return { ok: false, field: 'brand' };
  const connection = String(body.connection ?? existing?.connection ?? 'push');
  // Polling is phase 3.
  if (connection !== 'push') return { ok: false, field: 'connection' };
  const host = String(body.host ?? existing?.host ?? '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  if (!host || host.length > 253 || !HOST.test(host)) return { ok: false, field: 'host' };
  const port = body.port === undefined || body.port === null || body.port === '' ? (existing?.port ?? 443) : Number(body.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, field: 'port' };
  const deviceId = String(body.deviceId ?? existing?.device_id ?? 'local_printer').trim();
  if (!/^[A-Za-z0-9_.-]{1,30}$/.test(deviceId)) return { ok: false, field: 'deviceId' };
  const paper = Number(body.paperMm ?? existing?.paper_mm ?? 80);
  if (paper !== 58 && paper !== 80) return { ok: false, field: 'paperMm' };
  return { ok: true, value: { name, brand, connection, host, port, device_id: deviceId, paper_mm: paper } };
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
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO printers (id, org_id, name, brand, connection, host, port, device_id, paper_mm, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(id, orgId, p.name, p.brand, p.connection, p.host, p.port, p.device_id, p.paper_mm, new Date().toISOString()),
    ...stationStatements(env, orgId, id, body.stationIds),
  ]);
  return printerResponse(env, orgId, id, 201);
}

async function printerResponse(env: Env, orgId: string, id: string, status = 200): Promise<Response> {
  const [printer, stations] = await env.DB.batch([
    env.DB.prepare('SELECT id, name, brand, connection, host, port, device_id, paper_mm FROM printers WHERE id = ? AND org_id = ?').bind(id, orgId),
    env.DB.prepare('SELECT id, name FROM prep_stations WHERE org_id = ? AND printer_id = ? ORDER BY position, created_at').bind(orgId, id),
  ]);
  const row = (printer.results || [])[0] as PrinterRow | undefined;
  if (!row) return errorJson('printer_not_found', 404);
  return json(toPrinter(row, (stations.results || []) as { id: string; name: string }[]), status);
}

async function updatePrinter(request: Request, env: Env, orgId: string, id: string): Promise<Response> {
  const existing = await env.DB.prepare('SELECT id, name, brand, connection, host, port, device_id, paper_mm FROM printers WHERE id = ? AND org_id = ?').bind(id, orgId).first<PrinterRow>();
  if (!existing) return errorJson('printer_not_found', 404);
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const parsed = parsePrinter(body, existing);
  if (!parsed.ok) return errorJson(codedError('printer_invalid', { field: parsed.field }), 400);
  const p = parsed.value;
  await env.DB.batch([
    env.DB.prepare('UPDATE printers SET name = ?, host = ?, port = ?, device_id = ?, paper_mm = ? WHERE id = ?').bind(p.name, p.host, p.port, p.device_id, p.paper_mm, id),
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
  const m = pathname.match(/^\/organizations\/([^/]+)\/(printers|print-jobs|stations)(?:\/([^/]+))?(?:\/([^/]+))?$/);
  if (!m) return null;
  const [, orgId, root, id, sub] = m;
  const method = request.method;
  if (root === 'stations' && !(id && sub === 'printer' && method === 'PUT')) return null;

  const who = await caller(request, env, orgId);
  if (who instanceof Response) return who;

  if (root === 'stations') return setStationPrinter(request, env, orgId, id!, who);
  if (root === 'printers') {
    if (!id && method === 'GET') return listPrinters(env, orgId);
    if (id && sub === 'jobs' && method === 'GET') return listJobs(env, orgId, id);
    // A test page: from the console, or the station screen's settings.
    if (id && sub === 'test' && method === 'POST') return testPrint(env, orgId, id, who);
    if (!isAdmin(who)) return json({ error: 'Forbidden' }, 403);
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
