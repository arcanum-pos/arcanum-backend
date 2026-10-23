// The customer display's branding (2026-10-23) — console → Instellingen →
// Weergave → Klantscherm: the organisation's logo and two colours, a main
// colour (the display's header and total panel) and an accent (highlights).
// An event may have colours of its own (events.brand_primary/brand_accent,
// set with PATCH …/events/:id); unset, the organisation's. Only the
// customer display uses them — the kassa and the console stay as they are.
//
//   GET    /organizations/:org/branding        member  { primary, accent, logo: { updatedAt } | null }
//   PUT    /organizations/:org/branding        admin   { primary?, accent? } — #rrggbb, or null: none
//   PUT    /organizations/:org/branding/logo   admin   { png } — base64, at most 512 px a side
//   DELETE /organizations/:org/branding/logo   admin
//   GET    /public/branding/:org[?event=:id]   nobody  { primary, accent, logoUrl } — what a display shows
//   GET    /public/branding/:org/logo.png      nobody  the logo
//
// Public like an org's app icons: a logo and two colours are on a screen
// facing the customers anyway; an org id is a random UUID. The browser
// redraws the logo as a PNG on a canvas at upload (any image it can show
// becomes a clean PNG — never an SVG with a script in it); here it's only
// checked to be one, and its size.
import type { Env } from './env';
import { errorJson } from './errors';
import { json } from './http';
import { extractCaller, requireOrgRole, SERVICE_ROLES } from './organizations/auth';
import { pngSize } from './org-icons';

const COLOR = /^#[0-9a-f]{6}$/;
export const MAX_LOGO_SIDE = 512;
const MAX_LOGO_BYTES = 500_000;

interface BrandingRow {
  primary_color: string | null;
  accent_color: string | null;
  logo_updated_at: string | null;
}

