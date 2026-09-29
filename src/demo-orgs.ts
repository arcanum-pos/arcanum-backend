// Demo organizations — the demo instance's only way to get a new org
// (ORG_CREATION=internal, HOSTING_PLAN.md section 2):
//
//   POST /internal/demo-orgs   Authorization: Bearer <BOOTSTRAP_API_KEY>
//     { sub, email, name?, locale? }
//     → 201 { orgId, name, expiresAt, created: true }    a new demo org
//     → 200 { orgId, name, expiresAt, created: false }   this person's live one
//     → 429 demo_limit_reached                           DEMO_MAX_LIVE live demos already
//
// Called by the bootstrapper (start.kaboutersoft.be) over a service binding,
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
import { jsonRowsStatement, present } from './sql-json';
import { generateDataKey, wrapDataKey } from './organizations/crypto';
import { ensureDefaultOrganization } from './organizations/identity-providers';
import { DEFAULT_ORG_ID } from './organizations/idp-resolution';
import { orgCreationMode } from './organizations/org-creation';
import { demoExpiresAt, demoLifetimeHours, demoMaxLive } from './organizations/demo';
import { toLocale, type Locale } from './organizations/locale';

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

// --- The seeded menukaart ---

type Text = Record<Locale, string>;

const t = (nl: string, fr: string, en: string): Text => ({ nl, fr, en });

const DEMO_NAME = t('Demo', 'Démo', 'Demo');
const DEMO_NAME_OF = t('Demo van {name}', 'Démo de {name}', "{name}'s demo");
const CATALOG_NAME = t('Menukaart', 'Carte', 'Menu');

const CATEGORIES = { drinks: t('Drank', 'Boissons', 'Drinks'), food: t('Eten', 'Nourriture', 'Food'), tokens: t('Bonnen', 'Jetons', 'Tokens') };
const STATIONS = { bar: t('Bar', 'Bar', 'Bar'), kitchen: t('Keuken', 'Cuisine', 'Kitchen') };
// Kassa layout, in order.
const SECTIONS = { drinks: t('Drank', 'Boissons', 'Drinks'), food: t('Eten', 'Plats', 'Food'), tokens: t('Bonnen', 'Jetons', 'Tokens') };

interface DemoProduct {
  name: Text;
  category: keyof typeof CATEGORIES;
  station: keyof typeof STATIONS | null;
  section: keyof typeof SECTIONS;
  vatRateBp: number;
  variants: { name: Text | null; priceCents: number; quick?: number[] }[];
}

