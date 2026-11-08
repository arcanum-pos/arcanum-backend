// Demo organizations — the demo instance's only way to get a new org
// (ORG_CREATION=internal, HOSTING_PLAN.md section 2):
//
//   POST /internal/demo-orgs   Authorization: Bearer <BOOTSTRAP_API_KEY>
//     { sub, email, name?, locale? }
//     → 201 { orgId, name, expiresAt, created: true, pairingCode }    a new demo org
//     → 200 { orgId, name, expiresAt, created: false, pairingCode }   this person's live one
//
// pairingCode: a fresh code for the demo's "Kassa 1" — the bootstrapper
// opens the demo's start page with it (/?code=…), which pairs the browser
// the demo starts in and opens the kassa (what people will use most).
//     → 429 demo_limit_reached                           DEMO_MAX_LIVE live demos already
//
// Called by the bootstrapper (arcanum.kaboutersoft.be) over a service binding,
// never by a browser. `sub` is the person's id at the platform's default
// login provider (the bootstrapper and this instance share it), so the admin
// membership is bound to (issuer, sub) right away — no invite, the next
// /login lands straight in the demo. `name` is the person's display name
// (for the org's name), `locale` nl|fr|en (anything else: nl).
//
// Not reachable through arcanum-bff: its only generic pass-through to this
// Worker (/api/bancontact/* → /*) does forward /internal/*, but always
// replaces the Authorization header with the session's own access token and
// adds X-Forwarded-By — so a browser can never present BOOTSTRAP_API_KEY,
// and anything carrying X-Forwarded-By is turned away below regardless.
//
// The demo gets a small seeded menukaart (categories, prep stations,
// products with variants, one default catalog with sections), all written
// in one batch of json_each statements — a handful of queries whatever the
// menu's size (Workers Free: 50 per invocation, see query-budget.ts).
import type { Env } from './env';
import { json } from './http';
import { errorJson } from './errors';
import { present } from './sql-json';
import { generateDataKey, wrapDataKey } from './organizations/crypto';
import { resolveInstanceIssuerUrl } from './organizations/idp-resolution';
import { orgCreationMode } from './organizations/org-creation';
import { demoExpiresAt, demoLifetimeHours, demoMaxLive } from './organizations/demo';
import { toLocale, type Locale } from './organizations/locale';
import { issuePairingCode } from './devices';
import { exampleMenuRows, exampleMenuStatements, t } from './organizations/example-menu';

