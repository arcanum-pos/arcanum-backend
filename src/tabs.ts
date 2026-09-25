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
// A line with a `variantId` is priced by the server from the order's
// catalog entry (catalog.ts) — the kassa's own price/name are ignored — and
// name/price/code/category/VAT are copied in. Free lines without a variant
// (fooi, until it moves onto the payment in step 3d) still carry their own
// client-supplied price.
import type { Env } from './env';
import { json } from './http';
import { extractCaller, requireOrgRole } from './organizations/auth';
import { displayName } from './catalog';

type TabStatus = 'open' | 'closed' | 'cancelled';

interface TabRow {
  id: string;
  org_id: string;
  number: number;
  label: string;
  status: TabStatus;
  slot_id: string | null;
  event_id: string | null;
  opened_device_id: string | null;
  opened_device_name: string | null;
  opened_by_name: string | null;
  opened_by_email: string | null;
  opened_at: string;
  closed_at: string | null;
  receipt_number: number | null;
  cancel_reason: string | null;
}

interface TabSummaryRow extends TabRow {
  total_cents: number;
  paid_cents: number;
  payment_pending: number;
}

interface OrderRow {
  id: string;
  source: string;
  device_id: string | null;
  device_name: string | null;
  user_name: string | null;
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
  device_name: string | null;
  user_name: string | null;
  created_at: string;
  resolved_at: string | null;
}

// SQL fragments, all scoped to an outer `tabs` row.
const TOTAL_SQL = `(SELECT COALESCE(SUM(unit_price_cents * quantity), 0) FROM order_lines WHERE tab_id = tabs.id)`;
const PAID_SQL = `(SELECT COALESCE(SUM(amount_cents), 0) FROM charges WHERE tab_id = tabs.id AND status = 'succeeded')`;
const PENDING_SQL = `EXISTS (SELECT 1 FROM charges WHERE tab_id = tabs.id AND status = 'pending')`;

const SUMMARY_SELECT = `SELECT tabs.*, ${TOTAL_SQL} AS total_cents, ${PAID_SQL} AS paid_cents, ${PENDING_SQL} AS payment_pending FROM tabs`;

function rowToTabSummary(row: TabSummaryRow) {
  return {
    id: row.id,
    number: row.number,
    label: row.label,
    status: row.status,
    slotId: row.slot_id,
    eventId: row.event_id,
    openedDeviceId: row.opened_device_id,
    openedDeviceName: row.opened_device_name,
    openedByName: row.opened_by_name,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    receiptNumber: row.receipt_number,
    cancelReason: row.cancel_reason,
    totalCents: row.total_cents,
    paidCents: row.paid_cents,
    outstandingCents: row.total_cents - row.paid_cents,
    paymentPending: !!row.payment_pending,
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
    note: row.note,
    voidsLineId: row.voids_line_id,
    voidReason: row.void_reason,
    createdAt: row.created_at,
  };
}

async function authorize(request: Request, env: Env, orgId: string): Promise<Response | null> {
  const caller = extractCaller(request);
  if (!caller) return json({ error: 'Unauthorized' }, 401);
  const membership = await requireOrgRole(env, orgId, caller, ['admin', 'cashier']);
  if (!membership) return json({ error: 'Forbidden' }, 403);
  return null;
}

// Who/where an order or tab came from — user from the BFF's session headers
// (never the body, a client could claim to be anyone), device from the body
// (the same per-browser device id/name every charge already carries).
function attribution(request: Request, body: { deviceId?: unknown; deviceName?: unknown }) {
  return {
    deviceId: body.deviceId ? String(body.deviceId).slice(0, 100) : null,
    deviceName: body.deviceName ? String(body.deviceName).slice(0, 100) : null,
    userName: request.headers.get('X-User-Name') || null,
    userEmail: request.headers.get('X-User-Email') || null,
  };
}