// A colour as given: #rrggbb (any case) → lower case; null/'' → none;
// anything else → undefined (refused).
export function readColor(value: unknown): string | null | undefined {
  if (value === null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const color = value.trim().toLowerCase();
  return COLOR.test(color) ? color : undefined;
}

function fromBase64(text: string): Uint8Array | null {
  try {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

async function refuse(request: Request, env: Env, orgId: string, roles: Parameters<typeof requireOrgRole>[3]): Promise<Response | null> {
  const caller = extractCaller(request);
  if (!caller) return json({ error: 'Unauthorized' }, 401);
  if (!(await requireOrgRole(env, orgId, caller, roles))) return json({ error: 'Forbidden' }, 403);
  return null;
}

const load = (env: Env, orgId: string) =>
  env.DB.prepare('SELECT primary_color, accent_color, logo_updated_at FROM org_branding WHERE org_id = ?').bind(orgId).first<BrandingRow>();

const view = (row: BrandingRow | null) => ({
  primary: row?.primary_color ?? null,
  accent: row?.accent_color ?? null,
  logo: row?.logo_updated_at ? { updatedAt: row.logo_updated_at } : null,
});

async function getBranding(request: Request, env: Env, orgId: string): Promise<Response> {
  const refused = await refuse(request, env, orgId, SERVICE_ROLES);
  return refused ?? json(view(await load(env, orgId)));
}

async function setColors(request: Request, env: Env, orgId: string): Promise<Response> {
  const refused = await refuse(request, env, orgId, ['admin']);
  if (refused) return refused;
  const body = (await request.json().catch(() => null)) as { primary?: unknown; accent?: unknown } | null;
  const current = await load(env, orgId);
  const primary = body?.primary === undefined ? (current?.primary_color ?? null) : readColor(body.primary);
  const accent = body?.accent === undefined ? (current?.accent_color ?? null) : readColor(body.accent);
  if (primary === undefined || accent === undefined) return errorJson('branding_color_invalid', 400);
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO org_branding (org_id, primary_color, accent_color, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (org_id) DO UPDATE SET primary_color = excluded.primary_color, accent_color = excluded.accent_color, updated_at = excluded.updated_at`
  )
    .bind(orgId, primary, accent, now)
    .run();
  return json(view(await load(env, orgId)));
}

async function setLogo(request: Request, env: Env, orgId: string): Promise<Response> {
  const refused = await refuse(request, env, orgId, ['admin']);
  if (refused) return refused;
  const body = (await request.json().catch(() => null)) as { png?: unknown } | null;
  const text = typeof body?.png === 'string' && body.png.length <= (MAX_LOGO_BYTES * 4) / 3 + 4 ? body.png : null;
  const bytes = text ? fromBase64(text) : null;
  const size = bytes ? pngSize(bytes) : null;
  if (!bytes || bytes.length > MAX_LOGO_BYTES || !size || size.width < 1 || size.height < 1 || size.width > MAX_LOGO_SIDE || size.height > MAX_LOGO_SIDE) {
    return errorJson('branding_logo_invalid', 400);
  }
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO org_branding (org_id, logo_png, logo_updated_at, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (org_id) DO UPDATE SET logo_png = excluded.logo_png, logo_updated_at = excluded.logo_updated_at, updated_at = excluded.updated_at`
  )
    .bind(orgId, text, now, now)
    .run();
  return json(view(await load(env, orgId)));
}

async function removeLogo(request: Request, env: Env, orgId: string): Promise<Response> {
  const refused = await refuse(request, env, orgId, ['admin']);
  if (refused) return refused;
  await env.DB.prepare('UPDATE org_branding SET logo_png = NULL, logo_updated_at = NULL, updated_at = ? WHERE org_id = ?').bind(new Date().toISOString(), orgId).run();
  return json(view(await load(env, orgId)));
}

// What a customer display shows: the event's colours where it has them,
// else the organisation's; the logo's address changes with every new logo.
async function publicBranding(env: Env, orgId: string, eventId: string | null): Promise<Response> {
  const [row, event] = await Promise.all([
    load(env, orgId),
    eventId ? env.DB.prepare('SELECT brand_primary, brand_accent FROM events WHERE id = ? AND org_id = ?').bind(eventId, orgId).first<{ brand_primary: string | null; brand_accent: string | null }>() : null,
  ]);
  const res = json({
    primary: event?.brand_primary ?? row?.primary_color ?? null,
    accent: event?.brand_accent ?? row?.accent_color ?? null,
    logoUrl: row?.logo_updated_at ? `/api/public/branding/${encodeURIComponent(orgId)}/logo.png?v=${encodeURIComponent(row.logo_updated_at)}` : null,
  });
  res.headers.set('Cache-Control', 'public, max-age=60');
  return res;
}

async function publicLogo(env: Env, orgId: string): Promise<Response> {
  const row = await env.DB.prepare('SELECT logo_png, logo_updated_at FROM org_branding WHERE org_id = ? AND logo_png IS NOT NULL').bind(orgId).first<{ logo_png: string; logo_updated_at: string }>();
  const bytes = row ? fromBase64(row.logo_png) : null;
  if (!bytes) return json({ error: 'Not found' }, 404);
  return new Response(bytes, {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=300', 'Last-Modified': new Date(row!.logo_updated_at).toUTCString(), 'X-Content-Type-Options': 'nosniff' },
  });
}

export async function dispatchPublicBrandingRoute(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (request.method !== 'GET') return null;
  const logo = url.pathname.match(/^\/public\/branding\/([^/]+)\/logo\.png$/);
  if (logo) return publicLogo(env, decodeURIComponent(logo[1]));
  const one = url.pathname.match(/^\/public\/branding\/([^/]+)$/);
  return one ? publicBranding(env, decodeURIComponent(one[1]), url.searchParams.get('event')) : null;
}

export async function dispatchBrandingRoute(request: Request, env: Env, pathname: string): Promise<Response | null> {
  let match = pathname.match(/^\/organizations\/([^/]+)\/branding$/);
  if (match) {
    if (request.method === 'GET') return getBranding(request, env, match[1]);
    if (request.method === 'PUT') return setColors(request, env, match[1]);
    return null;
  }
  match = pathname.match(/^\/organizations\/([^/]+)\/branding\/logo$/);
  if (!match) return null;
  if (request.method === 'PUT') return setLogo(request, env, match[1]);
  if (request.method === 'DELETE') return removeLogo(request, env, match[1]);
  return null;
}
