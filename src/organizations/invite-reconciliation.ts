// Split out of members.ts specifically to keep the import graph acyclic:
// organizations.ts calls this at the top of its caller-scoped endpoints, so
// this file must not depend on organizations.ts (directly or transitively)
// — unlike members.ts, which now does (smtp-credentials.ts needs
// getOrgDataKey for the invite email's SMTP credentials). If this lived in
// members.ts instead, organizations.ts -> members.ts -> smtp-credentials.ts
// -> organizations.ts would cycle.
import type { Env } from '../env';
import { resolveInstanceIssuerUrl } from './idp-resolution';
import type { CallerIdentity, MembershipRow } from './types';

// Invitations are keyed by email because the invited person's sub isn't
// known until they first log in. Called at the top of any caller-scoped
// organizations endpoint (see organizations.ts's listMyOrgs) so a pending
// invite becomes a real, active membership the moment its owner shows up —
// no separate "accept invite" click needed.
//
// Two guards before an invite is bound to the caller's (issuer, sub):
//  - the caller must come from this instance's own login provider (the
//    `default` identity_providers row) — an identity minted by any other
//    issuer never claims an invite;
//  - the provider must not have marked the e-mail unverified
//    (`email_verified === false`): otherwise anyone able to sign up at the
//    provider with someone else's address unverified (e-mail/password
//    sign-up, a guest identity) could take over that person's invite. A
//    missing claim (null) keeps working — some providers omit it.
export async function reconcilePendingInvites(env: Env, caller: CallerIdentity): Promise<void> {
  const { sub, email, issuer } = caller;
  if (!email) return;
  if (caller.emailVerified === false) return;

  const { results: pending } = await env.DB.prepare(
    "SELECT * FROM memberships WHERE invited_email = ? AND status = 'pending'"
  )
    .bind(email)
    .all<MembershipRow>();
  if (!pending?.length) return;

  const expectedIssuer = await resolveInstanceIssuerUrl(env);
  if (expectedIssuer && expectedIssuer !== issuer) return;

  for (const row of pending) {
    await env.DB.prepare("UPDATE memberships SET user_sub = ?, issuer = ?, status = 'active', accepted_at = ? WHERE id = ?")
      .bind(sub, issuer, new Date().toISOString(), row.id)
      .run();
  }
}