interface LineInput {
  itemCode: string | null;
  name: string;
  unitPriceCents: number;
  quantity: number;
  note: string | null;
  // Set for catalog lines; name/unitPriceCents/itemCode/category/vatRateBp
  // are then filled in from the catalog by priceCatalogLines.
  variantId: string | null;
  category: string | null;
  vatRateBp: number | null;
}

const MAX_LINES_PER_ORDER = 100;

function parseLines(raw: unknown): LineInput[] | string {
  if (!Array.isArray(raw) || raw.length === 0) return 'lines must be a non-empty array';
  if (raw.length > MAX_LINES_PER_ORDER) return `at most ${MAX_LINES_PER_ORDER} lines per order`;

  const lines: LineInput[] = [];
  for (const item of raw as Record<string, unknown>[]) {
    const quantity = Number(item?.quantity);
    const note = typeof item?.note === 'string' && item.note.trim() ? item.note.trim().slice(0, 200) : null;
    if (typeof item?.variantId === 'string' && item.variantId) {
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) return 'quantity must be an integer between 1 and 999';
      lines.push({ variantId: item.variantId, quantity, note, itemCode: null, name: '', unitPriceCents: 0, category: null, vatRateBp: null });
      continue;
    }

    const name = typeof item?.name === 'string' ? item.name.trim() : '';
    const unitPriceCents = Number(item?.unitPriceCents);
    if (!name || name.length > 100) return 'each line needs a name (max 100 characters)';
    if (!Number.isInteger(unitPriceCents) || unitPriceCents < 0 || unitPriceCents > 1_000_000) {
      return 'unitPriceCents must be an integer between 0 and 1000000';
    }
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) return 'quantity must be an integer between 1 and 999';
    lines.push({
      itemCode: typeof item.itemCode === 'string' && item.itemCode ? item.itemCode.slice(0, 40) : null,
      name,
      unitPriceCents,
      quantity,
      note,
      variantId: null,
      category: null,
      vatRateBp: null,
    });
  }
  return lines;
}

// Fills in catalog lines from the order's catalog: the entry must be on
// that (non-archived, same-org) catalog, visible, and its product/variant
// not archived — the same rule as the kassa view, so a kassa can only sell
// what it's shown.
async function priceCatalogLines(env: Env, orgId: string, catalogId: string | null, lines: LineInput[]): Promise<string | null> {
  const variantIds = [...new Set(lines.filter((l) => l.variantId).map((l) => l.variantId as string))];
  if (variantIds.length === 0) return null;
  if (!catalogId) return 'catalogId is required for lines with a variantId';

  const catalog = await env.DB.prepare('SELECT 1 FROM catalogs WHERE id = ? AND org_id = ? AND archived_at IS NULL').bind(catalogId, orgId).first();
  if (!catalog) return 'Onbekende of gearchiveerde menukaart';

  const { results } = await env.DB.prepare(
    `SELECT e.variant_id, e.price_cents, v.name AS variant_name, v.code, p.name AS product_name, p.vat_rate_bp, c.name AS category_name
     FROM catalog_entries e
     JOIN product_variants v ON v.id = e.variant_id
     JOIN products p ON p.id = v.product_id
     LEFT JOIN categories c ON c.id = p.category_id
     WHERE e.catalog_id = ? AND e.visible = 1 AND v.archived_at IS NULL AND p.archived_at IS NULL
       AND e.variant_id IN (${variantIds.map(() => '?').join(', ')})`
  )
    .bind(catalogId, ...variantIds)
    .all<{ variant_id: string; price_cents: number; variant_name: string; code: string | null; product_name: string; vat_rate_bp: number | null; category_name: string | null }>();

  const byVariant = new Map((results || []).map((r) => [r.variant_id, r]));
  for (const line of lines) {
    if (!line.variantId) continue;
    const entry = byVariant.get(line.variantId);
    if (!entry) return 'Dit product staat niet (meer) op de menukaart — herlaad de kassa';
    line.name = displayName(entry.product_name, entry.variant_name);
    line.unitPriceCents = entry.price_cents;
    line.itemCode = entry.code;
    line.category = entry.category_name;
    line.vatRateBp = entry.vat_rate_bp;
  }
  return null;
}

