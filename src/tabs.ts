// Tabs (rekeningen) → orders (bestellingen) → order lines — see
// DOMAIN_MODEL.md. A counter sale is just a tab that's paid immediately; a
// table/customer tab stays open while orders accumulate. Tabs belong to the
// org, not to a device: any kassa of the org can list, add to and pay any
// open tab, and device/user attribution lives on each order and each payment
// instead.
//
// Append-only throughout: submitted lines are never edited or deleted — a
// correction is a new negative-quantity line pointing at the original
// (voids_line_id) with a reason. A tab with nothing left on it is
// cancelled, not deleted.
//
// Concurrency is enforced here and in the schema, never by client-side
// sync: at most one pending charge per tab (idx_charges_one_pending_per_tab),
// a tab charge must be for exactly the outstanding amount, orders/voids are
// refused while a charge is pending, and settleTab only closes a tab once
// paid >= total — all as conditions inside the SQL itself, so two kassas
// racing can at worst leave a tab open with a remainder, never closed short.
//
// Every order line references a catalog entry (variantId + the order's
// catalogId) and is priced by the server from it — the kassa never sends a
// price — with name/price/code/category/VAT copied in at sale time. Fooi is
// a tip on the payment (charges.tip_cents), not a line.
import { shiftForSale } from './shifts';
import { staffForSale } from './staff';
import type { Env } from './env';
import { json } from './http';
import { codedError, errorBody, errorJson, type CodedError } from './errors';
import { extractCaller, requireOrgRole, SERVICE_ROLES } from './organizations/auth';
import { displayName } from './catalog';
import { jsonRowsStatement } from './sql-json';
import { notifyTabChanged } from './devicehub-client';
import { cancelExpiredSelfOrders, MODE_LABEL_SQL, ticketInsertStatement } from './prep-tickets';

type TabStatus = 'open' | 'closed' | 'cancelled';

interface TabRow {
  id: string;
  org_id: string;
  number: number;
  label: string;
  status: TabStatus;
  slot_id: string | null;
  event_id: string | null;
  event_name?: string | null;
  split_parts?: number | null;
  split_paid?: number;
  opened_device_id: string | null;
  opened_device_name: string | null;
  opened_by_name: string | null;
  staff_name?: string | null;
  opened_by_email: string | null;
  opened_at: string;
  closed_at: string | null;
  receipt_number: number | null;
  cancel_reason: string | null;
  // Migration 0025: the short number within its event, 'kassa' | 'self_order',
  // and the token of its "follow your order" page.
  event_number: number | null;
  source: string;
  order_token: string | null;
  pay_later: number;
  // Migration 0028: the ordering mode it came in by, its name a snapshot.
  order_mode_id: string | null;
  order_mode_name: string | null;
  mode_label?: string | null;
}

interface TabSummaryRow extends TabRow {
  total_cents: number;
  paid_cents: number;
  payment_pending: number;
  // JSON array, see METHODS_SQL.
  methods: string | null;
  item_count: number;
}

interface OrderRow {
  id: string;
  source: string;
  device_id: string | null;
  device_name: string | null;
  user_name: string | null;
  staff_name?: string | null;
  user_email: string | null;
  submitted_at: string;
}

interface LineRow {
  id: string;
  order_id: string;
  item_code: string | null;
  variant_id: string | null;
  name: string;
  unit_price_cents: number;
  quantity: number;
  category: string | null;
  vat_rate_bp: number | null;
  prep_station_id: string | null;
  prep_station_name: string | null;
  note: string | null;
  voids_line_id: string | null;
  void_reason: string | null;
  created_at: string;
}

interface TabChargeRow {
  id: string;
  method: string;
  status: string;
  amount_cents: number;
  tip_cents: number;
  device_name: string | null;
  user_name: string | null;
  staff_name?: string | null;
  created_at: string;
  resolved_at: string | null;
}

// SQL fragments, all scoped to an outer `tabs` row.
const TOTAL_SQL = `(SELECT COALESCE(SUM(unit_price_cents * quantity), 0) FROM order_lines WHERE tab_id = tabs.id)`;
// Tips are part of a charge's amount but never pay off the tab itself.
const PAID_SQL = `(SELECT COALESCE(SUM(amount_cents - tip_cents), 0) FROM charges WHERE tab_id = tabs.id AND status = 'succeeded')`;
const PENDING_SQL = `EXISTS (SELECT 1 FROM charges WHERE tab_id = tabs.id AND status = 'pending')`;

// Units of an order line covered by a *succeeded* item payment (split per item).
const PAID_UNITS_SQL = (lineRef: string) =>
  `(SELECT COALESCE(SUM(cl.quantity), 0) FROM charge_lines cl JOIN charges c ON c.id = cl.charge_id WHERE cl.line_id = ${lineRef} AND c.status = 'succeeded')`;

// The distinct methods of the tab's succeeded payments, in the order first
// paid — as a JSON array (one column, so still one query for the whole list).
const METHODS_SQL = `(SELECT json_group_array(method) FROM (
  SELECT method, MIN(COALESCE(resolved_at, created_at)) AS first_paid FROM charges WHERE tab_id = tabs.id AND status = 'succeeded'
  GROUP BY method ORDER BY first_paid))`;
// Units still on the tab: void lines carry negative quantities (and their
// original's item_code), so a plain sum is already net of voids. Legacy fooi
// lines hold an amount, not units — left out.
const ITEM_COUNT_SQL = `(SELECT COALESCE(SUM(quantity), 0) FROM order_lines WHERE tab_id = tabs.id AND (item_code IS NULL OR item_code <> 'fooi'))`;

const SUMMARY_SELECT = `SELECT tabs.*, ${TOTAL_SQL} AS total_cents, ${PAID_SQL} AS paid_cents, ${PENDING_SQL} AS payment_pending,
  ${METHODS_SQL} AS methods, ${ITEM_COUNT_SQL} AS item_count, (SELECT name FROM events WHERE events.id = tabs.event_id) AS event_name,
  ${MODE_LABEL_SQL('tabs')} AS mode_label FROM tabs`;

// "Gelijk verdelen": the next part is what's open ÷ parts left, rounded
// down — the last part is whatever remains, so rounding never leaves a cent
// open and a line added halfway spreads over the remaining parts.
function splitState(row: TabSummaryRow) {
  if (!row.split_parts) return null;
  const left = Math.max(1, row.split_parts - (row.split_paid || 0));
  const outstanding = row.total_cents - row.paid_cents;
  return {
    parts: row.split_parts,
    paid: Math.min(row.split_paid || 0, row.split_parts),
    nextCents: left === 1 ? outstanding : Math.floor(outstanding / left),
  };
}

