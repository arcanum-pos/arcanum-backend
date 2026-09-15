// Split out of members.ts specifically to keep the import graph acyclic:
// organizations.ts calls this at the top of its caller-scoped endpoints, so
// this file must not depend on organizations.ts (directly or transitively)
// — unlike members.ts, which now does (smtp-credentials.ts needs
// getOrgDataKey for the invite email's SMTP credentials). If this lived in
// members.ts instead, organizations.ts -> members.ts -> smtp-credentials.ts
// -> organizations.ts would cycle.
import type { Env } from '../env';
import { resolveConfiguredIssuerUrl } from './idp-resolution';
import type { MembershipRow } from './types';

// Invitations are keyed by email because the invited person's sub isn't
// known until they first log in. Called at the top of any caller-scoped
// organizations endpoint (see organizations.ts's listMyOrgs) so a pending
// invite becomes a real, active membership the moment its owner shows up —
// no separate "accept invite" click needed.
//
// `issuer` is checked per-row against that row's *own org's* configured
// issuer (falling back to the platform default) before activating it — an
// org can only ever bring its own identity provider for itself, so without
// this check, org B's fully-attacker-controlled IdP could assert an `email`
// claim matching a pending invite for org A and hijack it.
export async function reconcilePendingInvites(env: Env, sub: string, email: string, issuer: string): Promise<void> {
  if (!email) return;

  const { results: pending } = await env.DB.prepare(
    "SELECT * FROM memberships WHERE invited_email = ? AND status = 'pending'"
  )
    .bind(email)
    .all<MembershipRow>();

  for (const row of pending || []) {
    const expectedIssuer = await resolveConfiguredIssuerUrl(env, row.org_id);
    if (expectedIssuer && expectedIssuer !== issuer) continue;

    await env.DB.prepare("UPDATE memberships SET user_sub = ?, issuer = ?, status = 'active', accepted_at = ? WHERE id = ?")
      .bind(sub, issuer, new Date().toISOString(), row.id)
      .run();
  }
}