// parseLines + priceCatalogLines for an order body ({ lines, catalogId? }).
async function prepareOrderLines(env: Env, orgId: string, body: Record<string, unknown>): Promise<{ lines: LineInput[]; catalogId: string | null } | string> {
  const lines = parseLines(body.lines);
  if (typeof lines === 'string') return lines;
  const catalogId = typeof body.catalogId === 'string' && body.catalogId ? body.catalogId : null;
  const error = await priceCatalogLines(env, orgId, catalogId, lines);
  if (error) return error;
  return { lines, catalogId: lines.some((l) => l.variantId) ? catalogId : null };
}

// Every order_lines insert is conditional on its order row having been
// inserted in the same batch — so a refused order (tab not open, payment
// pending) leaves no orphan lines behind, all-or-nothing.
function lineInsertStatements(env: Env, orgId: string, tabId: string, orderId: string, lines: LineInput[], now: string): D1PreparedStatement[] {
  return lines.map((line) =>
    env.DB.prepare(
      `INSERT INTO order_lines (id, org_id, tab_id, order_id, item_code, variant_id, name, unit_price_cents, quantity, category, vat_rate_bp, note, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM orders WHERE id = ?)`
    ).bind(
      crypto.randomUUID(),
      orgId,
      tabId,
      orderId,
      line.itemCode,
      line.variantId,
      line.name,
      line.unitPriceCents,
      line.quantity,
      line.category,
      line.vatRateBp,
      line.note,
      now,
      orderId
    )
  );
}

async function loadTabSummary(env: Env, orgId: string, tabId: string) {
  const row = await env.DB.prepare(`${SUMMARY_SELECT} WHERE tabs.id = ? AND tabs.org_id = ?`).bind(tabId, orgId).first<TabSummaryRow>();
  return row ? rowToTabSummary(row) : null;
}

async function loadTabDetail(env: Env, orgId: string, tabId: string) {
  const tab = await loadTabSummary(env, orgId, tabId);
  if (!tab) return null;

  const [orders, lines, charges] = await env.DB.batch([
    env.DB.prepare('SELECT id, source, device_id, device_name, user_name, user_email, submitted_at FROM orders WHERE tab_id = ? ORDER BY submitted_at').bind(tabId),
    env.DB.prepare('SELECT * FROM order_lines WHERE tab_id = ? ORDER BY created_at, rowid').bind(tabId),
    env.DB.prepare(
      'SELECT id, method, status, amount_cents, device_name, user_name, created_at, resolved_at FROM charges WHERE tab_id = ? ORDER BY created_at'
    ).bind(tabId),
  ]);

  const lineRows = (lines.results || []) as LineRow[];
  // How much of each original line is already voided — so the kassa can
  // show "2 × Pils (1 geannuleerd)" and knows what's still voidable.
  const voided = new Map<string, number>();
  for (const l of lineRows) {
    if (l.voids_line_id) voided.set(l.voids_line_id, (voided.get(l.voids_line_id) || 0) - l.quantity);
  }

  return {
    ...tab,
    orders: ((orders.results || []) as OrderRow[]).map((o) => ({
      id: o.id,
      source: o.source,
      deviceId: o.device_id,
      deviceName: o.device_name,
      userName: o.user_name,
      submittedAt: o.submitted_at,
    })),
    lines: lineRows.map((l) => ({ ...rowToLine(l), voidedQuantity: voided.get(l.id) || 0 })),
    payments: ((charges.results || []) as TabChargeRow[]).map((c) => ({
      id: c.id,
      method: c.method,
      status: c.status,
      amountCents: c.amount_cents,
      deviceName: c.device_name,
      userName: c.user_name,
      createdAt: c.created_at,
      resolvedAt: c.resolved_at,
    })),
  };
}