function rowToTabSummary(row: TabSummaryRow) {
  return {
    id: row.id,
    number: row.number,
    // The event's short number (1, 2, 3…) — what's called out; null without an event.
    eventNumber: row.event_number ?? null,
    source: row.source,
    // A self-order tab paid when the guest leaves.
    payLater: !!row.pay_later,
    // The ordering mode it came in by; its name when the event has more than one.
    orderModeId: row.order_mode_id ?? null,
    orderMode: row.mode_label ?? null,
    label: row.label,
    status: row.status,
    slotId: row.slot_id,
    eventId: row.event_id,
    eventName: row.event_name ?? null,
    openedDeviceId: row.opened_device_id,
    openedDeviceName: row.opened_device_name,
    openedByName: row.opened_by_name,
    // The person chosen on the device (staff), when there was one.
    openedByStaff: row.staff_name ?? null,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    receiptNumber: row.receipt_number,
    cancelReason: row.cancel_reason,
    totalCents: row.total_cents,
    paidCents: row.paid_cents,
    outstandingCents: row.total_cents - row.paid_cents,
    paymentPending: !!row.payment_pending,
    split: splitState(row),
    // 'cash' | 'sumup' | 'bancontact', of succeeded payments, first paid first.
    methods: row.methods ? (JSON.parse(row.methods) as string[]) : [],
    itemCount: row.item_count,
  };
}

function rowToLine(row: LineRow) {
  return {
    id: row.id,
    orderId: row.order_id,
    itemCode: row.item_code,
    variantId: row.variant_id,
    name: row.name,
    unitPriceCents: row.unit_price_cents,
    quantity: row.quantity,
    category: row.category,
    vatRateBp: row.vat_rate_bp,
    prepStationId: row.prep_station_id,
    prepStationName: row.prep_station_name,
    note: row.note,
    voidsLineId: row.voids_line_id,
    voidReason: row.void_reason,
    createdAt: row.created_at,
  };
}

async function authorize(request: Request, env: Env, orgId: string): Promise<Response | null> {
  const caller = extractCaller(request);
  if (!caller) return json({ error: 'Unauthorized' }, 401);
  const membership = await requireOrgRole(env, orgId, caller, SERVICE_ROLES);
  if (!membership) return json({ error: 'Forbidden' }, 403);
  return null;
}

// Who/where an order or tab came from — user from the BFF's session headers
// (never the body, a client could claim to be anyone), device from the body
// (the same per-browser device id/name every charge already carries).
// The person on a shared device (staff.ts) from its signed X-Staff token —
// refused here when the organisation requires one and none was chosen.
async function attribution(request: Request, env: Env, orgId: string, body: { deviceId?: unknown; deviceName?: unknown; registerId?: unknown }): Promise<Who | Response> {
  const staff = await staffForSale(request, env, orgId);
  if (staff instanceof Response) return staff;
  // A kassa on a register sells only while its drawer is open (shifts.ts).
  const shift = await shiftForSale(env, orgId, body.registerId);
  if (shift instanceof Response) return shift;
  return {
    deviceId: body.deviceId ? String(body.deviceId).slice(0, 100) : null,
    deviceName: body.deviceName ? String(body.deviceName).slice(0, 100) : null,
    userName: request.headers.get('X-User-Name') || null,
    userEmail: request.headers.get('X-User-Email') || null,
    staffId: staff?.id ?? null,
    staffName: staff?.name ?? null,
  };
}

// Who did something: the device, the account it's signed in with, and the
// person chosen on it (staff — not on a guest's self-order).
export interface Who {
  deviceId: string | null;
  deviceName: string | null;
  userName: string | null;
  userEmail: string | null;
  staffId?: string | null;
  staffName?: string | null;
}

export interface LineInput {
  itemCode: string | null;
  name: string;
  unitPriceCents: number;
  quantity: number;
  note: string | null;
  // name/unitPriceCents/itemCode/category/vatRateBp are filled in from the
  // catalog by priceCatalogLines.
  variantId: string | null;
  category: string | null;
  vatRateBp: number | null;
  prepStationId: string | null;
  prepStationName: string | null;
}

const MAX_LINES_PER_ORDER = 100;

function parseLines(raw: unknown): LineInput[] | string {
  if (!Array.isArray(raw) || raw.length === 0) return 'lines must be a non-empty array';
  if (raw.length > MAX_LINES_PER_ORDER) return `at most ${MAX_LINES_PER_ORDER} lines per order`;

  // Since step 3d every line comes from a menukaart — the kassa never sets a
  // price itself (fooi is a tip on the payment now). Name, price and the rest
  // are filled in by priceCatalogLines.
  const lines: LineInput[] = [];
  for (const item of raw as Record<string, unknown>[]) {
    if (typeof item?.variantId !== 'string' || !item.variantId) return 'every line needs a variantId from the menukaart';
    const quantity = Number(item.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) return 'quantity must be an integer between 1 and 999';
    const note = typeof item.note === 'string' && item.note.trim() ? item.note.trim().slice(0, 200) : null;
    lines.push({
      variantId: item.variantId,
      quantity,
      note,
      itemCode: null,
      name: '',
      unitPriceCents: 0,
      category: null,
      vatRateBp: null,
      prepStationId: null,
      prepStationName: null,
    });
  }
  return lines;
}

// Fills in catalog lines from the order's catalog: the entry must be on
// that (non-archived, same-org) catalog, visible, and its product/variant
// not archived — the same rule as the kassa view, so a kassa can only sell
// what it's shown.
async function priceCatalogLines(env: Env, orgId: string, catalogId: string | null, lines: LineInput[]): Promise<string | CodedError | null> {
  const variantIds = [...new Set(lines.filter((l) => l.variantId).map((l) => l.variantId as string))];
  if (variantIds.length === 0) return null;
  if (!catalogId) return 'catalogId is required for lines with a variantId';

  const catalog = await env.DB.prepare('SELECT 1 FROM catalogs WHERE id = ? AND org_id = ? AND archived_at IS NULL').bind(catalogId, orgId).first();
  if (!catalog) return codedError('unknown_catalog');

  const { results } = await env.DB.prepare(
    `SELECT e.variant_id, e.price_cents, v.name AS variant_name, v.code, p.name AS product_name, p.vat_rate_bp, c.name AS category_name,
       ps.id AS station_id, ps.name AS station_name
     FROM catalog_entries e
     JOIN product_variants v ON v.id = e.variant_id
     JOIN products p ON p.id = v.product_id
     LEFT JOIN categories c ON c.id = p.category_id
     LEFT JOIN prep_stations ps ON ps.id = p.prep_station_id
     WHERE e.catalog_id = ? AND e.visible = 1 AND v.archived_at IS NULL AND p.archived_at IS NULL
       AND e.variant_id IN (SELECT value FROM json_each(?))`
  )
    // One JSON parameter, not one per line: D1 allows at most 100 bound parameters per query.
    .bind(catalogId, JSON.stringify(variantIds))
    .all<{
      variant_id: string;
      price_cents: number;
      variant_name: string;
      code: string | null;
      product_name: string;
      vat_rate_bp: number | null;
      category_name: string | null;
      station_id: string | null;
      station_name: string | null;
    }>();

  const byVariant = new Map((results || []).map((r) => [r.variant_id, r]));
  for (const line of lines) {
    if (!line.variantId) continue;
    const entry = byVariant.get(line.variantId);
    if (!entry) return codedError('product_not_on_catalog');
    line.name = displayName(entry.product_name, entry.variant_name);
    line.unitPriceCents = entry.price_cents;
    line.itemCode = entry.code;
    line.category = entry.category_name;
    line.vatRateBp = entry.vat_rate_bp;
    line.prepStationId = entry.station_id;
    line.prepStationName = entry.station_name;
  }
  return null;
}

