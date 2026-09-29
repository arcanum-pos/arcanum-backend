// Who may create (or import) an organization on this installation — the
// ORG_CREATION var, one codebase behaving like each kind of installation
// (HOSTING_PLAN.md section 1):
//
//   admins    (default, also for an unset/unknown value) — anyone on the
//             INSTANCE_ADMIN_EMAILS allowlist (instance-admins.ts), any
//             number of orgs.
//   single    an own instance: an instance admin, and only while no org
//             exists other than the platform 'default' row — the first
//             org (created or imported), then never again.
//   internal  the demo instance: nobody through the admin API; demo orgs
//             come only from POST /internal/demo-orgs (demo-orgs.ts).
//
//   GET /organizations/capabilities (any logged-in user) → what this caller
//   may do right now, so the console can hide "Nieuwe organisatie".
//
// Refusals: `org_creation_disabled` when the mode says no, `not_instance_admin`
// when the allowlist does (see errors.ts).
import type { Env } from '../env';
import { json } from '../http';
import type { ErrorCode } from '../errors';
import { extractCaller } from './auth';
import { mayCreateOrganizations } from './instance-admins';
import { DEFAULT_ORG_ID } from './idp-resolution';
import type { CallerIdentity } from './types';

export type OrgCreationMode = 'admins' | 'single' | 'internal';

export function orgCreationMode(env: Env): OrgCreationMode {
  const value = (env.ORG_CREATION || '').trim().toLowerCase();
  return value === 'single' || value === 'internal' ? value : 'admins';
}

// SQL condition "no org exists yet" for single mode — also used as the
// guard of the INSERT itself, so two concurrent first creates can't both
// get through between the check and the write.
export const NO_ORG_YET_SQL = `NOT EXISTS (SELECT 1 FROM organizations WHERE id != '${DEFAULT_ORG_ID}')`;

async function anyOrgExists(env: Env): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT ${NO_ORG_YET_SQL} AS none`).first<{ none: number }>();
  return !row?.none;
}

// Why this caller may not create/import an org right now, or null when they may.
export async function orgCreationRefusal(env: Env, caller: CallerIdentity): Promise<ErrorCode | null> {
  const mode = orgCreationMode(env);
  if (mode === 'internal') return 'org_creation_disabled';
  if (mode === 'single' && (await anyOrgExists(env))) return 'org_creation_disabled';
  if (!mayCreateOrganizations(env, caller.email)) return 'not_instance_admin';
  return null;
}

export async function getCapabilities(request: Request, env: Env): Promise<Response> {
  const caller = extractCaller(request);
  if (!caller) return json({ error: 'Unauthorized' }, 401);
  // Creating and importing follow exactly the same rules today; two flags
  // so the console doesn't need to change if they ever diverge.
  const allowed = (await orgCreationRefusal(env, caller)) === null;
  return json({ orgCreation: orgCreationMode(env), canCreateOrganization: allowed, canImportOrganization: allowed });
}