// Distinguishes *why* a conditional write touched nothing, for a useful error.
async function refusalResponse(env: Env, orgId: string, tabId: string): Promise<Response> {
  const tab = await loadTabSummary(env, orgId, tabId);
  if (!tab) return json({ error: 'Rekening niet gevonden' }, 404);
  if (tab.status !== 'open') return json({ error: 'Rekening is niet meer open', tab }, 409);
  if (tab.paymentPending) return json({ error: 'Er loopt een betaling voor deze rekening', tab }, 409);
  return json({ error: 'Rekening is gewijzigd, herlaad en probeer opnieuw', tab }, 409);
}

// GET /organizations/:orgId/tabs?status=open|closed|cancelled
async function listTabs(request: Request, env: Env, orgId: string): Promise<Response> {
  const status = new URL(request.url).searchParams.get('status') || 'open';
  if (!['open', 'closed', 'cancelled'].includes(status)) return json({ error: 'status must be open, closed or cancelled' }, 400);

  const { results } = await env.DB.prepare(`${SUMMARY_SELECT} WHERE tabs.org_id = ? AND tabs.status = ? ORDER BY tabs.number DESC LIMIT 200`)
    .bind(orgId, status)
    .all<TabSummaryRow>();
  return json((results || []).map(rowToTabSummary));
}

// POST /organizations/:orgId/tabs { label?, slotId?, deviceId?, deviceName?, lines?, catalogId? }
// Optional `lines` submits a first order in the same batch — the Toog
// quick sale (open + order + pay) is then two round trips, not three.
async function createTab(request: Request, env: Env, orgId: string): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const label = typeof body.label === 'string' ? body.label.trim().slice(0, 60) : '';

  let lines: LineInput[] = [];
  let catalogId: string | null = null;
  if (body.lines !== undefined) {
    const prepared = await prepareOrderLines(env, orgId, body);
    if (typeof prepared === 'string') return json({ error: prepared }, 400);
    ({ lines, catalogId } = prepared);
  }

  const who = attribution(request, body);
  const tabId = crypto.randomUUID();
  const now = new Date().toISOString();

  const statements = [
    env.DB.prepare(`INSERT OR IGNORE INTO org_counters (org_id, name, value) VALUES (?, 'tab', 0)`).bind(orgId),
    env.DB.prepare(`UPDATE org_counters SET value = value + 1 WHERE org_id = ? AND name = 'tab'`).bind(orgId),
    env.DB.prepare(
      `INSERT INTO tabs (id, org_id, number, label, status, slot_id, opened_device_id, opened_device_name, opened_by_name, opened_by_email, opened_at)
       SELECT ?, ?, value, ?, 'open', ?, ?, ?, ?, ?, ? FROM org_counters WHERE org_id = ? AND name = 'tab'`
    ).bind(
      tabId,
      orgId,
      label,
      body.slotId ? String(body.slotId).slice(0, 100) : null,
      who.deviceId,
      who.deviceName,
      who.userName,
      who.userEmail,
      now,
      orgId
    ),
  ];

  if (lines.length > 0) {
    const orderId = crypto.randomUUID();
    statements.push(
      env.DB.prepare(
        `INSERT INTO orders (id, org_id, tab_id, source, catalog_id, device_id, device_name, user_name, user_email, submitted_at)
         VALUES (?, ?, ?, 'kassa', ?, ?, ?, ?, ?, ?)`
      ).bind(orderId, orgId, tabId, catalogId, who.deviceId, who.deviceName, who.userName, who.userEmail, now),
      ...lineInsertStatements(env, orgId, tabId, orderId, lines, now)
    );
  }

  await env.DB.batch(statements);
  return json(await loadTabDetail(env, orgId, tabId), 201);
}

// GET /organizations/:orgId/tabs/:tabId
async function getTab(env: Env, orgId: string, tabId: string): Promise<Response> {
  const tab = await loadTabDetail(env, orgId, tabId);
  return tab ? json(tab) : json({ error: 'Rekening niet gevonden' }, 404);
}