// parseLines + priceCatalogLines for an order body ({ lines, catalogId? }).
export async function prepareOrderLines(env: Env, orgId: string, body: Record<string, unknown>): Promise<{ lines: LineInput[]; catalogId: string | null } | string | CodedError> {
  const lines = parseLines(body.lines);
  if (typeof lines === 'string') return lines;
  const catalogId = typeof body.catalogId === 'string' && body.catalogId ? body.catalogId : null;
  const error = await priceCatalogLines(env, orgId, catalogId, lines);
  if (error) return error;
  return { lines, catalogId: lines.some((l) => l.variantId) ? catalogId : null };
}

// All lines of an order in ONE statement (Free-plan D1 limit: 50 queries per
// request, every batch statement counting — see sql-json.ts), conditional on
// its order row having been inserted in the same batch — so a refused order
// (tab not open, payment pending) leaves no orphan lines behind,
// all-or-nothing.
const LINE_COLUMNS = [
  'id', 'org_id', 'tab_id', 'order_id', 'item_code', 'variant_id', 'name', 'unit_price_cents', 'quantity', 'category', 'vat_rate_bp',
  'prep_station_id', 'prep_station_name', 'note', 'created_at',
];

function lineInsertStatements(env: Env, orgId: string, tabId: string, orderId: string, lines: LineInput[], now: string): D1PreparedStatement[] {
  const statement = jsonRowsStatement(
    env.DB,
    'order_lines',
    LINE_COLUMNS,
    lines.map((line) => ({
      id: crypto.randomUUID(),
      org_id: orgId,
      tab_id: tabId,
      order_id: orderId,
      item_code: line.itemCode,
      variant_id: line.variantId,
      name: line.name,
      unit_price_cents: line.unitPriceCents,
      quantity: line.quantity,
      category: line.category,
      vat_rate_bp: line.vatRateBp,
      prep_station_id: line.prepStationId,
      prep_station_name: line.prepStationName,
      note: line.note,
      created_at: now,
    })),
    { where: { sql: 'EXISTS (SELECT 1 FROM orders WHERE id = ?)', params: [orderId] } }
  );
  return statement ? [statement] : [];
}

async function loadTabSummary(env: Env, orgId: string, tabId: string) {
  const row = await env.DB.prepare(`${SUMMARY_SELECT} WHERE tabs.id = ? AND tabs.org_id = ?`).bind(tabId, orgId).first<TabSummaryRow>();
  return row ? rowToTabSummary(row) : null;
}

async function loadTabDetail(env: Env, orgId: string, tabId: string) {
  const tab = await loadTabSummary(env, orgId, tabId);
  if (!tab) return null;

  const [orders, lines, charges, paidUnits, follow] = await env.DB.batch([
    env.DB.prepare('SELECT id, source, device_id, device_name, user_name, user_email, submitted_at, staff_name FROM orders WHERE tab_id = ? ORDER BY submitted_at').bind(tabId),
    env.DB.prepare('SELECT * FROM order_lines WHERE tab_id = ? ORDER BY created_at, rowid').bind(tabId),
    env.DB.prepare(
      'SELECT id, method, status, amount_cents, tip_cents, device_name, user_name, created_at, resolved_at, staff_name FROM charges WHERE tab_id = ? ORDER BY created_at'
    ).bind(tabId),
    env.DB.prepare(
      `SELECT cl.line_id, SUM(cl.quantity) AS quantity FROM charge_lines cl JOIN charges c ON c.id = cl.charge_id
       WHERE cl.tab_id = ? AND c.status = 'succeeded' GROUP BY cl.line_id`
    ).bind(tabId),
    env.DB.prepare(
      'SELECT order_token, contact_phone, contact_email, EXISTS (SELECT 1 FROM prep_tickets WHERE tab_id = tabs.id) AS has_tickets FROM tabs WHERE id = ?'
    ).bind(tabId),
  ]);
  const followRow = ((follow.results || [])[0] ?? null) as { order_token: string | null; contact_phone: string | null; contact_email: string | null; has_tickets: number } | null;

  const paid = new Map(((paidUnits.results || []) as { line_id: string; quantity: number }[]).map((r) => [r.line_id, r.quantity]));
  const lineRows = (lines.results || []) as LineRow[];
  // How much of each original line is already voided — so the kassa can
  // show "2 × Pils (1 geannuleerd)" and knows what's still voidable.
  const voided = new Map<string, number>();
  for (const l of lineRows) {
    if (l.voids_line_id) voided.set(l.voids_line_id, (voided.get(l.voids_line_id) || 0) - l.quantity);
  }

  return {
    ...tab,
    // Something to prepare: where the customer follows it (the customer display's QR once paid).
    followUrl: followRow?.order_token && followRow.has_tickets ? `${env.PUBLIC_BASE_URL}/volg/${followRow.order_token}` : null,
    // A guest's tab: how to reach them (its name is the label) — while it's open.
    contact: followRow?.contact_phone || followRow?.contact_email ? { phone: followRow.contact_phone, email: followRow.contact_email } : null,
    orders: ((orders.results || []) as OrderRow[]).map((o) => ({
      id: o.id,
      source: o.source,
      deviceId: o.device_id,
      deviceName: o.device_name,
      userName: o.user_name,
      staffName: o.staff_name ?? null,
      submittedAt: o.submitted_at,
    })),
    // paidQuantity: units already paid by an item payment (split per item).
    lines: lineRows.map((l) => ({ ...rowToLine(l), voidedQuantity: voided.get(l.id) || 0, paidQuantity: paid.get(l.id) || 0 })),
    payments: ((charges.results || []) as TabChargeRow[]).map((c) => ({
      id: c.id,
      method: c.method,
      status: c.status,
      amountCents: c.amount_cents,
      tipCents: c.tip_cents,
      deviceName: c.device_name,
      userName: c.user_name,
      staffName: c.staff_name ?? null,
      createdAt: c.created_at,
      resolvedAt: c.resolved_at,
    })),
  };
}

