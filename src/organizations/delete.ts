// Deleting an organization (console, Instellingen → Gegevens):
//
//   DELETE /organizations/:orgId  (admin) { confirm: <org name> } → { done }
//
// Every row of it goes: every table with an org_id, read from the live
// schema (a table added later goes too), children first (D1 enforces
// foreign keys), then its memberships and the org itself, then its devices
// at the devicehub. That's more tables than one request may touch on
// Workers Free (50 queries), so it goes in steps: each call deletes what it
// can and says whether it is done; the console calls again until it is.
//
// A backup link goes first: from then on the sync triggers neither record
// (a box) nor guard (a backup on the cloud) this org's rows. The other side
// keeps its copy; a box still sending to a deleted backup is refused.
import type { Env } from '../env';
import { json } from '../http';
import { errorJson } from '../errors';
import { callDeviceHub } from '../devicehub-client';
import { extractCaller, requireOrgRole } from './auth';
import { syncAddresses } from './client-access';

// Tables per step: with the other queries of a step, well under 50.
export const DELETE_STEP_TABLES = 36;

const INTERNAL = /^(sqlite_|_cf_|d1_migrations$)/;

// Tables with an org_id, children first; memberships left out (they carry
// the admin check: last, with the org), sync_links up front.
export function deletionOrder(tables: { name: string; sql: string }[]): string[] {
  const refs = new Map<string, Set<string>>();
  const scoped = new Set<string>();
  for (const t of tables) {
    if (INTERNAL.test(t.name) || t.name === 'organizations') continue;
    refs.set(t.name, new Set([...t.sql.matchAll(/REFERENCES\s+["`[]?(\w+)/gi)].map((m) => m[1]).filter((x) => x !== t.name)));
    if (/\borg_id\b/.test(t.sql)) scoped.add(t.name);
  }
  for (const [name, targets] of refs) {
    if (!scoped.has(name) && [...targets].some((x) => x === 'organizations' || scoped.has(x))) throw new Error(`table ${name} references organization data but has no org_id`);
  }
  const order: string[] = [];
  const left = new Set(scoped);
  while (left.size) {
    const next = [...left].filter((t) => ![...left].some((other) => other !== t && refs.get(other)?.has(t))).sort();
    if (!next.length) throw new Error(`reference cycle among ${[...left].join(', ')}`);
    for (const t of next) {
      order.push(t);
      left.delete(t);
    }
  }
  const rest = order.filter((t) => t !== 'memberships' && t !== 'sync_links');
  return scoped.has('sync_links') ? ['sync_links', ...rest] : rest;
}

export async function deleteOrganization(request: Request, env: Env, orgId: string): Promise<Response> {
  const caller = extractCaller(request);
  if (!caller) return json({ error: 'Unauthorized' }, 401);
  if (!(await requireOrgRole(env, orgId, caller, ['admin']))) return json({ error: 'Forbidden' }, 403);
  const body = (await request.json().catch(() => ({}))) as { confirm?: unknown };
  const org = await env.DB.prepare('SELECT name FROM organizations WHERE id = ?').bind(orgId).first<{ name: string }>();
  if (!org) return errorJson('org_not_found', 404);
  if (typeof body.confirm !== 'string' || body.confirm.trim() !== org.name.trim()) return errorJson('org_confirm_name', 400);

  const { results: tables } = await env.DB.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table'").all<{ name: string; sql: string }>();
  const order = deletionOrder(tables || []);
  // Which still have rows of this org: one query (?1 used for each).
  const filled = await env.DB.prepare(`SELECT ${order.map((t, i) => `EXISTS (SELECT 1 FROM "${t}" WHERE org_id = ?1) AS t${i}`).join(', ')}`)
    .bind(orgId)
    .first<Record<string, number>>();
  const step = order.filter((_, i) => filled?.[`t${i}`]).slice(0, DELETE_STEP_TABLES);
  if (step.length) {
    await env.DB.batch(step.map((t) => env.DB.prepare(`DELETE FROM "${t}" WHERE org_id = ?`).bind(orgId)));
    return json({ done: false });
  }

  // The last step: who had access, then them and the org itself.
  const { results: members } = await env.DB.prepare('SELECT invited_email FROM memberships WHERE org_id = ?').bind(orgId).all<{ invited_email: string }>();
  await env.DB.batch([env.DB.prepare('DELETE FROM memberships WHERE org_id = ?').bind(orgId), env.DB.prepare('DELETE FROM organizations WHERE id = ?').bind(orgId)]);
  // Who only came with this org is no longer let in by the login provider.
  await syncAddresses(env, (members || []).map((m) => m.invited_email));
  // Its devices (the devicehub's database); a failure leaves orphans, not a broken org.
  try {
    await callDeviceHub(env, `/devices/by-org/${encodeURIComponent(orgId)}`, { method: 'DELETE' });
  } catch (err) {
    console.error('devicehub: could not remove the devices of a deleted org', orgId, (err as Error).message);
  }
  return json({ done: true });
}
