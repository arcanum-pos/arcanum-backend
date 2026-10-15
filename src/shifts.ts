// Registers, shifts and kasopmaak — DOMAIN_MODEL.md "Registers, shifts and
// kasopmaak" (release B2). A register is a cash drawer ("Toog") that one or
// more kassas picked; its shift runs from "Kassa openen" (with an opening
// float) to "Kasopmaak" (the count). Money belongs to the shift it was paid
// in. A kassa without a register sells as before, outside any shift.
//
//   GET    /organizations/:org/registers                      member: { blindCount, registers }
//   POST   /organizations/:org/registers                      admin: { name }
//   PATCH  /organizations/:org/registers/:id                  admin: { name?, archived? }
//   PUT    /organizations/:org/shift-settings                 admin: { blindCount }
//   GET    /organizations/:org/registers/:id/shift            member: { register, shift | null, suggestedFloatCents, blindCount }
//   POST   /organizations/:org/registers/:id/shift            member: open — { floatCents, count? }
//   POST   /organizations/:org/shifts/:id/movements           member: { direction: in|out, amountCents, reason }
//   POST   /organizations/:org/shifts/:id/close               member: { countedCents, count?, note?, leftInDrawerCents }
//   GET    /organizations/:org/shifts[?register=…]            member: the latest shifts, closed ones with their count
//
// Cash formula (snapshotted at close):
//   expected = opening float + cash payments of this shift (tips included)
//              + cash in − cash out;   difference = counted − expected.
import type { Env } from './env';
import { errorJson } from './errors';
import { json } from './http';
import { extractCaller, requireOrgRole } from './organizations/auth';
import { broadcastOrgEvent } from './devicehub-client';
import { staffOf } from './staff';

const MAX_NAME = 40;
const MAX_CENTS = 10_000_000;
// Without blind count, a difference of this much or more needs a note.
export const NOTE_THRESHOLD_CENTS = 100;

interface RegisterRow {
  id: string;
  org_id: string;
  name: string;
  created_at: string;
  archived_at: string | null;
}

interface ShiftRow {
  id: string;
  org_id: string;
  register_id: string;
  number: number;
  status: 'open' | 'closed';
  opened_at: string;
  opened_by_name: string | null;
  opened_by_staff_name: string | null;
  opening_float_cents: number;
  opening_count: string | null;
  closed_at: string | null;
  closed_by_name: string | null;
  closed_by_staff_name: string | null;
  counted_cents: number | null;
  closing_count: string | null;
  expected_cents: number | null;
  difference_cents: number | null;
  totals: string | null;
  note: string | null;
  left_in_drawer_cents: number | null;
}

type Caller = { admin: boolean; name: string | null };

async function member(request: Request, env: Env, orgId: string): Promise<Caller | Response> {
  const caller = extractCaller(request);
  if (!caller) return json({ error: 'Unauthorized' }, 401);
  const membership = await requireOrgRole(env, orgId, caller, ['admin', 'cashier']);
  if (!membership) return json({ error: 'Forbidden' }, 403);
  return { admin: membership.role === 'admin', name: request.headers.get('X-User-Name') || caller.email || null };
}

const cents = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= MAX_CENTS ? (v as number) : null);

// A count per denomination: { "5000": 2, "200": 7, … } (cents → how many) —
// what it adds up to, or null when it isn't one.
function countOf(value: unknown): { json: string; total: number } | null {
  if (!value || typeof value !== 'object') return null;
  let total = 0;
  const clean: Record<string, number> = {};
  for (const [k, n] of Object.entries(value as Record<string, unknown>)) {
    const denomination = Number(k);
    if (!Number.isInteger(denomination) || denomination <= 0 || !Number.isInteger(n) || (n as number) < 0 || (n as number) > 100_000) return null;
    if (n) clean[k] = n as number;
    total += denomination * (n as number);
  }
  return { json: JSON.stringify(clean), total };
}

const blindCount = async (env: Env, orgId: string) =>
  !!(await env.DB.prepare('SELECT blind_count FROM organizations WHERE id = ?').bind(orgId).first<{ blind_count: number }>())?.blind_count;

// --- Selling within a shift (tabs.ts, the payment routes) ---

// The open shift of the register a kassa sells on: its id, or refused when
// the register has none (409 register_closed). No register: no shift (null).
export async function shiftForSale(env: Env, orgId: string, registerId: unknown): Promise<string | null | Response> {
  if (registerId === undefined || registerId === null || registerId === '') return null;
  const register = await env.DB.prepare('SELECT id FROM registers WHERE id = ? AND org_id = ? AND archived_at IS NULL').bind(String(registerId), orgId).first();
  if (!register) return errorJson('register_not_found', 404);
  const shift = await env.DB.prepare("SELECT id FROM shifts WHERE register_id = ? AND status = 'open'").bind(String(registerId)).first<{ id: string }>();
  return shift ? shift.id : errorJson('register_closed', 409);
}

