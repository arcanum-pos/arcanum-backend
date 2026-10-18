// The customer display while the order is being entered (2026-10-18): the
// customer sees what the cashier taps in — and says whether it's right —
// before the cashier asks for the payment. The kassa sends the order on its
// screen whenever it changes (debounced); its customer display on another
// device gets an `order_shown` push (an event name, no data — devicehub
// never carries data) and fetches it. A display in a second window of the
// kassa itself gets it over the browser's own channel, not through here.
//
//   PUT /organizations/:org/devices/:pos/customer-view   member   { order: CustomerOrder | null, seq }
//   GET /organizations/:org/devices/:cfd/customer-view   member, or that display's own key
//                                                        → { order, seq } of the kassa it's linked to
//
// Kept only while the kassa has a display on another device; an older `seq`
// (the kassa's own counter) never replaces a newer one.
import type { Env } from './env';
import { broadcastPaymentEvent, callDeviceHub } from './devicehub-client';
import { deviceCaller } from './device-keys';
import { json } from './http';
import { extractCaller, requireOrgRole } from './organizations/auth';

const MAX_LINES = 300;

interface Line {
  name: string;
  quantity: number;
  unitPriceCents: number;
}

export interface CustomerViewOrder {
  label: string;
  number: number | null;
  eventName: string | null;
  paidCents: number;
  lines: Line[];
}

const text = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : '');
const int = (value: unknown, min: number, max: number) => (Number.isInteger(value) && (value as number) >= min && (value as number) <= max ? (value as number) : null);

// What the kassa sent, as far as it's an order: anything else left out.
export function readOrder(value: unknown): CustomerViewOrder | null {
  if (!value || typeof value !== 'object') return null;
  const o = value as Record<string, unknown>;
  const lines = (Array.isArray(o.lines) ? o.lines : []).slice(0, MAX_LINES).flatMap((l) => {
    const line = (l ?? {}) as Record<string, unknown>;
    const quantity = int(line.quantity, 1, 100_000);
    const unitPriceCents = int(line.unitPriceCents, -10_000_000, 10_000_000);
    return quantity !== null && unitPriceCents !== null ? [{ name: text(line.name, 120), quantity, unitPriceCents }] : [];
  });
  return {
    label: text(o.label, 80),
    number: int(o.number, 0, 1_000_000),
    eventName: text(o.eventName, 120) || null,
    paidCents: int(o.paidCents, 0, 100_000_000) ?? 0,
    lines,
  };
}

async function device(env: Env, terminalId: string): Promise<{ org_id: string | null; role: string; linked_to: string | null } | null> {
  const res = await callDeviceHub(env, `/devices/${encodeURIComponent(terminalId)}`, {});
  return res.ok ? ((await res.json()) as { org_id: string | null; role: string; linked_to: string | null }) : null;
}

async function member(request: Request, env: Env, orgId: string): Promise<boolean> {
  const caller = extractCaller(request);
  return !!caller && !!(await requireOrgRole(env, orgId, caller, ['admin', 'cashier']));
}

async function putView(request: Request, env: Env, orgId: string, posId: string): Promise<Response> {
  if (!extractCaller(request)) return json({ error: 'Unauthorized' }, 401);
  if (!(await member(request, env, orgId))) return json({ error: 'Forbidden' }, 403);
  const pos = await device(env, posId);
  if (!pos || pos.org_id !== orgId || pos.role !== 'pos') return json({ error: 'Not found' }, 404);
  const body = (await request.json().catch(() => null)) as { order?: unknown; seq?: unknown } | null;
  const seq = int(body?.seq, 0, Number.MAX_SAFE_INTEGER);
  if (seq === null) return json({ error: 'seq is required' }, 400);
  // A display on another device? (Its own second window gets it directly.)
  const linked = await callDeviceHub(env, `/devices/${encodeURIComponent(posId)}/linked?role=cfd`, {});
  const display = linked.ok ? ((await linked.json().catch(() => null)) as { terminal_id?: string } | null) : null;
  if (!display?.terminal_id || display.terminal_id === `display-of-${posId}`) return json({ shown: false });

  const order = readOrder(body?.order);
  const saved = await env.DB.prepare(
    `INSERT INTO customer_views (terminal_id, org_id, view, seq, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (terminal_id) DO UPDATE SET view = excluded.view, seq = excluded.seq, updated_at = excluded.updated_at WHERE excluded.seq > customer_views.seq`
  )
    .bind(posId, orgId, order ? JSON.stringify(order) : null, seq, new Date().toISOString())
    .run();
  if (saved.meta.changes) await broadcastPaymentEvent(env, posId, 'order_shown', {});
  return json({ shown: true });
}

async function getView(request: Request, env: Env, orgId: string, displayId: string): Promise<Response> {
  if (extractCaller(request)) {
    if (!(await member(request, env, orgId))) return json({ error: 'Forbidden' }, 403);
  } else {
    // A customer display with its own key: itself only.
    const self = await deviceCaller(request, env);
    if (!self) return json({ error: 'Unauthorized' }, 401);
    if (self.terminalId !== displayId || self.orgId !== orgId || self.role !== 'cfd') return json({ error: 'Forbidden' }, 403);
  }
  const display = await device(env, displayId);
  if (!display || display.org_id !== orgId || display.role !== 'cfd') return json({ error: 'Not found' }, 404);
  if (!display.linked_to) return json({ order: null, seq: 0 });
  const row = await env.DB.prepare('SELECT view, seq FROM customer_views WHERE terminal_id = ? AND org_id = ?').bind(display.linked_to, orgId).first<{ view: string | null; seq: number }>();
  return json({ order: row?.view ? JSON.parse(row.view) : null, seq: row?.seq ?? 0 });
}

export async function dispatchCustomerViewRoute(request: Request, env: Env, pathname: string): Promise<Response | null> {
  const match = pathname.match(/^\/organizations\/([^/]+)\/devices\/([^/]+)\/customer-view$/);
  if (!match) return null;
  const terminalId = decodeURIComponent(match[2]);
  if (request.method === 'PUT') return putView(request, env, match[1], terminalId);
  if (request.method === 'GET') return getView(request, env, match[1], terminalId);
  return null;
}
