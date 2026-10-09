// The installation's login provider, as far as arcanum-backend needs it:
// only its issuer (MAIL.md decision 6) — what every member's (issuer, sub)
// belongs to. The bff signs people in with its own client settings.
import type { Env } from '../env';

// The platform's former fallback organisation: it held the copied login
// provider and mail settings until MAIL.md phase 4. Its row may still exist
// in an installation's database; nothing reads it any more, but it must
// never count as a real organisation (org-creation.ts, arcanum-cleaner).
export const DEFAULT_ORG_ID = 'default';

// The issuer this instance's members authenticate against (invites, demo
// orgs): DEFAULT_IDP_ISSUER_URL, as the installer sets it. As is:
// memberships store the issuer exactly as the provider names it.
export async function resolveInstanceIssuerUrl(env: Env): Promise<string | null> {
  return env.DEFAULT_IDP_ISSUER_URL?.trim() || null;
}