// --- What a shift adds up to, live (open) or as snapshotted (closed) ---

interface Totals {
  // Per method: how many payments, their total (tips included) and the tips.
  methods: Record<string, { count: number; cents: number; tipCents: number }>;
  cashIn: number;
  cashOut: number;
}

async function liveTotals(env: Env, shiftId: string): Promise<Totals> {
  const [byMethod, moves] = await env.DB.batch([
    env.DB.prepare(
      "SELECT method, COUNT(*) AS count, SUM(amount_cents) AS cents, SUM(tip_cents) AS tip_cents FROM charges WHERE shift_id = ? AND status = 'succeeded' GROUP BY method"
    ).bind(shiftId),
    env.DB.prepare('SELECT direction, SUM(amount_cents) AS cents FROM cash_movements WHERE shift_id = ? GROUP BY direction').bind(shiftId),
  ]);
  const methods: Totals['methods'] = {};
  for (const r of (byMethod.results || []) as { method: string; count: number; cents: number; tip_cents: number }[]) {
    methods[r.method] = { count: r.count, cents: r.cents || 0, tipCents: r.tip_cents || 0 };
  }
  const sum = (d: string) => ((moves.results || []) as { direction: string; cents: number }[]).find((m) => m.direction === d)?.cents || 0;
  return { methods, cashIn: sum('in'), cashOut: sum('out') };
}

const expectedOf = (row: ShiftRow, t: Totals) => row.opening_float_cents + (t.methods.cash?.cents || 0) + t.cashIn - t.cashOut;

async function shiftJson(env: Env, row: ShiftRow, opts: { hideExpected: boolean }) {
  const open = row.status === 'open';
  const totals = open ? await liveTotals(env, row.id) : (JSON.parse(row.totals || 'null') as Totals | null) ?? { methods: {}, cashIn: 0, cashOut: 0 };
  const extra = open
    ? await env.DB.batch([
        env.DB.prepare("SELECT COUNT(*) AS n FROM charges WHERE shift_id = ? AND status = 'pending'").bind(row.id),
        env.DB.prepare("SELECT COUNT(*) AS n FROM tabs WHERE org_id = ? AND status = 'open' AND source = 'kassa'").bind(row.org_id),
        env.DB.prepare('SELECT direction, amount_cents, reason, staff_name, user_name, created_at FROM cash_movements WHERE shift_id = ? ORDER BY created_at').bind(row.id),
      ])
    : await env.DB.batch([env.DB.prepare('SELECT direction, amount_cents, reason, staff_name, user_name, created_at FROM cash_movements WHERE shift_id = ? ORDER BY created_at').bind(row.id)]);
  const movements = ((open ? extra[2] : extra[0]).results || []) as { direction: string; amount_cents: number; reason: string; staff_name: string | null; user_name: string | null; created_at: string }[];
  const expected = open ? expectedOf(row, totals) : row.expected_cents;
  return {
    id: row.id,
    registerId: row.register_id,
    number: row.number,
    status: row.status,
    openedAt: row.opened_at,
    openedBy: row.opened_by_staff_name || row.opened_by_name,
    openingFloatCents: row.opening_float_cents,
    totals,
    movements: movements.map((m) => ({ direction: m.direction, amountCents: m.amount_cents, reason: m.reason, by: m.staff_name || m.user_name, at: m.created_at })),
    // Blind count: not before the count is in.
    expectedCents: open && opts.hideExpected ? null : expected,
    ...(open
      ? { pendingPayments: (extra[0].results?.[0] as { n: number })?.n ?? 0, openTabs: (extra[1].results?.[0] as { n: number })?.n ?? 0 }
      : {
          closedAt: row.closed_at,
          closedBy: row.closed_by_staff_name || row.closed_by_name,
          countedCents: row.counted_cents,
          differenceCents: row.difference_cents,
          note: row.note,
          leftInDrawerCents: row.left_in_drawer_cents,
        }),
  };
}

// --- Registers ---

