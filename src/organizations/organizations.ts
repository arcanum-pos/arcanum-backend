import type { Env } from '../env';
import { json } from '../http';
import { extractCaller, requireOrgRole } from './auth';
import { reconcilePendingInvites } from './members';
import { generateDataKey, wrapDataKey, unwrapDataKey } from './crypto';
import type { OrganizationRow } from './types';

function rowToOrganization(row: OrganizationRow) {
  return {
    id: row.id,
    name: row.name,
    logoUrl: row.logo_url,
    theme: row.theme,
    createdAt: row.created_at,
  };
}

export async function createOrganization(request: Request, env: Env): Promise<Response> {
  const caller = extractCaller(request);
  if (!caller) return json({ error: 'Unauthorized' }, 401);

  const body = (await request.json().catch(() => ({}))) as { name?: string };
  const name = (body.name || '').trim();
  if (!name) return json({ error: 'name is required' }, 400);

  const dek = generateDataKey();
  const wrapped = await wrapDataKey(dek, env.ENCRYPTION_KEY);

  const orgId = crypto.randomUUID();
  const now = new Date().toISOString();

  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO organizations (id, name, logo_url, theme, dek_ciphertext, dek_iv, created_at, created_by_sub) VALUES (?, ?, NULL, NULL, ?, ?, ?, ?)'
    ).bind(orgId, name, wrapped.ciphertext, wrapped.iv, now, caller.sub),
    // Creator becomes the organization's first admin automatically — already
    // "active" (not "pending") since we already know their sub.
    env.DB.prepare(
      'INSERT INTO memberships (id, org_id, user_sub, issuer, invited_email, role, status, invited_at, accepted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(crypto.randomUUID(), orgId, caller.sub, caller.issuer, caller.email, 'admin', 'active', now, now),
  ]);

  const row = await env.DB.prepare('SELECT * FROM organizations WHERE id = ?').bind(orgId).first<OrganizationRow>();
  return json(rowToOrganization(row!), 201);
}

// The admin portal's landing list: organizations where the caller is an
// active admin. Also opportunistically reconciles any pending invites for
// their email first, so an invite accepted by simply logging in shows up
// immediately without a separate "accept" step.
export async function listMyOrganizations(request: Request, env: Env): Promise<Response> {
  const caller = extractCaller(request);
  if (!caller) return json({ error: 'Unauthorized' }, 401);

  await reconcilePendingInvites(env, caller.sub, caller.email, caller.issuer);

  const { results } = await env.DB.prepare(
    `SELECT o.* FROM organizations o
     JOIN memberships m ON m.org_id = o.id
     WHERE m.issuer = ? AND m.user_sub = ? AND m.role = 'admin' AND m.status = 'active'
     ORDER BY o.created_at`
  )
    .bind(caller.issuer, caller.sub)
    .all<OrganizationRow>();

  return json((results || []).map(rowToOrganization));
}

// All active memberships for the caller, any role — distinct from
// listMyOrganizations (admin-only, for the admin-portal landing page). Used
// by the device-registration flow: a cashier needs to know which org(s) to
// register a device under too, not just admins.
export async function listMyMemberships(request: Request, env: Env): Promise<Response> {
  const caller = extractCaller(request);
  if (!caller) return json({ error: 'Unauthorized' }, 401);

  await reconcilePendingInvites(env, caller.sub, caller.email, caller.issuer);

  const { results } = await env.DB.prepare(
    `SELECT o.id as org_id, o.name as org_name, m.role FROM organizations o
     JOIN memberships m ON m.org_id = o.id
     WHERE m.issuer = ? AND m.user_sub = ? AND m.status = 'active'
     ORDER BY o.created_at`
  )
    .bind(caller.issuer, caller.sub)
    .all<{ org_id: string; org_name: string; role: string }>();

  return json((results || []).map((r) => ({ orgId: r.org_id, orgName: r.org_name, role: r.role })));
}

export async function getOrganization(request: Request, env: Env, orgId: string): Promise<Response> {
  const caller = extractCaller(request);
  if (!caller) return json({ error: 'Unauthorized' }, 401);

  const membership = await requireOrgRole(env, orgId, caller, ['admin', 'cashier']);
  if (!membership) return json({ error: 'Forbidden' }, 403);

  const row = await env.DB.prepare('SELECT * FROM organizations WHERE id = ?').bind(orgId).first<OrganizationRow>();
  if (!row) return json({ error: 'Unknown organization' }, 404);
  return json(rowToOrganization(row));
}

export async function updateBranding(request: Request, env: Env, orgId: string): Promise<Response> {
  const caller = extractCaller(request);
  if (!caller) return json({ error: 'Unauthorized' }, 401);

  const membership = await requireOrgRole(env, orgId, caller, ['admin']);
  if (!membership) return json({ error: 'Forbidden' }, 403);

  const body = (await request.json().catch(() => ({}))) as { name?: string; logoUrl?: string; theme?: string };
  const updates: string[] = [];
  const values: unknown[] = [];

  if (body.name !== undefined) {
    if (!body.name.trim()) return json({ error: 'name cannot be empty' }, 400);
    updates.push('name = ?');
    values.push(body.name.trim());
  }
  if (body.logoUrl !== undefined) {
    updates.push('logo_url = ?');
    values.push(body.logoUrl || null);
  }
  if (body.theme !== undefined) {
    updates.push('theme = ?');
    values.push(body.theme || null);
  }
  if (updates.length === 0) return json({ error: 'Nothing to update' }, 400);

  values.push(orgId);
  await env.DB.prepare(`UPDATE organizations SET ${updates.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();

  const row = await env.DB.prepare('SELECT * FROM organizations WHERE id = ?').bind(orgId).first<OrganizationRow>();
  return json(rowToOrganization(row!));
}

// Internal helper for identity-providers.ts / payment-credentials.ts: gets
// this org's unwrapped data key. Never sent over the API — exists only for
// the lifetime of the request that needs it.
export async function getOrgDataKey(env: Env, orgId: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT dek_ciphertext, dek_iv FROM organizations WHERE id = ?')
    .bind(orgId)
    .first<{ dek_ciphertext: string; dek_iv: string }>();
  if (!row) return null;

  return unwrapDataKey({ ciphertext: row.dek_ciphertext, iv: row.dek_iv }, env.ENCRYPTION_KEY);
}
