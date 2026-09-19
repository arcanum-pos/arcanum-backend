import type { Env } from '../env';
import { json } from '../http';
import { buildInviteEmail } from '../email-templates/invite';
import { extractCaller, requireOrgRole } from './auth';
import { sendOrgEmail } from './mail';
import type { MembershipRow, OrgRole } from './types';

const VALID_ROLES = new Set<OrgRole>(['admin', 'cashier']);

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

  const membership = await requireOrgRole(env, orgId, caller, ['admin', 'cashier']);
  if (!membership) return json({ error: 'Forbidden' }, 403);

  const { results } = await env.DB.prepare('SELECT * FROM memberships WHERE org_id = ? ORDER BY invited_at').bind(orgId).all<MembershipRow>();
  return json((results || []).map(rowToMember));
}

export async function inviteMember(request: Request, env: Env, orgId: string): Promise<Response> {
  const caller = extractCaller(request);
  if (!caller) return json({ error: 'Unauthorized' }, 401);

  const membership = await requireOrgRole(env, orgId, caller, ['admin']);
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

  // Best-effort: a broken mail config (this org's own, or the platform
  // default's, whichever transport is active) must never fail invite
  // creation itself — worst case, the admin has to tell them out of band,
  // exactly like before this existed.
  try {
    const org = await env.DB.prepare('SELECT name FROM organizations WHERE id = ?').bind(orgId).first<{ name: string }>();
    if (org) {
      const content = buildInviteEmail({ orgName: org.name, role, loginUrl: `${env.PUBLIC_BASE_URL}/login` });
      await sendOrgEmail(env, orgId, { to: email, ...content });
    }
  } catch (err) {
    console.error('Kon uitnodigingsmail niet versturen', err);
  }

  return json(rowToMember(row!), 201);
}

export async function updateMemberRole(request: Request, env: Env, orgId: string, membershipId: string): Promise<Response> {
  const caller = extractCaller(request);
  if (!caller) return json({ error: 'Unauthorized' }, 401);

  const membership = await requireOrgRole(env, orgId, caller, ['admin']);
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

  const membership = await requireOrgRole(env, orgId, caller, ['admin']);
  if (!membership) return json({ error: 'Forbidden' }, 403);

  const target = await env.DB.prepare('SELECT * FROM memberships WHERE id = ? AND org_id = ?').bind(membershipId, orgId).first<MembershipRow>();
  if (!target) return json({ error: 'Unknown membership' }, 404);

  // Removing your own membership locks you out of this org immediately —
  // unlike a demotion (still reachable via another admin) or a last-admin
  // removal, there's no recovery path once your own row is gone. Blocked
  // unconditionally, regardless of role or how many other admins exist.
  // issuer+sub together, not sub alone — a bare sub is only unique within
  // the issuer that minted it (see auth.ts's extractCaller comment).
  if (target.user_sub === caller.sub && target.issuer === caller.issuer) {
    return json({ error: 'Cannot remove your own membership' }, 400);
  }

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
