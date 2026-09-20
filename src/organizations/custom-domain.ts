// Lets an org register its own custom domain (Branding settings), backed by
// Cloudflare's Custom Hostnames API (Cloudflare for SaaS) against the
// kaboutersoft.be zone. The org's admin creates a CNAME pointing at a
// single static target (arcanum.kaboutersoft.be, this app's own domain) —
// Cloudflare validates that CNAME (which doubles as domain-control
// validation for the cert, ssl.method: 'http').
//
// Getting a validated custom hostname's traffic to actually reach a Worker
// is a separate step from validation, and the zone's Fallback Origin alone
// does NOT do it: a Workers "Custom Domain" (what arcanum.kaboutersoft.be
// itself uses) only binds requests whose Host header exactly equals that
// domain, so a customer's own hostname never matches it — Cloudflare falls
// through to actually resolving the Fallback Origin as a real backend,
// which times out (522), since it's a Worker, not a real server.
//
// The kaboutersoft.be zone also hosts ~30 unrelated proxied subdomains
// (Cloudflare Tunnels, Pages sites, other Workers) — a zone-wide wildcard
// Workers Route (the common "recommended" fix) would intercept ALL of that
// traffic too, ahead of Tunnels/Pages routing, which is unacceptable here.
// Instead, every registered custom domain gets its OWN exact-hostname
// Workers Route (`<hostname>/*` → wrk-questo-bff), created alongside the
// Cloudflare custom hostname and deleted alongside it. An exact-hostname
// Route only ever matches that literal Host, so this can never affect any
// other subdomain on the zone — no wildcard, no shared blast radius.
//
// Deliberately does NOT yet change how an org is identified/routed by
// hostname — a custom domain today just makes the existing app (kassa,
// admin portal, ...) reachable under the org's own branding. An org still
// uses its slug-prefixed links for a specific identity provider exactly as
// before; recognizing an org by its custom domain (so a specific-IdP org
// could drop the slug too) is a deliberately separate, harder piece of
// work, not attempted here.
import type { Env } from '../env';
import { json } from '../http';
import { extractCaller, requireOrgRole } from './auth';
import type { OrganizationRow } from './types';

const CNAME_TARGET = 'arcanum.kaboutersoft.be';
const WORKER_SCRIPT_NAME = 'wrk-questo-bff';

// Conservative: lowercase letters/digits/hyphens per label, at least one dot,
// a 2+ letter TLD. Rejects anything Cloudflare would reject anyway, before
// spending an API call on it.
const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]+(-[a-z0-9]+)*\.)+[a-z]{2,63}$/;

interface CloudflareCustomHostname {
  id: string;
  hostname: string;
  status: string;
  ssl?: { status: string; validation_errors?: { message: string }[] };
  verification_errors?: string[];
}

interface CloudflareWorkerRoute {
  id: string;
  pattern: string;
  script: string;
}

interface CloudflareApiResponse<T> {
  success: boolean;
  result: T | null;
  errors: { message: string }[];
}

async function cfRequest<T>(
  env: Env,
  path: string,
  init: RequestInit = {}
): Promise<{ ok: boolean; body: CloudflareApiResponse<T> | null }> {
  const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${env.CLOUDFLARE_ZONE_ID}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
      'Content-Type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  const body = (await res.json().catch(() => null)) as CloudflareApiResponse<T> | null;
  return { ok: res.ok && Boolean(body?.success), body };
}

// Exact-hostname pattern only (`<hostname>/*`, never a wildcard host) — see
// the file header for why this is the whole safety story here.
async function createWorkerRoute(env: Env, hostname: string): Promise<string | null> {
  const { ok, body } = await cfRequest<CloudflareWorkerRoute>(env, '/workers/routes', {
    method: 'POST',
    body: JSON.stringify({ pattern: `${hostname}/*`, script: WORKER_SCRIPT_NAME }),
  });
  return ok && body?.result ? body.result.id : null;
}