// A small café / club bar: drinks at 21%, food eaten in at 12% (Belgium).
const PRODUCTS: DemoProduct[] = [
  {
    name: t('Pils', 'Pils', 'Lager'),
    category: 'drinks', station: 'bar', section: 'drinks', vatRateBp: 2100,
    variants: [{ name: t('25 cl', '25 cl', '25 cl'), priceCents: 250 }, { name: t('50 cl', '50 cl', '50 cl'), priceCents: 450 }],
  },
  { name: t('Tripel', 'Triple', 'Tripel'), category: 'drinks', station: 'bar', section: 'drinks', vatRateBp: 2100, variants: [{ name: null, priceCents: 400 }] },
  {
    name: t('Wijn', 'Vin', 'Wine'),
    category: 'drinks', station: 'bar', section: 'drinks', vatRateBp: 2100,
    variants: [{ name: t('rood', 'rouge', 'red'), priceCents: 400 }, { name: t('wit', 'blanc', 'white'), priceCents: 400 }, { name: t('rosé', 'rosé', 'rosé'), priceCents: 400 }],
  },
  {
    name: t('Frisdrank', 'Soft', 'Soft drink'),
    category: 'drinks', station: 'bar', section: 'drinks', vatRateBp: 2100,
    variants: [{ name: t('cola', 'cola', 'cola'), priceCents: 250 }, { name: t('limonade', 'limonade', 'lemonade'), priceCents: 250 }, { name: t('ice tea', 'thé glacé', 'iced tea'), priceCents: 250 }],
  },
  {
    name: t('Water', 'Eau', 'Water'),
    category: 'drinks', station: 'bar', section: 'drinks', vatRateBp: 2100,
    variants: [{ name: t('plat', 'plate', 'still'), priceCents: 200 }, { name: t('bruis', 'pétillante', 'sparkling'), priceCents: 200 }],
  },
  { name: t('Koffie', 'Café', 'Coffee'), category: 'drinks', station: 'bar', section: 'drinks', vatRateBp: 2100, variants: [{ name: null, priceCents: 250 }] },
  { name: t('Thee', 'Thé', 'Tea'), category: 'drinks', station: 'bar', section: 'drinks', vatRateBp: 2100, variants: [{ name: null, priceCents: 250 }] },
  {
    name: t('Croque', 'Croque', 'Toastie'),
    category: 'food', station: 'kitchen', section: 'food', vatRateBp: 1200,
    variants: [{ name: t('ham-kaas', 'jambon-fromage', 'ham & cheese'), priceCents: 600 }, { name: t('kaas', 'fromage', 'cheese'), priceCents: 550 }],
  },
  {
    name: t('Spaghetti bolognese', 'Spaghetti bolognaise', 'Spaghetti bolognese'),
    category: 'food', station: 'kitchen', section: 'food', vatRateBp: 1200,
    variants: [{ name: t('klein', 'petite', 'small'), priceCents: 900 }, { name: t('groot', 'grande', 'large'), priceCents: 1200 }],
  },
  { name: t('Soep van de dag', 'Soupe du jour', 'Soup of the day'), category: 'food', station: 'kitchen', section: 'food', vatRateBp: 1200, variants: [{ name: null, priceCents: 450 }] },
  {
    name: t('Pannenkoek', 'Crêpe', 'Pancake'),
    category: 'food', station: 'kitchen', section: 'food', vatRateBp: 1200,
    variants: [{ name: t('suiker', 'sucre', 'sugar'), priceCents: 400 }, { name: t('choco', 'chocolat', 'chocolate'), priceCents: 450 }],
  },
  // Nothing to prepare; sold in round numbers from the quick buttons.
  { name: t('Drankbon', 'Jeton boisson', 'Drink token'), category: 'tokens', station: null, section: 'tokens', vatRateBp: 2100, variants: [{ name: null, priceCents: 250, quick: [5, 10, 20] }] },
];

// Every row of the seeded menukaart for `orgId`, fresh ids, in `locale`.
export function demoMenuRows(orgId: string, locale: Locale, createdAt: string) {
  const id = () => crypto.randomUUID();
  const ids = <K extends string>(keys: K[]) => Object.fromEntries(keys.map((k) => [k, id()])) as Record<K, string>;
  const categoryIds = ids(Object.keys(CATEGORIES) as (keyof typeof CATEGORIES)[]);
  const stationIds = ids(Object.keys(STATIONS) as (keyof typeof STATIONS)[]);
  const sectionIds = ids(Object.keys(SECTIONS) as (keyof typeof SECTIONS)[]);
  const catalogId = id();

  const categories = Object.entries(CATEGORIES).map(([k, name], position) => ({
    id: categoryIds[k as keyof typeof CATEGORIES], org_id: orgId, name: name[locale], position, created_at: createdAt,
  }));
  const stations = Object.entries(STATIONS).map(([k, name], position) => ({
    id: stationIds[k as keyof typeof STATIONS], org_id: orgId, name: name[locale], position, created_at: createdAt,
  }));
  const sections = Object.entries(SECTIONS).map(([k, name], position) => ({
    id: sectionIds[k as keyof typeof SECTIONS], org_id: orgId, catalog_id: catalogId, name: name[locale], position,
  }));

  const products: Record<string, unknown>[] = [];
  const variants: Record<string, unknown>[] = [];
  const entries: Record<string, unknown>[] = [];
  const positionInSection: Record<string, number> = {};
  for (const p of PRODUCTS) {
    const productId = id();
    products.push({
      id: productId, org_id: orgId, category_id: categoryIds[p.category], prep_station_id: p.station ? stationIds[p.station] : null,
      name: p.name[locale], vat_rate_bp: p.vatRateBp, created_at: createdAt,
    });
    p.variants.forEach((v, position) => {
      const variantId = id();
      variants.push({ id: variantId, org_id: orgId, product_id: productId, name: v.name ? v.name[locale] : '', code: null, position, created_at: createdAt });
      const at = (positionInSection[p.section] = (positionInSection[p.section] ?? -1) + 1);
      entries.push({
        id: id(), org_id: orgId, catalog_id: catalogId, section_id: sectionIds[p.section], variant_id: variantId, price_cents: v.priceCents,
        visible: 1, position: at, quick_quantities: v.quick ? JSON.stringify(v.quick) : null,
      });
    });
  }
  const catalog = { id: catalogId, org_id: orgId, name: CATALOG_NAME[locale], is_default: 1, created_at: createdAt, updated_at: createdAt };
  return { categories, stations, products, variants, catalog, sections, entries };
}

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

