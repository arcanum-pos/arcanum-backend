// Per-org events — first step only: name + date, and something
// transactions can be tagged with (see transactions.ts's new event_id
// column/param). Will later drive what a kassa shows (menu/catalogue) for
// a given event; not built yet.
import type { Env } from '../env';
import { json } from '../http';
import { extractCaller, requireOrgRole } from './auth';

export interface EventRow {
  id: string;
  org_id: string;
  name: string;
  event_date: string;
  created_at: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function rowToEvent(row: EventRow) {
  return { id: row.id, name: row.name, date: row.event_date, createdAt: row.created_at };
}

// Listing is open to any active member (a cashier should be able to see
// what events exist, same reasoning as listMembers) — only creating one is
// admin-only.
export async function listEvents(request: Request, env: Env, orgId: string): Promise<Response> {
  const caller = extractCaller(request);
  if (!caller) return json({ error: 'Unauthorized' }, 401);

  const membership = await requireOrgRole(env, orgId, caller, ['admin', 'cashier']);
  if (!membership) return json({ error: 'Forbidden' }, 403);

  const { results } = await env.DB.prepare('SELECT * FROM events WHERE org_id = ? ORDER BY event_date DESC').bind(orgId).all<EventRow>();
  return json((results || []).map(rowToEvent));
}

export async function createEvent(request: Request, env: Env, orgId: string): Promise<Response> {
  const caller = extractCaller(request);
  if (!caller) return json({ error: 'Unauthorized' }, 401);

  const membership = await requireOrgRole(env, orgId, caller, ['admin']);
  if (!membership) return json({ error: 'Forbidden' }, 403);

  const body = (await request.json().catch(() => ({}))) as { name?: string; date?: string };
  const name = (body.name || '').trim();
  const date = (body.date || '').trim();

  if (!name) return json({ error: 'name is required' }, 400);
  if (!DATE_RE.test(date)) return json({ error: 'date must be in YYYY-MM-DD format' }, 400);

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await env.DB.prepare('INSERT INTO events (id, org_id, name, event_date, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, orgId, name, date, now)
    .run();

  const row = await env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(id).first<EventRow>();
  return json(rowToEvent(row!), 201);
}