// PATCH /organizations/:orgId/tabs/:tabId { label } — only while open.
async function renameTab(request: Request, env: Env, orgId: string, tabId: string): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { label?: unknown };
  const label = typeof body.label === 'string' ? body.label.trim().slice(0, 60) : '';

  const result = await env.DB.prepare(`UPDATE tabs SET label = ? WHERE id = ? AND org_id = ? AND status = 'open'`).bind(label, tabId, orgId).run();
  if ((result.meta.changes || 0) === 0) return refusalResponse(env, orgId, tabId);
  return json(await loadTabDetail(env, orgId, tabId));
}

// POST /organizations/:orgId/tabs/:tabId/orders { lines, catalogId?, deviceId?, deviceName? }
async function addOrder(request: Request, env: Env, orgId: string, tabId: string): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const prepared = await prepareOrderLines(env, orgId, body);
  if (typeof prepared === 'string') return json({ error: prepared }, 400);
  const { lines, catalogId } = prepared;

  const who = attribution(request, body);
  const orderId = crypto.randomUUID();
  const now = new Date().toISOString();

  const [orderResult] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO orders (id, org_id, tab_id, source, catalog_id, device_id, device_name, user_name, user_email, submitted_at)
       SELECT ?, ?, ?, 'kassa', ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM tabs WHERE id = ? AND org_id = ? AND status = 'open')
         AND NOT EXISTS (SELECT 1 FROM charges WHERE tab_id = ? AND status = 'pending')`
    ).bind(orderId, orgId, tabId, catalogId, who.deviceId, who.deviceName, who.userName, who.userEmail, now, tabId, orgId, tabId),
    ...lineInsertStatements(env, orgId, tabId, orderId, lines, now),
  ]);

  if ((orderResult.meta.changes || 0) === 0) return refusalResponse(env, orgId, tabId);
  return json(await loadTabDetail(env, orgId, tabId), 201);
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
  if (!original) return json({ error: 'Lijn niet gevonden' }, 404);

  const quantity = body.quantity === undefined ? original.remaining : Number(body.quantity);
  if (!Number.isInteger(quantity) || quantity < 1) return json({ error: 'Niets meer te annuleren op deze lijn' }, 409);

  const who = attribution(request, body);
  const orderId = crypto.randomUUID();
  const now = new Date().toISOString();

  // Re-checked inside the SQL (not just from the read above) so two kassas
  // voiding the same line at once can't over-void it.
  const voidable = `EXISTS (SELECT 1 FROM tabs WHERE id = ? AND org_id = ? AND status = 'open')
    AND NOT EXISTS (SELECT 1 FROM charges WHERE tab_id = ? AND status = 'pending')
    AND (SELECT l.quantity + COALESCE((SELECT SUM(v.quantity) FROM order_lines v WHERE v.voids_line_id = l.id), 0)
         FROM order_lines l WHERE l.id = ?) >= ?`;

  const [orderResult] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO orders (id, org_id, tab_id, source, device_id, device_name, user_name, user_email, submitted_at)
       SELECT ?, ?, ?, 'kassa', ?, ?, ?, ?, ? WHERE ${voidable}`
    ).bind(orderId, orgId, tabId, who.deviceId, who.deviceName, who.userName, who.userEmail, now, tabId, orgId, tabId, lineId, quantity),
    env.DB.prepare(
      `INSERT INTO order_lines (id, org_id, tab_id, order_id, item_code, variant_id, name, unit_price_cents, quantity, category, vat_rate_bp, voids_line_id, void_reason, created_at)
       SELECT ?, org_id, tab_id, ?, item_code, variant_id, name, unit_price_cents, ?, category, vat_rate_bp, id, ?, ?
       FROM order_lines WHERE id = ? AND EXISTS (SELECT 1 FROM orders WHERE id = ?)`
    ).bind(crypto.randomUUID(), orderId, -quantity, reason, now, lineId, orderId),
  ]);

  if ((orderResult.meta.changes || 0) === 0) return refusalResponse(env, orgId, tabId);
  return json(await loadTabDetail(env, orgId, tabId), 201);
}