function demoResponse(env: Env, org: LiveDemo, created: boolean): Response {
  return json({ orgId: org.id, name: org.name, expiresAt: demoExpiresAt(env, org.created_at), created }, created ? 201 : 200);
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
  try {
    await ensureDefaultOrganization(env);
  } catch (err) {
    return json({ error: 'Default identity provider is not configured', details: (err as Error).message }, 503);
  }
  const idp = await env.DB.prepare('SELECT issuer_url FROM identity_providers WHERE org_id = ?').bind(DEFAULT_ORG_ID).first<{ issuer_url: string | null }>();
  if (!idp?.issuer_url) return json({ error: 'Default identity provider is not configured' }, 503);
  const issuer = idp.issuer_url;

  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const cutoff = new Date(nowMs - demoLifetimeHours(env) * 3600_000).toISOString();

  const existing = await liveDemoOf(env, issuer, sub, cutoff);
  if (existing) return demoResponse(env, existing, false);

  const orgId = crypto.randomUUID();
  const orgName = personName ? DEMO_NAME_OF[locale].replace('{name}', personName) : DEMO_NAME[locale];
  const wrapped = await wrapDataKey(generateDataKey(), env.ENCRYPTION_KEY);
  const menu = demoMenuRows(orgId, locale, now);
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
      jsonRowsStatement(env.DB, 'categories', ['id', 'org_id', 'name', 'position', 'created_at'], menu.categories, { where: orgExists }),
      jsonRowsStatement(env.DB, 'prep_stations', ['id', 'org_id', 'name', 'position', 'created_at'], menu.stations, { where: orgExists }),
      jsonRowsStatement(env.DB, 'products', ['id', 'org_id', 'category_id', 'prep_station_id', 'name', 'vat_rate_bp', 'created_at'], menu.products, { where: orgExists }),
      jsonRowsStatement(env.DB, 'product_variants', ['id', 'org_id', 'product_id', 'name', 'code', 'position', 'created_at'], menu.variants, { where: orgExists }),
      jsonRowsStatement(env.DB, 'catalogs', ['id', 'org_id', 'name', 'is_default', 'created_at', 'updated_at'], [menu.catalog], { where: orgExists }),
      jsonRowsStatement(env.DB, 'catalog_sections', ['id', 'org_id', 'catalog_id', 'name', 'position'], menu.sections, { where: orgExists }),
      jsonRowsStatement(
        env.DB,
        'catalog_entries',
        ['id', 'org_id', 'catalog_id', 'section_id', 'variant_id', 'price_cents', 'visible', 'position', 'quick_quantities'],
        menu.entries,
        { where: orgExists }
      ),
    ])
  );

  if ((inserted.meta.changes || 0) === 0) {
    // Lost a race against this person's own other click — or the cap is reached.
    const raced = await liveDemoOf(env, issuer, sub, cutoff);
    if (raced) return demoResponse(env, raced, false);
    return errorJson('demo_limit_reached', 429);
  }
  return demoResponse(env, { id: orgId, name: orgName, created_at: now }, true);
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