async function deleteWorkerRoute(env: Env, routeId: string): Promise<void> {
  await cfRequest(env, `/workers/routes/${routeId}`, { method: 'DELETE' }).catch(() => {});
}

function rowToPublicCustomDomain(row: OrganizationRow) {
  return {
    customDomain: row.custom_domain,
    status: row.custom_domain_status,
    sslStatus: row.custom_domain_ssl_status,
    cnameTarget: CNAME_TARGET,
  };
}

function notConfigured(env: Env): boolean {
  return !env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ZONE_ID;
}

export async function getCustomDomain(request: Request, env: Env, orgId: string): Promise<Response> {
  const caller = extractCaller(request);
  if (!caller) return json({ error: 'Unauthorized' }, 401);
  const membership = await requireOrgRole(env, orgId, caller, ['admin']);
  if (!membership) return json({ error: 'Forbidden' }, 403);

  const row = await env.DB.prepare('SELECT * FROM organizations WHERE id = ?').bind(orgId).first<OrganizationRow>();
  if (!row) return json({ error: 'Unknown organization' }, 404);
  return json(rowToPublicCustomDomain(row));
}

export async function setCustomDomain(request: Request, env: Env, orgId: string): Promise<Response> {
  const caller = extractCaller(request);
  if (!caller) return json({ error: 'Unauthorized' }, 401);
  const membership = await requireOrgRole(env, orgId, caller, ['admin']);
  if (!membership) return json({ error: 'Forbidden' }, 403);

  if (notConfigured(env)) return json({ error: 'Custom domains are not configured on this platform' }, 501);

  const body = (await request.json().catch(() => ({}))) as { hostname?: string };
  const hostname = (body.hostname || '').trim().toLowerCase();
  if (!hostname || !HOSTNAME_RE.test(hostname)) {
    return json({ error: 'Vul een geldige domeinnaam in (bv. pos.mijnorganisatie.be)' }, 400);
  }

  const existing = await env.DB.prepare('SELECT * FROM organizations WHERE id = ?').bind(orgId).first<OrganizationRow>();
  if (!existing) return json({ error: 'Unknown organization' }, 404);

  // Re-submitting the exact hostname that's already registered — nothing to
  // do, just report current status (use Verify to refresh it).
  if (existing.custom_domain === hostname && existing.custom_domain_cf_id) {
    return json(rowToPublicCustomDomain(existing));
  }

  const clash = await env.DB.prepare('SELECT id FROM organizations WHERE custom_domain = ? AND id != ?').bind(hostname, orgId).first();
  if (clash) return json({ error: 'Dit domein is al in gebruik door een andere organisatie' }, 409);

  // Changing domains: Cloudflare has no "edit hostname" — remove the old
  // registration (and its route) first. Best-effort; a failure here (e.g.
  // already gone) shouldn't block registering the new one.
  if (existing.custom_domain_cf_id && existing.custom_domain !== hostname) {
    await cfRequest(env, `/custom_hostnames/${existing.custom_domain_cf_id}`, { method: 'DELETE' }).catch(() => {});
    if (existing.custom_domain_route_id) await deleteWorkerRoute(env, existing.custom_domain_route_id);
  }

  const { ok, body: cfBody } = await cfRequest<CloudflareCustomHostname>(env, '/custom_hostnames', {
    method: 'POST',
    body: JSON.stringify({ hostname, ssl: { method: 'http', type: 'dv' } }),
  });

  if (!ok || !cfBody?.result) {
    const message = cfBody?.errors?.[0]?.message || 'Kon domein niet registreren bij Cloudflare';
    return json({ error: message }, 502);
  }

  const cf = cfBody.result;

  // Without a matching route, this hostname would validate fine but every
  // request to it would 522 forever — treat route creation as required, not
  // best-effort, and roll back the just-created hostname if it fails.
  const routeId = await createWorkerRoute(env, hostname);
  if (!routeId) {
    await cfRequest(env, `/custom_hostnames/${cf.id}`, { method: 'DELETE' }).catch(() => {});
    return json({ error: 'Kon geen routing instellen voor dit domein bij Cloudflare' }, 502);
  }

  await env.DB.prepare(
    'UPDATE organizations SET custom_domain = ?, custom_domain_cf_id = ?, custom_domain_route_id = ?, custom_domain_status = ?, custom_domain_ssl_status = ? WHERE id = ?'
  )
    .bind(hostname, cf.id, routeId, cf.status, cf.ssl?.status ?? null, orgId)
    .run();

  const row = await env.DB.prepare('SELECT * FROM organizations WHERE id = ?').bind(orgId).first<OrganizationRow>();
  return json(rowToPublicCustomDomain(row!));
}