// Constant-time, so the key can't be guessed byte by byte from timings.
function sameKey(given: string, expected: string): boolean {
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

function hasBootstrapKey(request: Request, env: Env): boolean {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return Boolean(env.BOOTSTRAP_API_KEY) && sameKey(token, env.BOOTSTRAP_API_KEY!);
}

// --- Demo names (the menukaart itself: organizations/example-menu.ts) ---

const DEMO_NAME = t('Demo', 'Démo', 'Demo');
const DEMO_NAME_OF = t('Demo van {name}', 'Démo de {name}', "{name}'s demo");

// --- The endpoint ---

interface LiveDemo {
  id: string;
  name: string;
  created_at: string;
}

// This person's demo that hasn't expired yet (one expired but not yet
// cleaned up doesn't count — they get a fresh one).
function liveDemoOf(env: Env, issuer: string, sub: string, cutoff: string) {
  return env.DB.prepare(
    `SELECT o.id, o.name, o.created_at FROM organizations o
     JOIN memberships m ON m.org_id = o.id
     WHERE m.issuer = ? AND m.user_sub = ? AND m.role = 'admin' AND m.status = 'active' AND o.is_locked = 'N' AND o.created_at > ?
     ORDER BY o.created_at DESC LIMIT 1`
  )
    .bind(issuer, sub, cutoff)
    .first<LiveDemo>();
}

const DEMO_KASSA = t('Kassa 1', 'Caisse 1', 'Till 1');

async function demoResponse(env: Env, org: LiveDemo, created: boolean, locale: Locale): Promise<Response> {
  const { code } = await issuePairingCode(env, org.id, 'pos', DEMO_KASSA[locale], 'Demo');
  return json({ orgId: org.id, name: org.name, expiresAt: demoExpiresAt(env, org.created_at), created, pairingCode: code }, created ? 201 : 200);
}

export async function createDemoOrg(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { sub?: unknown; email?: unknown; name?: unknown; locale?: unknown };
  const sub = typeof body.sub === 'string' ? body.sub.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const personName = typeof body.name === 'string' ? body.name.trim().slice(0, 60) : '';
  const locale = toLocale(body.locale);
  if (!sub || sub.length > 255) return json({ error: 'sub is required' }, 400);
  if (!email.includes('@') || email.length > 254) return json({ error: 'email is required' }, 400);

  // The shared login provider's issuer: what the bootstrapper's `sub` belongs to.
  const issuer = await resolveInstanceIssuerUrl(env);
  if (!issuer) return json({ error: 'Default identity provider is not configured' }, 503);

  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const cutoff = new Date(nowMs - demoLifetimeHours(env) * 3600_000).toISOString();

  const existing = await liveDemoOf(env, issuer, sub, cutoff);
  if (existing) return demoResponse(env, existing, false, locale);

  const orgId = crypto.randomUUID();
  const orgName = personName ? DEMO_NAME_OF[locale].replace('{name}', personName) : DEMO_NAME[locale];
  const wrapped = await wrapDataKey(generateDataKey(), env.ENCRYPTION_KEY);
  const menu = exampleMenuRows(orgId, locale, now);
  // Everything after the org row only goes in when that row did.
  const orgExists = { sql: 'EXISTS (SELECT 1 FROM organizations WHERE id = ?)', params: [orgId] };

  const [inserted] = await env.DB.batch(
    present([
      // The cap and "one live demo per person" again as the INSERT's own
      // guard — two simultaneous clicks can't both get through.
      env.DB.prepare(
        `INSERT INTO organizations (id, name, logo_url, theme, locale, dek_ciphertext, dek_iv, created_at, created_by_sub, is_locked)
         SELECT ?, ?, NULL, NULL, ?, ?, ?, ?, ?, 'N'
         WHERE (SELECT COUNT(*) FROM organizations WHERE is_locked = 'N') < ?
           AND NOT EXISTS (
             SELECT 1 FROM organizations o JOIN memberships m ON m.org_id = o.id
             WHERE m.issuer = ? AND m.user_sub = ? AND m.role = 'admin' AND m.status = 'active' AND o.is_locked = 'N' AND o.created_at > ?
           )`
      ).bind(orgId, orgName, locale, wrapped.ciphertext, wrapped.iv, now, sub, demoMaxLive(env), issuer, sub, cutoff),
      env.DB.prepare(
        `INSERT INTO memberships (id, org_id, user_sub, issuer, invited_email, role, status, invited_at, accepted_at)
         SELECT ?, ?, ?, ?, ?, 'admin', 'active', ?, ? WHERE ${orgExists.sql}`
      ).bind(crypto.randomUUID(), orgId, sub, issuer, email, now, now, orgId),
      ...exampleMenuStatements(env.DB, menu, orgExists),
    ])
  );

  if ((inserted.meta.changes || 0) === 0) {
    // Lost a race against this person's own other click — or the cap is reached.
    const raced = await liveDemoOf(env, issuer, sub, cutoff);
    if (raced) return demoResponse(env, raced, false, locale);
    return errorJson('demo_limit_reached', 429);
  }
  return demoResponse(env, { id: orgId, name: orgName, created_at: now }, true, locale);
}

// Handles /internal/demo-orgs. Anything else under /internal, a missing
// mode, or a request that came through arcanum-bff's proxy: as if the route
// didn't exist.
export async function dispatchDemoOrgsRoute(request: Request, env: Env, pathname: string): Promise<Response | null> {
  if (pathname !== '/internal/demo-orgs' || request.method !== 'POST') return null;
  if (orgCreationMode(env) !== 'internal' || request.headers.has('X-Forwarded-By')) return null;
  if (!hasBootstrapKey(request, env)) return json({ error: 'Unauthorized' }, 401);
  return createDemoOrg(request, env);
}
