import type { Env } from '../env';
import { json } from '../http';
import { extractCaller, requireOrgRole } from './auth';
import type { MembershipRow, OrgRole } from './types';

const VALID_ROLES = new Set<OrgRole>(['admin', 'cashier']);

// Invitations are keyed by email because the invited person's Auth0 `sub`
// isn't known until they first log in. Called at the top of any
// caller-scoped organizations endpoint (see organizations.ts's listMyOrgs) so
// a pending invite becomes a real, active membership the moment its owner
// shows up — no separate "accept invite" click needed.
export async function reconcilePendingInvites(env: Env, sub: string, email: string): Promise<void> {
  if (!email) return;
  await env.DB.prepare(
    "UPDATE memberships SET user_sub = ?, status = 'active', accepted_at = ? WHERE invited_email = ? AND status = 'pending'"
  )
    .bind(sub, new Date().toISOString(), email)
    .run();
}

function rowToMember(row: MembershipRow) {
  return {
    id: row.id,
    userSub: row.user_sub,
    invitedEmail: row.invited_email,
    role: row.role,
    status: row.status,
    invitedAt: row.invited_at,
    acceptedAt: row.accepted_at,
  };
}

// Listing is open to any active member (so a cashier can at least see who
// else is in their org); inviting/role changes/removal are admin-only.
export async function listMembers(request: Request, env: Env, orgId: string): Promise<Response> {
  const caller = extractCaller(request);
  if (!caller) return json({ error: 'Unauthorized' }, 401);

  const membership = await requireOrgRole(env, orgId, caller.sub, ['admin', 'cashier']);
  if (!membership) return json({ error: 'Forbidden' }, 403);

  const { results } = await env.DB.prepare('SELECT * FROM memberships WHERE org_id = ? ORDER BY invited_at').bind(orgId).all<MembershipRow>();
  return json((results || []).map(rowToMember));
}

export async function inviteMember(request: Request, env: Env, orgId: string): Promise<Response> {
  const caller = extractCaller(request);
  if (!caller) return json({ error: 'Unauthorized' }, 401);

  const membership = await requireOrgRole(env, orgId, caller.sub, ['admin']);
  if (!membership) return json({ error: 'Forbidden' }, 403);

  const body = (await request.json().catch(() => ({}))) as { email?: string; role?: string };
  const email = (body.email || '').trim().toLowerCase();
  const role = body.role as OrgRole;

  if (!email) return json({ error: 'email is required' }, 400);
  if (!VALID_ROLES.has(role)) return json({ error: "role must be 'admin' or 'cashier'" }, 400);

  const existing = await env.DB.prepare('SELECT * FROM memberships WHERE org_id = ? AND invited_email = ?').bind(orgId, email).first<MembershipRow>();
  if (existing) return json({ error: 'This email is already invited or a member' }, 409);

  const id = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO memberships (id, org_id, user_sub, invited_email, role, status, invited_at) VALUES (?, ?, NULL, ?, ?, ?, ?)'
  )
    .bind(id, orgId, email, role, 'pending', new Date().toISOString())
    .run();

  const row = await env.DB.prepare('SELECT * FROM memberships WHERE id = ?').bind(id).first<MembershipRow>();
  return json(rowToMember(row!), 201);
}

export async function updateMemberRole(request: Request, env: Env, orgId: string, membershipId: string): Promise<Response> {
  const caller = extractCaller(request);
  if (!caller) return json({ error: 'Unauthorized' }, 401);

  const membership = await requireOrgRole(env, orgId, caller.sub, ['admin']);
  if (!membership) return json({ error: 'Forbidden' }, 403);

  const body = (await request.json().catch(() => ({}))) as { role?: string };
  const role = body.role as OrgRole;
  if (!VALID_ROLES.has(role)) return json({ error: "role must be 'admin' or 'cashier'" }, 400);

  const target = await env.DB.prepare('SELECT * FROM memberships WHERE id = ? AND org_id = ?').bind(membershipId, orgId).first<MembershipRow>();
  if (!target) return json({ error: 'Unknown membership' }, 404);

  // An admin can't demote themselves if they're the last admin — otherwise
  // the organization becomes unmanageable.
  if (target.user_sub === caller.sub && role !== 'admin') {
    const { results } = await env.DB.prepare(
      "SELECT id FROM memberships WHERE org_id = ? AND role = 'admin' AND status = 'active'"
    )
      .bind(orgId)
      .all<{ id: string }>();
    if ((results || []).length <= 1) {
      return json({ error: 'Cannot remove the last admin of an organization' }, 400);
    }
  }

  await env.DB.prepare('UPDATE memberships SET role = ? WHERE id = ?').bind(role, membershipId).run();
  const row = await env.DB.prepare('SELECT * FROM memberships WHERE id = ?').bind(membershipId).first<MembershipRow>();
  return json(rowToMember(row!));
}

export async function removeMember(request: Request, env: Env, orgId: string, membershipId: string): Promise<Response> {
  const caller = extractCaller(request);
  if (!caller) return json({ error: 'Unauthorized' }, 401);

  const membership = await requireOrgRole(env, orgId, caller.sub, ['admin']);
  if (!membership) return json({ error: 'Forbidden' }, 403);

  const target = await env.DB.prepare('SELECT * FROM memberships WHERE id = ? AND org_id = ?').bind(membershipId, orgId).first<MembershipRow>();
  if (!target) return json({ error: 'Unknown membership' }, 404);

  if (target.role === 'admin' && target.status === 'active') {
    const { results } = await env.DB.prepare(
      "SELECT id FROM memberships WHERE org_id = ? AND role = 'admin' AND status = 'active'"
    )
      .bind(orgId)
      .all<{ id: string }>();
    if ((results || []).length <= 1) {
      return json({ error: 'Cannot remove the last admin of an organization' }, 400);
    }
  }

  await env.DB.prepare('DELETE FROM memberships WHERE id = ?').bind(membershipId).run();
  return json({ ok: true });
}