async function listRegisters(request: Request, env: Env, orgId: string): Promise<Response> {
  const caller = await member(request, env, orgId);
  if (caller instanceof Response) return caller;
  const { results } = await env.DB.prepare(
    `SELECT r.*, (SELECT id FROM shifts s WHERE s.register_id = r.id AND s.status = 'open') AS open_shift
     FROM registers r WHERE r.org_id = ? ORDER BY r.archived_at IS NOT NULL, r.name COLLATE NOCASE`
  )
    .bind(orgId)
    .all<RegisterRow & { open_shift: string | null }>();
  return json({
    blindCount: await blindCount(env, orgId),
    registers: (results || []).map((r) => ({ id: r.id, name: r.name, archived: !!r.archived_at, open: !!r.open_shift, createdAt: r.created_at })),
  });
}

async function createRegister(request: Request, env: Env, orgId: string): Promise<Response> {
  const caller = await member(request, env, orgId);
  if (caller instanceof Response) return caller;
  if (!caller.admin) return json({ error: 'Forbidden' }, 403);
  const body = (await request.json().catch(() => ({}))) as { name?: unknown };
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, MAX_NAME) : '';
  if (!name) return errorJson('register_name_required', 400);
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO registers (id, org_id, name, created_at) VALUES (?, ?, ?, ?)').bind(id, orgId, name, new Date().toISOString()).run();
  return json({ id, name, archived: false, open: false }, 201);
}

async function updateRegister(request: Request, env: Env, orgId: string, registerId: string): Promise<Response> {
  const caller = await member(request, env, orgId);
  if (caller instanceof Response) return caller;
  if (!caller.admin) return json({ error: 'Forbidden' }, 403);
  const row = await env.DB.prepare('SELECT * FROM registers WHERE id = ? AND org_id = ?').bind(registerId, orgId).first<RegisterRow>();
  if (!row) return errorJson('register_not_found', 404);
  const body = (await request.json().catch(() => ({}))) as { name?: unknown; archived?: unknown };
  let { name, archived_at } = row;
  if (body.name !== undefined) {
    name = typeof body.name === 'string' ? body.name.trim().slice(0, MAX_NAME) : '';
    if (!name) return errorJson('register_name_required', 400);
  }
  if (body.archived !== undefined) {
    // An open drawer is closed first (Kasopmaak), never archived away.
    if (body.archived && (await env.DB.prepare("SELECT 1 FROM shifts WHERE register_id = ? AND status = 'open'").bind(registerId).first())) {
      return errorJson('register_open', 409);
    }
    archived_at = body.archived ? (archived_at ?? new Date().toISOString()) : null;
  }
  await env.DB.prepare('UPDATE registers SET name = ?, archived_at = ? WHERE id = ?').bind(name, archived_at, registerId).run();
  return json({ id: registerId, name, archived: !!archived_at });
}

async function setShiftSettings(request: Request, env: Env, orgId: string): Promise<Response> {
  const caller = await member(request, env, orgId);
  if (caller instanceof Response) return caller;
  if (!caller.admin) return json({ error: 'Forbidden' }, 403);
  const body = (await request.json().catch(() => ({}))) as { blindCount?: unknown };
  if (typeof body.blindCount !== 'boolean') return json({ error: 'blindCount must be true or false' }, 400);
  await env.DB.prepare('UPDATE organizations SET blind_count = ? WHERE id = ?').bind(body.blindCount ? 1 : 0, orgId).run();
  return json({ blindCount: body.blindCount });
}

// --- Shifts ---

async function currentShift(request: Request, env: Env, orgId: string, registerId: string): Promise<Response> {
  const caller = await member(request, env, orgId);
  if (caller instanceof Response) return caller;
  const register = await env.DB.prepare('SELECT * FROM registers WHERE id = ? AND org_id = ?').bind(registerId, orgId).first<RegisterRow>();
  if (!register) return errorJson('register_not_found', 404);
  const [open, last] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM shifts WHERE register_id = ? AND status = 'open'").bind(registerId),
    env.DB.prepare("SELECT left_in_drawer_cents FROM shifts WHERE register_id = ? AND status = 'closed' ORDER BY closed_at DESC LIMIT 1").bind(registerId),
  ]);
  const shift = (open.results?.[0] as ShiftRow | undefined) ?? null;
  const blind = await blindCount(env, orgId);
  return json({
    register: { id: register.id, name: register.name, archived: !!register.archived_at },
    shift: shift ? await shiftJson(env, shift, { hideExpected: blind }) : null,
    // The previous close's "left in the drawer": the float to start with.
    suggestedFloatCents: (last.results?.[0] as { left_in_drawer_cents: number | null } | undefined)?.left_in_drawer_cents ?? null,
    blindCount: blind,
  });
}