export async function verifyCustomDomain(request: Request, env: Env, orgId: string): Promise<Response> {
  const caller = extractCaller(request);
  if (!caller) return json({ error: 'Unauthorized' }, 401);
  const membership = await requireOrgRole(env, orgId, caller, ['admin']);
  if (!membership) return json({ error: 'Forbidden' }, 403);

  if (notConfigured(env)) return json({ error: 'Custom domains are not configured on this platform' }, 501);

  const row = await env.DB.prepare('SELECT * FROM organizations WHERE id = ?').bind(orgId).first<OrganizationRow>();
  if (!row) return json({ error: 'Unknown organization' }, 404);
  if (!row.custom_domain_cf_id) return json({ error: 'No custom domain configured' }, 404);

  const { ok, body: cfBody } = await cfRequest<CloudflareCustomHostname>(env, `/custom_hostnames/${row.custom_domain_cf_id}`);
  if (!ok || !cfBody?.result) {
    const message = cfBody?.errors?.[0]?.message || 'Kon status niet ophalen bij Cloudflare';
    return json({ error: message }, 502);
  }

  const cf = cfBody.result;
  await env.DB.prepare('UPDATE organizations SET custom_domain_status = ?, custom_domain_ssl_status = ? WHERE id = ?')
    .bind(cf.status, cf.ssl?.status ?? null, orgId)
    .run();

  const updated = await env.DB.prepare('SELECT * FROM organizations WHERE id = ?').bind(orgId).first<OrganizationRow>();
  return json({
    ...rowToPublicCustomDomain(updated!),
    verificationErrors: cf.verification_errors ?? [],
    sslValidationErrors: (cf.ssl?.validation_errors ?? []).map((e) => e.message),
  });
}

export async function removeCustomDomain(request: Request, env: Env, orgId: string): Promise<Response> {
  const caller = extractCaller(request);
  if (!caller) return json({ error: 'Unauthorized' }, 401);
  const membership = await requireOrgRole(env, orgId, caller, ['admin']);
  if (!membership) return json({ error: 'Forbidden' }, 403);

  const row = await env.DB.prepare('SELECT * FROM organizations WHERE id = ?').bind(orgId).first<OrganizationRow>();
  if (!row) return json({ error: 'Unknown organization' }, 404);

  if (!notConfigured(env)) {
    // Best-effort — clear our own state regardless, so an admin is never
    // stuck because Cloudflare's side (e.g. already removed) disagrees.
    if (row.custom_domain_cf_id) {
      await cfRequest(env, `/custom_hostnames/${row.custom_domain_cf_id}`, { method: 'DELETE' }).catch(() => {});
    }
    if (row.custom_domain_route_id) await deleteWorkerRoute(env, row.custom_domain_route_id);
  }

  await env.DB.prepare(
    'UPDATE organizations SET custom_domain = NULL, custom_domain_cf_id = NULL, custom_domain_route_id = NULL, custom_domain_status = NULL, custom_domain_ssl_status = NULL WHERE id = ?'
  )
    .bind(orgId)
    .run();

  return json({ ok: true });
}
