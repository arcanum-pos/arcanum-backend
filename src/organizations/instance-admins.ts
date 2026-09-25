// Who may create (or import) an organization on this installation.
//
// INSTANCE_ADMIN_EMAILS unset/empty = anyone who can log in (the shared
// platform's self-service behaviour). Set on a self-hosted installation, it
// limits org creation to its owners — otherwise anyone the login provider
// accepts (e.g. any Google account, with an "External" OAuth client) could
// create their own org on someone else's Cloudflare account. Joining an org
// by invitation is never affected.
//
// Comma-separated: exact addresses and/or `*@domain` entries, case-insensitive.
import type { Env } from '../env';

export function mayCreateOrganizations(env: Env, email: string): boolean {
  const entries = (env.INSTANCE_ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (entries.length === 0) return true;
  const address = email.trim().toLowerCase();
  if (!address.includes('@')) return false;
  const domain = address.slice(address.lastIndexOf('@') + 1);
  return entries.some((e) => (e.startsWith('*@') ? e.slice(2) === domain : e === address));
}

export const NOT_AN_INSTANCE_ADMIN = 'Alleen de beheerders van deze installatie kunnen een organisatie aanmaken of importeren';
