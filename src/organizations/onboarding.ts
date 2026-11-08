// The console's "Aan de slag" card (ROADMAP: easy onboarding): how far an
// organization is, and its example menukaart added later.
//
//   GET  /organizations/:id/onboarding     (admin) → { menu, kassa, register }
//        menu: it has a product; kassa: a kassa device was ever paired;
//        register: it has a kassalade. One query.
//   POST /organizations/:id/example-menu   (admin, body { locale? }) → 201 { added: true }
//        the example menukaart (example-menu.ts), only into an org without
//        products and catalogs → else 409 menu_not_empty
import type { Env } from '../env';
import { json } from '../http';
import { errorJson } from '../errors';
import { extractCaller, requireOrgRole } from './auth';
import { exampleMenuRows, exampleMenuStatements } from './example-menu';
import { toLocale } from './locale';

export async function getOnboarding(request: Request, env: Env, orgId: string): Promise<Response> {
  const caller = extractCaller(request);
  if (!caller) return json({ error: 'Unauthorized' }, 401);
  if (!(await requireOrgRole(env, orgId, caller, ['admin']))) return json({ error: 'Forbidden' }, 403);
  const row = await env.DB.prepare(
    `SELECT
       EXISTS (SELECT 1 FROM products WHERE org_id = ?1) AS menu,
       EXISTS (SELECT 1 FROM device_pairings WHERE org_id = ?1 AND role = 'pos' AND claimed_at IS NOT NULL) AS kassa,
       EXISTS (SELECT 1 FROM registers WHERE org_id = ?1 AND archived_at IS NULL) AS register`
  )
    .bind(orgId)
    .first<{ menu: number; kassa: number; register: number }>();
  return json({ menu: !!row?.menu, kassa: !!row?.kassa, register: !!row?.register });
}

export async function addExampleMenu(request: Request, env: Env, orgId: string): Promise<Response> {
  const caller = extractCaller(request);
  if (!caller) return json({ error: 'Unauthorized' }, 401);
  if (!(await requireOrgRole(env, orgId, caller, ['admin']))) return json({ error: 'Forbidden' }, 403);
  const body = (await request.json().catch(() => ({}))) as { locale?: unknown };
  const org = await env.DB.prepare('SELECT locale FROM organizations WHERE id = ?').bind(orgId).first<{ locale: string | null }>();
  const locale = toLocale(body.locale ?? org?.locale);
  const menu = exampleMenuRows(orgId, locale, new Date().toISOString());
  // The first INSERT checks "nothing there yet"; every later one only follows
  // its own first row - so two clicks at once give one menukaart (a batch is
  // one transaction), and a catalog of the org's own never meets a second default.
  const [first] = exampleMenuStatements(env.DB, menu, {
    sql: 'NOT EXISTS (SELECT 1 FROM products WHERE org_id = ?) AND NOT EXISTS (SELECT 1 FROM catalogs WHERE org_id = ?)',
    params: [orgId, orgId],
  });
  const followers = exampleMenuStatements(env.DB, menu, { sql: 'EXISTS (SELECT 1 FROM categories WHERE id = ?)', params: [menu.categories[0].id] }).slice(1);
  const [inserted] = await env.DB.batch([first, ...followers]);
  if ((inserted.meta.changes || 0) === 0) return errorJson('menu_not_empty', 409);
  return json({ added: true }, 201);
}