// What the customer display shows for a charge on this tab: the tab's name
// and its lines net of voids (fully voided ones left out). Read by the
// charge status endpoint, so a CFD on another device shows the order too —
// not just the amount. No prices beyond what's on the kassa's own ticket.
export async function customerOrder(env: Env, orgId: string, tabId: string, chargeId?: string) {
  const tab = await loadTabSummary(env, orgId, tabId);
  if (!tab) return null;
  // Per item: the units this payment covers — what the customer pays now.
  const paying = chargeId
    ? ((
        await env.DB.prepare(
          `SELECT l.name, cl.quantity, l.unit_price_cents FROM charge_lines cl JOIN order_lines l ON l.id = cl.line_id WHERE cl.charge_id = ? ORDER BY l.created_at, l.rowid`
        )
          .bind(chargeId)
          .all<{ name: string; quantity: number; unit_price_cents: number }>()
      ).results || []).map((r) => ({ name: r.name, quantity: r.quantity, unitPriceCents: r.unit_price_cents }))
    : [];
  const { results } = await env.DB.prepare('SELECT id, name, unit_price_cents, quantity, voids_line_id FROM order_lines WHERE tab_id = ? ORDER BY created_at, rowid')
    .bind(tabId)
    .all<Pick<LineRow, 'id' | 'name' | 'unit_price_cents' | 'quantity' | 'voids_line_id'>>();
  const rows = results || [];
  const voided = new Map<string, number>();
  for (const l of rows) if (l.voids_line_id) voided.set(l.voids_line_id, (voided.get(l.voids_line_id) || 0) - l.quantity);
  // Something to prepare: the customer can follow it on their phone (the
  // customer display shows the QR once it's paid).
  const follow = await env.DB.prepare('SELECT order_token, EXISTS (SELECT 1 FROM prep_tickets WHERE tab_id = tabs.id) AS has_tickets FROM tabs WHERE id = ?')
    .bind(tabId)
    .first<{ order_token: string | null; has_tickets: number }>();
  return {
    label: tab.label,
    number: tab.number,
    eventNumber: tab.eventNumber,
    followUrl: follow?.order_token && follow.has_tickets ? `${env.PUBLIC_BASE_URL}/volg/${follow.order_token}` : null,
    eventName: tab.eventName,
    // Its colours on the customer display (branding.ts).
    eventId: tab.eventId,
    split: tab.split ? { parts: tab.split.parts, paid: tab.split.paid } : null,
    // Paid on the tab so far (while a part is pending: before it).
    paidCents: tab.paidCents,
    paying: paying.length ? paying : null,
    lines: rows
      .filter((l) => !l.voids_line_id)
      .map((l) => ({ name: l.name, quantity: l.quantity - (voided.get(l.id) || 0), unitPriceCents: l.unit_price_cents }))
      .filter((l) => l.quantity > 0),
  };
}

// Distinguishes *why* a conditional write touched nothing, for a useful error.
async function refusalResponse(env: Env, orgId: string, tabId: string): Promise<Response> {
  const tab = await loadTabSummary(env, orgId, tabId);
  if (!tab) return errorJson('tab_not_found', 404);
  if (tab.status !== 'open') return errorJson('tab_not_open', 409, { tab });
  if (tab.paymentPending) return errorJson('tab_payment_pending', 409, { tab });
  return errorJson('tab_changed', 409, { tab });
}