async function openShift(request: Request, env: Env, orgId: string, registerId: string): Promise<Response> {
  const caller = await member(request, env, orgId);
  if (caller instanceof Response) return caller;
  const register = await env.DB.prepare('SELECT * FROM registers WHERE id = ? AND org_id = ? AND archived_at IS NULL').bind(registerId, orgId).first<RegisterRow>();
  if (!register) return errorJson('register_not_found', 404);
  const body = (await request.json().catch(() => ({}))) as { floatCents?: unknown; count?: unknown };
  const count = body.count !== undefined && body.count !== null ? countOf(body.count) : null;
  if (body.count !== undefined && body.count !== null && !count) return errorJson('shift_count_invalid', 400);
  const float = count ? count.total : cents(body.floatCents);
  if (float === null) return errorJson('shift_count_invalid', 400);
  const staff = await staffOf(request, env, orgId);
  const id = crypto.randomUUID();
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT OR IGNORE INTO org_counters (org_id, name, value) VALUES (?, 'shift', 0)`).bind(orgId),
      env.DB.prepare(`UPDATE org_counters SET value = value + 1 WHERE org_id = ? AND name = 'shift'`).bind(orgId),
      env.DB.prepare(
        `INSERT INTO shifts (id, org_id, register_id, number, status, opened_at, opened_by_name, opened_by_staff_name, opening_float_cents, opening_count)
         SELECT ?, ?, ?, value, 'open', ?, ?, ?, ?, ? FROM org_counters WHERE org_id = ? AND name = 'shift'`
      ).bind(id, orgId, registerId, new Date().toISOString(), caller.name, staff?.name ?? null, float, count?.json ?? null, orgId),
    ]);
  } catch (err) {
    // The unique index: another kassa of this register opened it just now.
    if (/UNIQUE/i.test(String(err))) return errorJson('shift_already_open', 409);
    throw err;
  }
  await broadcastOrgEvent(env, orgId, 'shift_changed', { register_id: registerId });
  const row = await env.DB.prepare('SELECT * FROM shifts WHERE id = ?').bind(id).first<ShiftRow>();
  return json(await shiftJson(env, row!, { hideExpected: await blindCount(env, orgId) }), 201);
}

async function openShiftRow(env: Env, orgId: string, shiftId: string): Promise<ShiftRow | Response> {
  const row = await env.DB.prepare('SELECT * FROM shifts WHERE id = ? AND org_id = ?').bind(shiftId, orgId).first<ShiftRow>();
  if (!row) return errorJson('shift_not_found', 404);
  if (row.status !== 'open') return errorJson('shift_closed', 409);
  return row;
}

async function addMovement(request: Request, env: Env, orgId: string, shiftId: string): Promise<Response> {
  const caller = await member(request, env, orgId);
  if (caller instanceof Response) return caller;
  const row = await openShiftRow(env, orgId, shiftId);
  if (row instanceof Response) return row;
  const body = (await request.json().catch(() => ({}))) as { direction?: unknown; amountCents?: unknown; reason?: unknown; deviceName?: unknown };
  const direction = body.direction === 'in' || body.direction === 'out' ? body.direction : null;
  const amount = cents(body.amountCents);
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 140) : '';
  if (!direction || !amount || !reason) return errorJson('movement_invalid', 400);
  const staff = await staffOf(request, env, orgId);
  await env.DB.prepare(
    'INSERT INTO cash_movements (id, org_id, shift_id, direction, amount_cents, reason, device_name, user_name, staff_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )
    .bind(crypto.randomUUID(), orgId, shiftId, direction, amount, reason, typeof body.deviceName === 'string' ? body.deviceName.slice(0, 100) : null, caller.name, staff?.name ?? null, new Date().toISOString())
    .run();
  return json(await shiftJson(env, row, { hideExpected: await blindCount(env, orgId) }), 201);
}

async function closeShift(request: Request, env: Env, orgId: string, shiftId: string): Promise<Response> {
  const caller = await member(request, env, orgId);
  if (caller instanceof Response) return caller;
  const row = await openShiftRow(env, orgId, shiftId);
  if (row instanceof Response) return row;
  // A payment still under way would land in the wrong drawer (decision 7).
  const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM charges WHERE shift_id = ? AND status = 'pending'").bind(shiftId).first<{ n: number }>();
  if (pending?.n) return errorJson('shift_payment_pending', 409);
  const body = (await request.json().catch(() => ({}))) as { countedCents?: unknown; count?: unknown; note?: unknown; leftInDrawerCents?: unknown };
  const count = body.count !== undefined && body.count !== null ? countOf(body.count) : null;
  if (body.count !== undefined && body.count !== null && !count) return errorJson('shift_count_invalid', 400);
  const counted = count ? count.total : cents(body.countedCents);
  const left = cents(body.leftInDrawerCents ?? 0);
  if (counted === null || left === null || left > counted) return errorJson('shift_count_invalid', 400);
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : '';

  const totals = await liveTotals(env, shiftId);
  const expected = expectedOf(row, totals);
  const difference = counted - expected;
  const blind = await blindCount(env, orgId);
  // Without blind count the difference is seen while counting: a big one is explained.
  if (!blind && Math.abs(difference) >= NOTE_THRESHOLD_CENTS && !note) return errorJson('shift_note_required', 400);

  const staff = await staffOf(request, env, orgId);
  const closed = await env.DB.prepare(
    `UPDATE shifts SET status = 'closed', closed_at = ?, closed_by_name = ?, closed_by_staff_name = ?, counted_cents = ?, closing_count = ?,
       expected_cents = ?, difference_cents = ?, totals = ?, note = ?, left_in_drawer_cents = ?
     WHERE id = ? AND status = 'open'
       AND NOT EXISTS (SELECT 1 FROM charges WHERE shift_id = ? AND status = 'pending')`
  )
    .bind(new Date().toISOString(), caller.name, staff?.name ?? null, counted, count?.json ?? null, expected, difference, JSON.stringify(totals), note || null, left, shiftId, shiftId)
    .run();
  if (!closed.meta.changes) return errorJson('shift_payment_pending', 409);
  await broadcastOrgEvent(env, orgId, 'shift_changed', { register_id: row.register_id });
  const after = await env.DB.prepare('SELECT * FROM shifts WHERE id = ?').bind(shiftId).first<ShiftRow>();
  return json(await shiftJson(env, after!, { hideExpected: false }));
}

async function listShifts(request: Request, env: Env, orgId: string): Promise<Response> {
  const caller = await member(request, env, orgId);
  if (caller instanceof Response) return caller;
  const register = new URL(request.url).searchParams.get('register');
  const { results } = await env.DB.prepare(
    `SELECT s.*, r.name AS register_name FROM shifts s JOIN registers r ON r.id = s.register_id
     WHERE s.org_id = ? ${register ? 'AND s.register_id = ?' : ''} ORDER BY s.opened_at DESC LIMIT 50`
  )
    .bind(...(register ? [orgId, register] : [orgId]))
    .all<ShiftRow & { register_name: string }>();
  return json(
    (results || []).map((r) => ({
      id: r.id,
      number: r.number,
      registerId: r.register_id,
      registerName: r.register_name,
      status: r.status,
      openedAt: r.opened_at,
      openedBy: r.opened_by_staff_name || r.opened_by_name,
      closedAt: r.closed_at,
      closedBy: r.closed_by_staff_name || r.closed_by_name,
      openingFloatCents: r.opening_float_cents,
      expectedCents: r.status === 'closed' ? r.expected_cents : null,
      countedCents: r.counted_cents,
      differenceCents: r.difference_cents,
      note: r.note,
      totals: r.totals ? JSON.parse(r.totals) : null,
    }))
  );
}

export async function dispatchShiftsRoute(request: Request, env: Env, pathname: string): Promise<Response | null> {
  const m = request.method;
  let r = pathname.match(/^\/organizations\/([^/]+)\/registers$/);
  if (r && m === 'GET') return listRegisters(request, env, r[1]);
  if (r && m === 'POST') return createRegister(request, env, r[1]);
  r = pathname.match(/^\/organizations\/([^/]+)\/registers\/([^/]+)$/);
  if (r && m === 'PATCH') return updateRegister(request, env, r[1], decodeURIComponent(r[2]));
  r = pathname.match(/^\/organizations\/([^/]+)\/registers\/([^/]+)\/shift$/);
  if (r && m === 'GET') return currentShift(request, env, r[1], decodeURIComponent(r[2]));
  if (r && m === 'POST') return openShift(request, env, r[1], decodeURIComponent(r[2]));
  r = pathname.match(/^\/organizations\/([^/]+)\/shift-settings$/);
  if (r && m === 'PUT') return setShiftSettings(request, env, r[1]);
  r = pathname.match(/^\/organizations\/([^/]+)\/shifts$/);
  if (r && m === 'GET') return listShifts(request, env, r[1]);
  r = pathname.match(/^\/organizations\/([^/]+)\/shifts\/([^/]+)\/(movements|close)$/);
  if (r && m === 'POST') return r[3] === 'movements' ? addMovement(request, env, r[1], decodeURIComponent(r[2])) : closeShift(request, env, r[1], decodeURIComponent(r[2]));
  return null;
}
