// Sales report (step 3d) — GET /organizations/:orgId/reports/sales?from=&to=
// (admin only; from inclusive, to exclusive, ISO timestamps — the console
// computes local-day bounds).
//
//   sales     — net order lines (voids subtracted) of tabs *closed* in the
//               range, per product / category / VAT rate. Revenue never
//               includes tips. Uses the name/price/category/VAT copied into
//               each line at sale time, so later catalog edits don't rewrite
//               history.
//   payments  — every recorded payment (transactions) in the range, per
//               method, with tips — what should be in the till / on the
//               account, legacy sales included.
//   legacy    — payments from before tabs existed (no tab_id): only their
//               old items JSON is known, summed per key.
//   openTabs  — currently open tabs, regardless of range (not revenue yet).
import type { Env } from './env';
import { json } from './http';
import { extractCaller, requireOrgRole } from './organizations/auth';

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function parseInstant(raw: string | null): string | null {
  if (!raw || !ISO_RE.test(raw)) return null;
  const t = Date.parse(raw);
  // Stored timestamps are toISOString() output, so compare in that same form.
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

// VAT is included in the price: vat = gross × rate / (1 + rate).
function vatIncluded(grossCents: number, rateBp: number | null): number {
  return rateBp ? Math.round((grossCents * rateBp) / (10000 + rateBp)) : 0;
}

const CLOSED_IN_RANGE = `JOIN tabs t ON t.id = l.tab_id WHERE t.org_id = ? AND t.status = 'closed' AND t.closed_at >= ? AND t.closed_at < ?`;

async function salesReport(request: Request, env: Env, orgId: string): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const from = parseInstant(params.get('from'));
  const to = parseInstant(params.get('to'));
  if (!from || !to || from >= to) return json({ error: 'from and to must be ISO timestamps with from < to' }, 400);

  const range = [orgId, from, to];
  const [tabCount, byProduct, byCategory, byVat, payments, legacy, openTabs] = await env.DB.batch([
    env.DB.prepare(`SELECT COUNT(*) AS n FROM tabs WHERE org_id = ? AND status = 'closed' AND closed_at >= ? AND closed_at < ?`).bind(...range),
    env.DB.prepare(
      `SELECT l.name, l.category, SUM(l.quantity) AS quantity, SUM(l.unit_price_cents * l.quantity) AS revenue
       FROM order_lines l ${CLOSED_IN_RANGE}
       GROUP BY l.name, l.category HAVING SUM(l.quantity) != 0 OR SUM(l.unit_price_cents * l.quantity) != 0
       ORDER BY revenue DESC, l.name`
    ).bind(...range),
    env.DB.prepare(
      `SELECT l.category, SUM(l.quantity) AS quantity, SUM(l.unit_price_cents * l.quantity) AS revenue
       FROM order_lines l ${CLOSED_IN_RANGE}
       GROUP BY l.category HAVING SUM(l.quantity) != 0 OR SUM(l.unit_price_cents * l.quantity) != 0
       ORDER BY revenue DESC`
    ).bind(...range),
    env.DB.prepare(
      `SELECT l.vat_rate_bp, SUM(l.unit_price_cents * l.quantity) AS revenue
       FROM order_lines l ${CLOSED_IN_RANGE}
       GROUP BY l.vat_rate_bp HAVING SUM(l.unit_price_cents * l.quantity) != 0
       ORDER BY revenue DESC`
    ).bind(...range),
    env.DB.prepare(
      `SELECT method, COUNT(*) AS count, SUM(amount_cents) AS amount, SUM(tip_cents) AS tip
       FROM transactions WHERE org_id = ? AND completed_at >= ? AND completed_at < ?
       GROUP BY method ORDER BY amount DESC`
    ).bind(...range),
    env.DB.prepare(`SELECT amount_cents, items FROM transactions WHERE org_id = ? AND completed_at >= ? AND completed_at < ? AND tab_id IS NULL`).bind(...range),
    env.DB.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(
         (SELECT COALESCE(SUM(unit_price_cents * quantity), 0) FROM order_lines WHERE tab_id = tabs.id)
         - (SELECT COALESCE(SUM(amount_cents - tip_cents), 0) FROM charges WHERE tab_id = tabs.id AND status = 'succeeded')
       ), 0) AS outstanding
       FROM tabs WHERE org_id = ? AND status = 'open'`
    ).bind(orgId),
  ]);

  type ProductRow = { name: string; category: string | null; quantity: number; revenue: number };
  type CategoryRow = { category: string | null; quantity: number; revenue: number };
  type VatRow = { vat_rate_bp: number | null; revenue: number };
  type MethodRow = { method: string; count: number; amount: number; tip: number };

  const productRows = (byProduct.results || []) as ProductRow[];
  const methodRows = (payments.results || []) as MethodRow[];

  const legacyRows = (legacy.results || []) as { amount_cents: number; items: string | null }[];
  const legacyItems: Record<string, number> = {};
  for (const row of legacyRows) {
    let items: Record<string, unknown> = {};
    try {
      items = row.items ? JSON.parse(row.items) : {};
    } catch {
      // Unreadable legacy JSON: the amount still counts, the items don't.
    }
    for (const [key, value] of Object.entries(items)) {
      if (typeof value === 'number' && Number.isFinite(value)) legacyItems[key] = (legacyItems[key] || 0) + value;
    }
  }

  const open = (openTabs.results?.[0] || { n: 0, outstanding: 0 }) as { n: number; outstanding: number };

  return json({
    from,
    to,
    payments: {
      count: methodRows.reduce((s, r) => s + r.count, 0),
      amountCents: methodRows.reduce((s, r) => s + r.amount, 0),
      tipCents: methodRows.reduce((s, r) => s + r.tip, 0),
      byMethod: methodRows.map((r) => ({ method: r.method, count: r.count, amountCents: r.amount, tipCents: r.tip })),
    },
    sales: {
      tabCount: (tabCount.results?.[0] as { n: number } | undefined)?.n ?? 0,
      revenueCents: productRows.reduce((s, r) => s + r.revenue, 0),
      byProduct: productRows.map((r) => ({ name: r.name, category: r.category, quantity: r.quantity, revenueCents: r.revenue })),
      byCategory: ((byCategory.results || []) as CategoryRow[]).map((r) => ({ category: r.category, quantity: r.quantity, revenueCents: r.revenue })),
      byVat: ((byVat.results || []) as VatRow[]).map((r) => ({ vatRateBp: r.vat_rate_bp, revenueCents: r.revenue, vatCents: vatIncluded(r.revenue, r.vat_rate_bp) })),
    },
    legacy: {
      count: legacyRows.length,
      amountCents: legacyRows.reduce((s, r) => s + r.amount_cents, 0),
      items: legacyItems,
    },
    openTabs: { count: open.n, outstandingCents: open.outstanding },
  });
}

// Handles /organizations/:orgId/reports/*. Returns null for anything else.
export async function dispatchReportsRoute(request: Request, env: Env, pathname: string): Promise<Response | null> {
  const match = pathname.match(/^\/organizations\/([^/]+)\/reports\/sales$/);
  if (!match || request.method !== 'GET') return null;
  const orgId = match[1];

  const caller = extractCaller(request);
  if (!caller) return json({ error: 'Unauthorized' }, 401);
  if (!(await requireOrgRole(env, orgId, caller, ['admin']))) return json({ error: 'Forbidden' }, 403);
  return salesReport(request, env, orgId);
}