// A guest's contact details go once the tab is paid or cancelled (run
// whenever a kassa lists tabs — no timer needed).
export function sweepContacts(env: Env, orgId: string): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE tabs SET contact_phone = NULL, contact_email = NULL WHERE org_id = ? AND status <> 'open' AND (contact_phone IS NOT NULL OR contact_email IS NOT NULL)`
  ).bind(orgId);
}

// GET /organizations/:orgId/tabs?status=open|closed|cancelled|all&since=<ISO>
// status defaults to open (the kassa's tab strip). `since` is for "today's
// bills": tabs opened or closed at/after it, plus any still open whenever
// they were opened — newest opened first.
async function listTabs(request: Request, env: Env, orgId: string): Promise<Response> {
  await cancelExpiredSelfOrders(env, orgId);
  await sweepContacts(env, orgId).run();
  const params = new URL(request.url).searchParams;
  const status = params.get('status') || 'open';
  if (!['open', 'closed', 'cancelled', 'all'].includes(status)) return json({ error: 'status must be open, closed, cancelled or all' }, 400);

  const where = ['tabs.org_id = ?'];
  const binds: unknown[] = [orgId];
  if (status !== 'all') {
    where.push('tabs.status = ?');
    binds.push(status);
  }
  const sinceParam = params.get('since');
  if (sinceParam !== null) {
    const since = /^\d{4}-\d{2}-\d{2}/.test(sinceParam) ? Date.parse(sinceParam) : NaN;
    if (Number.isNaN(since)) return json({ error: 'since must be an ISO timestamp' }, 400);
    // Normalized, since opened_at/closed_at are compared as toISOString() text.
    where.push(`(tabs.opened_at >= ? OR tabs.closed_at >= ? OR tabs.status = 'open')`);
    const iso = new Date(since).toISOString();
    binds.push(iso, iso);
  }
  const order = sinceParam !== null ? 'tabs.opened_at DESC, tabs.number DESC' : 'tabs.number DESC';

  const { results } = await env.DB.prepare(`${SUMMARY_SELECT} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 200`)
    .bind(...binds)
    .all<TabSummaryRow>();
  return json((results || []).map(rowToTabSummary));
}

// POST /organizations/:orgId/tabs { label?, slotId?, eventId?, orderModeId?, deviceId?, deviceName?, lines?, catalogId? }
// Optional `lines` submits a first order in the same batch — the Toog
// quick sale (open + order + pay) is then two round trips, not three.
// Optional `eventId` tags the tab (and so every sale paid on it) with one
// of this org's events — a reporting tag only (DOMAIN_MODEL.md decision 1),
// set once when the tab opens. `orderModeId`: one of that event's ordering
// modes, when the event lets the kassa pick one (kassa_modes) — left out,
// the only one there is (if so).
async function createTab(request: Request, env: Env, orgId: string): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const label = typeof body.label === 'string' ? body.label.trim().slice(0, 60) : '';

  let eventId: string | null = null;
  if (body.eventId !== undefined && body.eventId !== null) {
    if (typeof body.eventId !== 'string') return json({ error: 'eventId must be a string or null' }, 400);
    const event = await env.DB.prepare('SELECT id FROM events WHERE id = ? AND org_id = ?').bind(body.eventId, orgId).first<{ id: string }>();
    if (!event) return errorJson('unknown_event', 400);
    eventId = event.id;
  }

  let orderMode: { id: string; name: string } | null = null;
  if (eventId) {
    const { results: modes } = await env.DB.prepare(
      'SELECT m.id, m.name FROM event_order_modes m JOIN events e ON e.id = m.event_id WHERE m.event_id = ? AND e.kassa_modes = 1'
    )
      .bind(eventId)
      .all<{ id: string; name: string }>();
    if (body.orderModeId !== undefined && body.orderModeId !== null) {
      orderMode = (modes || []).find((m) => m.id === body.orderModeId) ?? null;
      if (!orderMode) return errorJson('unknown_order_mode', 400);
    } else if (modes?.length === 1) orderMode = modes[0];
  } else if (body.orderModeId) return errorJson('unknown_order_mode', 400);

  let lines: LineInput[] = [];
  let catalogId: string | null = null;
  if (body.lines !== undefined) {
    const prepared = await prepareOrderLines(env, orgId, body);
    if (typeof prepared === 'string' || 'code' in prepared) return json(errorBody(prepared), 400);
    ({ lines, catalogId } = prepared);
  }

  const who = await attribution(request, env, orgId, body);
  if (who instanceof Response) return who;
  const tabId = await openTab(env, { orgId, label, slotId: body.slotId ? String(body.slotId).slice(0, 100) : null, eventId, who, source: 'kassa', lines, catalogId, orderMode });
  return json(await loadTabDetail(env, orgId, tabId), 201);
}

// A random token for a tab's "follow your order" page (/volg/<token>): 144
// bits, base64url — unguessable, so a page only ever shows its own order.
export function newOrderToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_');
}

// Opens a tab — from a kassa (createTab) or a self-order page (self-order.ts)
// — with its first order if there are lines, in one batch: the tab number
// (the org's counter), the event's short number (the first one after the
// event's counter that no open tab of the event uses — so a reset to 1 never
// gives two open orders the same number), the follow token, the order, its
// lines and its prep tickets. Returns the new tab's id.
export async function openTab(
  env: Env,
  o: {
    orgId: string;
    label: string;
    slotId: string | null;
    eventId: string | null;
    who: Who;
    source: 'kassa' | 'self_order' | 'table';
    lines: LineInput[];
    catalogId: string | null;
    // A self-order tab paid when the guest leaves (self-order.ts).
    payLater?: boolean;
    // The table it's on (tables.ts, release C) — one open tab per table.
    tableId?: string | null;
    // The event's ordering mode it comes in by.
    orderMode?: { id: string; name: string } | null;
  }
): Promise<string> {
  const { orgId, eventId, who } = o;
  const tabId = crypto.randomUUID();
  const now = new Date().toISOString();

  const statements = [
    env.DB.prepare(`INSERT OR IGNORE INTO org_counters (org_id, name, value) VALUES (?, 'tab', 0)`).bind(orgId),
    env.DB.prepare(`UPDATE org_counters SET value = value + 1 WHERE org_id = ? AND name = 'tab'`).bind(orgId),
  ];
  if (eventId) {
    statements.push(
      env.DB.prepare(
        `UPDATE events SET order_counter = (
           WITH RECURSIVE n(v) AS (
             SELECT order_counter + 1 FROM events WHERE id = ?
             UNION ALL
             SELECT v + 1 FROM n WHERE EXISTS (SELECT 1 FROM tabs WHERE event_id = ? AND status = 'open' AND event_number = n.v)
           )
           SELECT MAX(v) FROM n
         ) WHERE id = ?`
      ).bind(eventId, eventId, eventId)
    );
  }
  statements.push(
    env.DB.prepare(
      `INSERT INTO tabs (id, org_id, number, label, status, slot_id, event_id, opened_device_id, opened_device_name, opened_by_name, opened_by_email, opened_at,
         event_number, source, order_token, pay_later, order_mode_id, order_mode_name, staff_id, staff_name, table_id)
       SELECT ?, ?, value, ?, 'open', ?, ?, ?, ?, ?, ?, ?, (SELECT order_counter FROM events WHERE id = ?), ?, ?, ?, ?, ?, ?, ?, ? FROM org_counters WHERE org_id = ? AND name = 'tab'`
    ).bind(
      tabId, orgId, o.label, o.slotId, eventId, who.deviceId, who.deviceName, who.userName, who.userEmail, now, eventId, o.source, newOrderToken(), o.payLater ? 1 : 0,
      o.orderMode?.id ?? null, o.orderMode?.name ?? null, who.staffId ?? null, who.staffName ?? null, o.tableId ?? null, orgId
    )
  );

  if (o.lines.length > 0) {
    const orderId = crypto.randomUUID();
    statements.push(
      env.DB.prepare(
        `INSERT INTO orders (id, org_id, tab_id, source, catalog_id, device_id, device_name, user_name, user_email, submitted_at, staff_id, staff_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(orderId, orgId, tabId, o.source, o.catalogId, who.deviceId, who.deviceName, who.userName, who.userEmail, now, who.staffId ?? null, who.staffName ?? null),
      ...lineInsertStatements(env, orgId, tabId, orderId, o.lines, now),
      ticketInsertStatement(env, orgId, tabId, orderId, now)
    );
  }

  await env.DB.batch(statements);
  notifyTabChanged(env, orgId, tabId);
  return tabId;
}

// GET /organizations/:orgId/tabs/:tabId
async function getTab(env: Env, orgId: string, tabId: string): Promise<Response> {
  const tab = await loadTabDetail(env, orgId, tabId);
  return tab ? json(tab) : errorJson('tab_not_found', 404);
}

// PATCH /organizations/:orgId/tabs/:tabId { label } — only while open.
async function renameTab(request: Request, env: Env, orgId: string, tabId: string): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { label?: unknown };
  const label = typeof body.label === 'string' ? body.label.trim().slice(0, 60) : '';

  const result = await env.DB.prepare(`UPDATE tabs SET label = ? WHERE id = ? AND org_id = ? AND status = 'open'`).bind(label, tabId, orgId).run();
  if ((result.meta.changes || 0) === 0) return refusalResponse(env, orgId, tabId);
  notifyTabChanged(env, orgId, tabId);
  return json(await loadTabDetail(env, orgId, tabId));
}

// POST /organizations/:orgId/tabs/:tabId/orders { lines, catalogId?, deviceId?, deviceName? }
async function addOrder(request: Request, env: Env, orgId: string, tabId: string): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const prepared = await prepareOrderLines(env, orgId, body);
  if (typeof prepared === 'string' || 'code' in prepared) return json(errorBody(prepared), 400);
  const { lines, catalogId } = prepared;

  const who = await attribution(request, env, orgId, body);
  if (who instanceof Response) return who;
  if (!(await addOrderToTab(env, { orgId, tabId, lines, catalogId, source: 'kassa', who }))) return refusalResponse(env, orgId, tabId);
  return json(await loadTabDetail(env, orgId, tabId), 201);
}