// POST /organizations/:orgId/tabs/:tabId/cancel { reason? } — only for a
// tab with nothing left on it (net total 0 — never ordered from, or every
// line voided) and no payment, pending or succeeded.
async function cancelTab(request: Request, env: Env, orgId: string, tabId: string): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { reason?: unknown };
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 200) : null;

  const result = await env.DB.prepare(
    `UPDATE tabs SET status = 'cancelled', closed_at = ?, cancel_reason = ?
     WHERE id = ? AND org_id = ? AND status = 'open' AND ${TOTAL_SQL} = 0
       AND NOT EXISTS (SELECT 1 FROM charges WHERE tab_id = tabs.id AND status IN ('pending', 'succeeded'))`
  )
    .bind(new Date().toISOString(), reason || null, tabId, orgId)
    .run();

  if ((result.meta.changes || 0) === 0) {
    const tab = await loadTabSummary(env, orgId, tabId);
    if (tab && tab.status === 'open' && !tab.paymentPending) {
      return json({ error: 'Alleen een lege rekening kan geannuleerd worden — annuleer eerst de lijnen', tab }, 409);
    }
    return refusalResponse(env, orgId, tabId);
  }
  return json(await loadTabDetail(env, orgId, tabId));
}

// Handles /organizations/:orgId/tabs[/...]. Returns null for anything it
// doesn't recognize.
export async function dispatchTabsRoute(request: Request, env: Env, pathname: string): Promise<Response | null> {
  const match = pathname.match(/^\/organizations\/([^/]+)\/tabs(?:\/([^/]+))?(?:\/(orders|cancel|lines\/([^/]+)\/void))?$/);
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
  if (lineId) return voidLine(request, env, orgId, tabId, lineId);
  return null;
}

// --- Payment integration (called from payments/bancontact.ts, payments/sumup.ts, payments/charges.ts) ---

export interface TabChargeContext {
  // The legacy `items` JSON (bon/fietstocht/.../fooi) derived from the tab's
  // net lines — what transactions.items and every report built on it still
  // expect until reports move to order_lines. Derived here, not taken from
  // the client, so it always matches what's actually on the tab.
  items: Record<string, number>;
  description: string;
}

// Pre-check before creating a charge for a tab: caller is a member, tab is
// open, nothing else is in flight for it, and the amount is exactly what's
// outstanding. The pending-charge part is re-enforced atomically by
// idx_charges_one_pending_per_tab at insert time — this check just avoids
// creating a provider-side payment (Bancontact) that's doomed to lose that
// race in the common case.
export async function prepareTabCharge(
  request: Request,
  env: Env,
  orgId: string,
  tabId: string,
  amountCents: number
): Promise<{ ok: true; context: TabChargeContext } | { ok: false; response: Response }> {
  const refusal = await authorize(request, env, orgId);
  if (refusal) return { ok: false, response: refusal };

  const tab = await loadTabSummary(env, orgId, tabId);
  if (!tab) return { ok: false, response: json({ error: 'Rekening niet gevonden' }, 404) };
  if (tab.status !== 'open') return { ok: false, response: json({ error: 'Rekening is niet meer open', tab }, 409) };
  if (tab.paymentPending) return { ok: false, response: json({ error: 'Er loopt al een betaling voor deze rekening', tab }, 409) };
  if (tab.outstandingCents < 1) return { ok: false, response: json({ error: 'Niets te betalen op deze rekening', tab }, 409) };
  if (amountCents !== tab.outstandingCents) {
    return { ok: false, response: json({ error: 'Rekening is gewijzigd, herlaad en probeer opnieuw', tab }, 409) };
  }

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

  return {
    ok: true,
    context: { items, description: tab.label ? `Rekening #${tab.number} ${tab.label}` : `Rekening #${tab.number}` },
  };
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
export async function settleTab(env: Env, tabId: string): Promise<void> {
  const closable = `status = 'open' AND ${PAID_SQL} >= ${TOTAL_SQL}`;
  const tab = await env.DB.prepare('SELECT org_id FROM tabs WHERE id = ?').bind(tabId).first<{ org_id: string }>();
  if (!tab) return;

  await env.DB.batch([
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