// One more order on an open tab — from a kassa (addOrder) or a guest's
// next round on their tab (self-order.ts) — with its lines and prep
// tickets, only while the tab is open and no payment is in progress.
// False when refused (the caller says why).
export async function addOrderToTab(
  env: Env,
  o: {
    orgId: string;
    tabId: string;
    lines: LineInput[];
    catalogId: string | null;
    source: 'kassa' | 'self_order';
    who: Who;
  }
): Promise<boolean> {
  const { orgId, tabId, who } = o;
  const orderId = crypto.randomUUID();
  const now = new Date().toISOString();
  const [orderResult] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO orders (id, org_id, tab_id, source, catalog_id, device_id, device_name, user_name, user_email, submitted_at, staff_id, staff_name)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM tabs WHERE id = ? AND org_id = ? AND status = 'open')
         AND NOT EXISTS (SELECT 1 FROM charges WHERE tab_id = ? AND status = 'pending')`
    ).bind(orderId, orgId, tabId, o.source, o.catalogId, who.deviceId, who.deviceName, who.userName, who.userEmail, now, who.staffId ?? null, who.staffName ?? null, tabId, orgId, tabId),
    ...lineInsertStatements(env, orgId, tabId, orderId, o.lines, now),
    ticketInsertStatement(env, orgId, tabId, orderId, now),
  ]);
  if ((orderResult.meta.changes || 0) === 0) return false;
  notifyTabChanged(env, orgId, tabId);
  return true;
}

// POST /organizations/:orgId/tabs/:tabId/lines/:lineId/void { reason, quantity?, deviceId?, deviceName? }
// Records a new negative line (inside its own order, so who/where voided it
// is attributed exactly like a normal order). quantity defaults to whatever
// of the original is still unvoided.
async function voidLine(request: Request, env: Env, orgId: string, tabId: string, lineId: string): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 200) : '';
  if (!reason) return json({ error: 'reason is required' }, 400);

  const original = await env.DB.prepare(
    `SELECT l.quantity + COALESCE((SELECT SUM(v.quantity) FROM order_lines v WHERE v.voids_line_id = l.id), 0) AS remaining
     FROM order_lines l WHERE l.id = ? AND l.tab_id = ? AND l.org_id = ? AND l.voids_line_id IS NULL`
  )
    .bind(lineId, tabId, orgId)
    .first<{ remaining: number }>();
  if (!original) return errorJson('line_not_found', 404);

  const quantity = body.quantity === undefined ? original.remaining : Number(body.quantity);
  if (!Number.isInteger(quantity) || quantity < 1) return errorJson('nothing_to_void', 409);

  const who = await attribution(request, env, orgId, body);
  if (who instanceof Response) return who;
  const orderId = crypto.randomUUID();
  const now = new Date().toISOString();

  // Re-checked inside the SQL (not just from the read above) so two kassas
  // voiding the same line at once can't over-void it.
  const voidable = `EXISTS (SELECT 1 FROM tabs WHERE id = ? AND org_id = ? AND status = 'open')
    AND NOT EXISTS (SELECT 1 FROM charges WHERE tab_id = ? AND status = 'pending')
    AND (SELECT l.quantity + COALESCE((SELECT SUM(v.quantity) FROM order_lines v WHERE v.voids_line_id = l.id), 0) - ${PAID_UNITS_SQL('l.id')}
         FROM order_lines l WHERE l.id = ?) >= ?
    AND (SELECT COALESCE(SUM(unit_price_cents * quantity), 0) FROM order_lines WHERE tab_id = ?)
        - ? * (SELECT unit_price_cents FROM order_lines WHERE id = ?)
        >= (SELECT COALESCE(SUM(amount_cents - tip_cents), 0) FROM charges WHERE tab_id = ? AND status = 'succeeded')`;

  const [orderResult] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO orders (id, org_id, tab_id, source, device_id, device_name, user_name, user_email, submitted_at, staff_id, staff_name)
       SELECT ?, ?, ?, 'kassa', ?, ?, ?, ?, ?, ?, ? WHERE ${voidable}`
    ).bind(orderId, orgId, tabId, who.deviceId, who.deviceName, who.userName, who.userEmail, now, who.staffId ?? null, who.staffName ?? null, tabId, orgId, tabId, lineId, quantity, tabId, quantity, lineId, tabId),
    env.DB.prepare(
      `INSERT INTO order_lines (id, org_id, tab_id, order_id, item_code, variant_id, name, unit_price_cents, quantity, category, vat_rate_bp,
         prep_station_id, prep_station_name, voids_line_id, void_reason, created_at)
       SELECT ?, org_id, tab_id, ?, item_code, variant_id, name, unit_price_cents, ?, category, vat_rate_bp, prep_station_id, prep_station_name, id, ?, ?
       FROM order_lines WHERE id = ? AND EXISTS (SELECT 1 FROM orders WHERE id = ?)`
    ).bind(crypto.randomUUID(), orderId, -quantity, reason, now, lineId, orderId),
  ]);

  if ((orderResult.meta.changes || 0) === 0) {
    // Part of the tab is already paid (split payments) and this void would
    // take the total below that: a refund, which doesn't exist yet.
    const tab = await loadTabSummary(env, orgId, tabId);
    if (tab && tab.status === 'open' && !tab.paymentPending && tab.paidCents > 0 && quantity <= original.remaining) {
      const paidUnits = await env.DB.prepare(`SELECT ${PAID_UNITS_SQL('?')} AS n`).bind(lineId).first<{ n: number }>();
      if ((paidUnits?.n || 0) > 0 && quantity > original.remaining - (paidUnits?.n || 0)) {
        return errorJson('void_units_paid', 409, { tab });
      }
      return errorJson('void_exceeds_outstanding', 409, { tab });
    }
    return refusalResponse(env, orgId, tabId);
  }
  notifyTabChanged(env, orgId, tabId);
  return json(await loadTabDetail(env, orgId, tabId), 201);
}

// POST /organizations/:orgId/tabs/:tabId/split { parts: 2..50 | null } —
// "Gelijk verdelen": split what's open now over `parts` payments (null
// stops splitting). Starting again restarts the count from what's open
// then. Only while open with something left and no payment in flight.
async function setSplit(request: Request, env: Env, orgId: string, tabId: string): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { parts?: unknown };
  const parts = body.parts === null ? null : Number(body.parts);
  if (parts !== null && (!Number.isInteger(parts) || parts < 2 || parts > 50)) return json({ error: 'parts must be an integer 2–50, or null' }, 400);

  const result = await env.DB.prepare(
    `UPDATE tabs SET split_parts = ?, split_paid = 0
     WHERE id = ? AND org_id = ? AND status = 'open' AND NOT ${PENDING_SQL} AND (? IS NULL OR ${TOTAL_SQL} - ${PAID_SQL} >= ?)`
  )
    .bind(parts, tabId, orgId, parts, parts ?? 0)
    .run();
  if ((result.meta.changes || 0) === 0) {
    const tab = await loadTabSummary(env, orgId, tabId);
    if (tab && tab.status === 'open' && !tab.paymentPending) return errorJson('split_too_small', 409, { tab });
    return refusalResponse(env, orgId, tabId);
  }
  notifyTabChanged(env, orgId, tabId);
  return json(await loadTabDetail(env, orgId, tabId));
}

// POST /organizations/:orgId/tabs/:tabId/cancel { reason?, voidAll? } — only
// for a tab with nothing left on it (net total 0 — never ordered from, or
// every line voided) and no payment, pending or succeeded.
// `voidAll` ("Ticket annuleren", 2026-10-18): first voids every line still
// on it, with the reason (required then) — one correction order, as if each
// line was voided by hand; nothing is deleted (DOMAIN_MODEL.md "Append-only
// records"). All in one batch: the voids and the cancel together, or neither.
async function cancelTab(request: Request, env: Env, orgId: string, tabId: string): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { reason?: unknown; voidAll?: unknown };
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 200) : null;
  const now = new Date().toISOString();
  const cancel = env.DB.prepare(
    `UPDATE tabs SET status = 'cancelled', closed_at = ?, cancel_reason = ?
     WHERE id = ? AND org_id = ? AND status = 'open' AND ${TOTAL_SQL} = 0
       AND NOT EXISTS (SELECT 1 FROM charges WHERE tab_id = tabs.id AND status IN ('pending', 'succeeded'))`
  ).bind(now, reason || null, tabId, orgId);

  let result: D1Result;
  if (body.voidAll === true) {
    if (!reason) return json({ error: 'reason is required' }, 400);
    const who = await attribution(request, env, orgId, body as Record<string, unknown>);
    if (who instanceof Response) return who;
    const orderId = crypto.randomUUID();
    const remaining = (line: string) => `${line}.quantity + COALESCE((SELECT SUM(v.quantity) FROM order_lines v WHERE v.voids_line_id = ${line}.id), 0)`;
    const results = await env.DB.batch([
      // The correction order — only for an open tab with nothing paid or being paid, and something left to void.
      env.DB.prepare(
        `INSERT INTO orders (id, org_id, tab_id, source, device_id, device_name, user_name, user_email, submitted_at, staff_id, staff_name)
         SELECT ?, ?, ?, 'kassa', ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM tabs WHERE id = ? AND org_id = ? AND status = 'open')
           AND NOT EXISTS (SELECT 1 FROM charges WHERE tab_id = ? AND status IN ('pending', 'succeeded'))
           AND EXISTS (SELECT 1 FROM order_lines l WHERE l.tab_id = ? AND l.voids_line_id IS NULL AND ${remaining('l')} > 0)`
      ).bind(orderId, orgId, tabId, who.deviceId, who.deviceName, who.userName, who.userEmail, now, who.staffId ?? null, who.staffName ?? null, tabId, orgId, tabId, tabId),
      // A void for what's left of every line.
      env.DB.prepare(
        `INSERT INTO order_lines (id, org_id, tab_id, order_id, item_code, variant_id, name, unit_price_cents, quantity, category, vat_rate_bp,
           prep_station_id, prep_station_name, voids_line_id, void_reason, created_at)
         SELECT lower(hex(randomblob(16))), l.org_id, l.tab_id, ?, l.item_code, l.variant_id, l.name, l.unit_price_cents, -(${remaining('l')}), l.category, l.vat_rate_bp,
           l.prep_station_id, l.prep_station_name, l.id, ?, ?
         FROM order_lines l WHERE l.tab_id = ? AND l.voids_line_id IS NULL AND ${remaining('l')} > 0 AND EXISTS (SELECT 1 FROM orders WHERE id = ?)`
      ).bind(orderId, reason, now, tabId, orderId),
      // Then, in the same batch, the cancel (its total is 0 now).
      cancel,
    ]);
    result = results[2];
  } else {
    result = await cancel.run();
  }

  if ((result.meta.changes || 0) === 0) {
    const tab = await loadTabSummary(env, orgId, tabId);
    if (tab && tab.status === 'open' && !tab.paymentPending) {
      return errorJson('tab_not_empty', 409, { tab });
    }
    return refusalResponse(env, orgId, tabId);
  }
  notifyTabChanged(env, orgId, tabId);
  return json(await loadTabDetail(env, orgId, tabId));
}

// Handles /organizations/:orgId/tabs[/...]. Returns null for anything it
// doesn't recognize.
export async function dispatchTabsRoute(request: Request, env: Env, pathname: string): Promise<Response | null> {
  const match = pathname.match(/^\/organizations\/([^/]+)\/tabs(?:\/([^/]+))?(?:\/(orders|cancel|split|lines\/([^/]+)\/void))?$/);
  if (!match) return null;
  const [, orgId, tabId, action, lineId] = match;

  const refusal = await authorize(request, env, orgId);
  if (refusal) return refusal;

  if (!tabId) {
    if (request.method === 'GET') return listTabs(request, env, orgId);
    if (request.method === 'POST') return createTab(request, env, orgId);
    return null;
  }
  if (!action) {
    if (request.method === 'GET') return getTab(env, orgId, tabId);
    if (request.method === 'PATCH') return renameTab(request, env, orgId, tabId);
    return null;
  }
  if (request.method !== 'POST') return null;
  if (action === 'orders') return addOrder(request, env, orgId, tabId);
  if (action === 'cancel') return cancelTab(request, env, orgId, tabId);
  if (action === 'split') return setSplit(request, env, orgId, tabId);
  if (lineId) return voidLine(request, env, orgId, tabId, lineId);
  return null;
}

// --- Payment integration (called from payments/bancontact.ts, payments/sumup.ts, payments/charges.ts) ---

export interface TabChargeContext {
  // Per item: the units this payment covers (empty otherwise).
  lines: { lineId: string; quantity: number }[];
  // The part this payment would be of the tab's "Gelijk verdelen" plan
  // (next unpaid, 1-based), 0 without a plan.
  splitPart: number;
  // The legacy `items` JSON (bon/fietstocht/.../fooi) derived from the tab's
  // net lines — what transactions.items and every report built on it still
  // expect until reports move to order_lines. Derived here, not taken from
  // the client, so it always matches what's actually on the tab.
  items: Record<string, number>;
  description: string;
}

// Pre-check before creating a charge for a tab: caller is a member, tab is
// open, nothing else is in flight for it, and the amount (minus tip) is
// exactly what the kassa means to pay: all that's outstanding, the next
// split part, or — deliberately — any part of it. The pending-charge part is re-enforced atomically by
// idx_charges_one_pending_per_tab at insert time — this check just avoids
// creating a provider-side payment (Bancontact) that's doomed to lose that
// race in the common case.
export async function prepareTabCharge(
  request: Request,
  env: Env,
  orgId: string,
  tabId: string,
  amountCents: number,
  tipCents = 0,
  // What the kassa means to pay — checked exactly, so a kassa with a stale
  // view (a line added elsewhere, a split changed) gets a 409 instead of
  // silently paying the wrong amount: the whole tab (default), the next
  // part of its split, or deliberately any part of it.
  intent: { splitPart?: boolean; partial?: boolean; lines?: unknown } = {}
): Promise<{ ok: true; context: TabChargeContext } | { ok: false; response: Response }> {
  const refusal = await authorize(request, env, orgId);
  if (refusal) return { ok: false, response: refusal };
  return prepareTabChargeFor(env, orgId, tabId, amountCents, tipCents, intent);
}

// What's still open on a tab (null: no such tab, or not open) — for a guest
// paying their own self-order (self-order.ts), who pays exactly that.
export async function openAmount(env: Env, orgId: string, tabId: string): Promise<number | null> {
  const tab = await loadTabSummary(env, orgId, tabId);
  return tab && tab.status === 'open' ? tab.outstandingCents : null;
}

// prepareTabCharge's checks without the membership check — for a guest's own
// self-order (self-order.ts), whose order token was the authorization.
export async function prepareTabChargeFor(
  env: Env,
  orgId: string,
  tabId: string,
  amountCents: number,
  tipCents = 0,
  intent: { splitPart?: boolean; partial?: boolean; lines?: unknown } = {}
): Promise<{ ok: true; context: TabChargeContext } | { ok: false; response: Response }> {
  const tab = await loadTabSummary(env, orgId, tabId);
  if (!tab) return { ok: false, response: errorJson('tab_not_found', 404) };
  if (tab.status !== 'open') return { ok: false, response: errorJson('tab_not_open', 409, { tab }) };
  if (tab.paymentPending) return { ok: false, response: errorJson('tab_payment_already_pending', 409, { tab }) };
  if (tab.outstandingCents < 1) return { ok: false, response: errorJson('tab_nothing_to_pay', 409, { tab }) };
  // amount − tip is what pays off the tab.
  const paysCents = amountCents - tipCents;

  // Per item: exactly these units of these lines, none paid yet.
  let itemLines: { lineId: string; quantity: number }[] = [];
  if (intent.lines !== undefined) {
    const picked = await checkItemLines(env, tabId, intent.lines);
    if (typeof picked === 'string' || 'code' in picked) return { ok: false, response: json({ ...errorBody(picked), tab }, typeof picked === 'string' ? 400 : 409) };
    if (picked.cents !== paysCents) return { ok: false, response: errorJson('tab_changed', 409, { tab }) };
    itemLines = picked.lines;
  }

  const expected = intent.lines !== undefined
    ? paysCents >= 1 && paysCents <= tab.outstandingCents
    : intent.splitPart
    ? paysCents === tab.split?.nextCents
    : intent.partial
      ? paysCents >= 1 && paysCents <= tab.outstandingCents
      : paysCents === tab.outstandingCents;
  if (!expected) {
    return { ok: false, response: errorJson('tab_changed', 409, { tab }) };
  }
  const settlesTab = paysCents === tab.outstandingCents;

  const { results } = await env.DB.prepare(
    `SELECT item_code, SUM(quantity) AS quantity, SUM(unit_price_cents * quantity) AS amount_cents
     FROM order_lines WHERE tab_id = ? AND item_code IS NOT NULL GROUP BY item_code`
  )
    .bind(tabId)
    .all<{ item_code: string; quantity: number; amount_cents: number }>();

  const items: Record<string, number> = {};
  for (const row of results || []) {
    // Legacy shape: every item is a count, except fooi, which is an amount in cents.
    const value = row.item_code === 'fooi' ? row.amount_cents : row.quantity;
    if (value > 0) items[row.item_code] = value;
  }

  const description = tab.label ? `Rekening #${tab.number} ${tab.label}` : `Rekening #${tab.number}`;
  return {
    ok: true,
    // The legacy items JSON only on the payment that settles the tab — a
    // partial payment carrying all items would count them twice.
    context: {
      ...(settlesTab ? { items, description } : { items: {}, description: `${description} (deel)` }),
      splitPart: tab.split ? tab.split.paid + 1 : 0,
      lines: itemLines,
    },
  };
}

// Validates an item selection [{ lineId, quantity }] against the tab: each
// an original (non-void) line of this tab, quantity ≥ 1 and at most its
// units not voided and not paid yet. Returns the lines and what they cost,
// or an error (a 400 for malformed input, a 409 — stale view — otherwise).
async function checkItemLines(env: Env, tabId: string, raw: unknown): Promise<{ lines: { lineId: string; quantity: number }[]; cents: number } | string | CodedError> {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 200) return 'lines must be a non-empty array of { lineId, quantity }';
  const wanted = new Map<string, number>();
  for (const item of raw as { lineId?: unknown; quantity?: unknown }[]) {
    if (typeof item?.lineId !== 'string' || !Number.isInteger(item.quantity) || (item.quantity as number) < 1) return 'lines must be a non-empty array of { lineId, quantity }';
    wanted.set(item.lineId, (wanted.get(item.lineId) || 0) + (item.quantity as number));
  }
  const { results } = await env.DB.prepare(
    `SELECT l.id, l.unit_price_cents,
       l.quantity + COALESCE((SELECT SUM(v.quantity) FROM order_lines v WHERE v.voids_line_id = l.id), 0) - ${PAID_UNITS_SQL('l.id')} AS payable
     FROM order_lines l WHERE l.tab_id = ? AND l.voids_line_id IS NULL`
  )
    .bind(tabId)
    .all<{ id: string; unit_price_cents: number; payable: number }>();
  const byId = new Map((results || []).map((r) => [r.id, r]));
  let cents = 0;
  for (const [lineId, quantity] of wanted) {
    const line = byId.get(lineId);
    if (!line || quantity > line.payable) return codedError('tab_changed');
    cents += quantity * line.unit_price_cents;
  }
  return { lines: [...wanted].map(([lineId, quantity]) => ({ lineId, quantity })), cents };
}

export function isPendingTabChargeConflict(err: unknown): boolean {
  return /UNIQUE constraint failed: charges\.tab_id/i.test((err as Error)?.message || '');
}

// Called once a tab's charge succeeds (from resolveCharge). Closes the tab
// if it's now fully paid, assigning the next gapless receipt number in the
// same transaction: the counter only moves if the close itself happens, so
// no receipt number is ever skipped. The paid >= total check lives inside
// the SQL too, not just in a read beforehand. Idempotent — a second call on
// an already-closed tab changes nothing.
export async function settleTab(env: Env, tabId: string, splitPart = false): Promise<void> {
  const closable = `status = 'open' AND ${PAID_SQL} >= ${TOTAL_SQL}`;
  const tab = await env.DB.prepare('SELECT org_id FROM tabs WHERE id = ?').bind(tabId).first<{ org_id: string }>();
  if (!tab) return;

  await env.DB.batch([
    // One more part of a "Gelijk verdelen" plan paid (the charge is only
    // resolved once — resolveCharge's pending → succeeded — so this can't double count).
    ...(splitPart ? [env.DB.prepare(`UPDATE tabs SET split_paid = split_paid + 1 WHERE id = ? AND split_parts IS NOT NULL`).bind(tabId)] : []),
    env.DB.prepare(`INSERT OR IGNORE INTO org_counters (org_id, name, value) VALUES (?, 'receipt', 0)`).bind(tab.org_id),
    env.DB.prepare(
      `UPDATE org_counters SET value = value + 1
       WHERE org_id = ? AND name = 'receipt' AND EXISTS (SELECT 1 FROM tabs WHERE id = ? AND ${closable})`
    ).bind(tab.org_id, tabId),
    env.DB.prepare(
      `UPDATE tabs SET status = 'closed', closed_at = ?,
         receipt_number = (SELECT value FROM org_counters WHERE org_id = tabs.org_id AND name = 'receipt')
       WHERE id = ? AND ${closable}`
    ).bind(new Date().toISOString(), tabId),
  ]);
}
