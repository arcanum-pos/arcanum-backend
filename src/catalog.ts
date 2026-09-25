// Catalogs — step 3a (DOMAIN_MODEL.md "Build order" / "Step 3 decisions").
//
//   categories ──< products ──< product_variants       (org-level, shared)
//   prep_stations ──< products                          (who prepares it)
//   catalogs ──< catalog_sections ──< catalog_entries  (variant + price + position + visible)
//
// Products and variants are defined once per org; the price lives on the
// catalog entry, so the same product can be priced differently per catalog
// and a new season is just "duplicate + edit". Products/variants are
// archived, never deleted (order_lines reference variants); entries and
// sections can be deleted freely since every order line copies name/price
// in at sale time.
//
// Exactly one default catalog per org (idx_catalogs_one_default) — what a
// kassa sells from unless its device picks another one. Reads are open to
// any member (a kassa/cashier needs them); every write is admin-only.
import type { Env } from './env';
import { json } from './http';
import { extractCaller, requireOrgRole } from './organizations/auth';
import { jsonRowsStatement, present } from './sql-json';

// --- Rows ---

interface CategoryRow {
  id: string;
  name: string;
  position: number;
}

interface ProductRow {
  id: string;
  category_id: string | null;
  prep_station_id: string | null;
  name: string;
  vat_rate_bp: number | null;
  archived_at: string | null;
}

interface VariantRow {
  id: string;
  product_id: string;
  name: string;
  code: string | null;
  position: number;
  archived_at: string | null;
}

interface CatalogRow {
  id: string;
  name: string;
  is_default: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

interface SectionRow {
  id: string;
  name: string;
  position: number;
}

interface EntryRow {
  id: string;
  section_id: string;
  variant_id: string;
  price_cents: number;
  visible: number;
  position: number;
  quick_quantities: string | null;
  variant_name: string;
  code: string | null;
  variant_archived_at: string | null;
  product_id: string;
  product_name: string;
  product_archived_at: string | null;
  category_id: string | null;
  category_name: string | null;
}

const ENTRY_SELECT = `SELECT e.id, e.section_id, e.variant_id, e.price_cents, e.visible, e.position, e.quick_quantities,
    v.name AS variant_name, v.code, v.archived_at AS variant_archived_at,
    p.id AS product_id, p.name AS product_name, p.archived_at AS product_archived_at,
    c.id AS category_id, c.name AS category_name
  FROM catalog_entries e
  JOIN product_variants v ON v.id = e.variant_id
  JOIN products p ON p.id = v.product_id
  LEFT JOIN categories c ON c.id = p.category_id`;

// Shared with tabs.ts, which copies it into order_lines.name at sale time.
export function displayName(productName: string, variantName: string): string {
  return variantName ? `${productName} (${variantName})` : productName;
}

function parseQuick(raw: string | null): number[] | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function toCategory(row: CategoryRow) {
  return { id: row.id, name: row.name, position: row.position };
}

function toVariant(row: VariantRow) {
  return { id: row.id, name: row.name, code: row.code, position: row.position, archived: !!row.archived_at };
}

function toProduct(row: ProductRow, variants: VariantRow[]) {
  return {
    id: row.id,
    name: row.name,
    categoryId: row.category_id,
    prepStationId: row.prep_station_id,
    vatRateBp: row.vat_rate_bp,
    archived: !!row.archived_at,
    variants: variants.filter((v) => v.product_id === row.id).map(toVariant),
  };
}

function toCatalogSummary(row: CatalogRow & { entry_count?: number }) {
  return {
    id: row.id,
    name: row.name,
    isDefault: !!row.is_default,
    archived: !!row.archived_at,
    entryCount: row.entry_count ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toEntry(row: EntryRow) {
  return {
    id: row.id,
    sectionId: row.section_id,
    variantId: row.variant_id,
    productId: row.product_id,
    productName: row.product_name,
    variantName: row.variant_name,
    displayName: displayName(row.product_name, row.variant_name),
    code: row.code,
    categoryId: row.category_id,
    categoryName: row.category_name,
    priceCents: row.price_cents,
    visible: !!row.visible,
    position: row.position,
    quickQuantities: parseQuick(row.quick_quantities),
    // False once the product or variant is archived — it then stays listed
    // in the admin view (so it can be removed) but the kassa never shows it.
    sellable: !row.variant_archived_at && !row.product_archived_at,
  };
}

// --- Input validation ---

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function parseName(raw: unknown, max: number, field = 'name'): Parsed<string> {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value || value.length > max) return { ok: false, error: `${field} is required (max ${max} characters)` };
  return { ok: true, value };
}

function parseOptionalText(raw: unknown, max: number, field: string): Parsed<string | null> {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: null };
  if (typeof raw !== 'string' || raw.trim().length > max) return { ok: false, error: `${field} must be text (max ${max} characters)` };
  return { ok: true, value: raw.trim() || null };
}

function parseVat(raw: unknown): Parsed<number | null> {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 10000) return { ok: false, error: 'vatRateBp must be an integer between 0 and 10000 (basis points)' };
  return { ok: true, value: n };
}

function parsePrice(raw: unknown): Parsed<number> {
  const n = Number(raw);
  if (raw === undefined || raw === null || !Number.isInteger(n) || n < 0 || n > 1_000_000) {
    return { ok: false, error: 'priceCents must be an integer between 0 and 1000000' };
  }
  return { ok: true, value: n };
}

function parseQuickQuantities(raw: unknown): Parsed<number[] | null> {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 10 || !raw.every((n) => Number.isInteger(n) && n >= 1 && n <= 999)) {
    return { ok: false, error: 'quickQuantities must be 1–10 integers between 1 and 999, or null' };
  }
  return { ok: true, value: raw as number[] };
}

function isUniqueViolation(err: unknown, indexColumns: RegExp): boolean {
  const message = (err as Error)?.message || '';
  return /UNIQUE constraint failed/i.test(message) && indexColumns.test(message);
}

const VARIANT_CODE_CONFLICT = /product_variants\.(org_id|code)/;
const ENTRY_VARIANT_CONFLICT = /catalog_entries\.(catalog_id|variant_id)/;

async function readBody(request: Request): Promise<Record<string, unknown>> {
  return ((await request.json().catch(() => ({}))) || {}) as Record<string, unknown>;
}

const now = () => new Date().toISOString();

// --- Categories ---

async function listCategories(env: Env, orgId: string) {
  const { results } = await env.DB.prepare('SELECT id, name, position FROM categories WHERE org_id = ? ORDER BY position, created_at')
    .bind(orgId)
    .all<CategoryRow>();
  return json((results || []).map(toCategory));
}

async function createCategory(request: Request, env: Env, orgId: string) {
  const name = parseName((await readBody(request)).name, 60);
  if (!name.ok) return json({ error: name.error }, 400);
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO categories (id, org_id, name, position, created_at)
     SELECT ?, ?, ?, COALESCE((SELECT MAX(position) + 1 FROM categories WHERE org_id = ?), 0), ?`
  )
    .bind(id, orgId, name.value, orgId, now())
    .run();
  const row = await env.DB.prepare('SELECT id, name, position FROM categories WHERE id = ?').bind(id).first<CategoryRow>();
  return json(toCategory(row!), 201);
}

async function updateCategory(request: Request, env: Env, orgId: string, categoryId: string) {
  const body = await readBody(request);
  const existing = await env.DB.prepare('SELECT id, name, position FROM categories WHERE id = ? AND org_id = ?').bind(categoryId, orgId).first<CategoryRow>();
  if (!existing) return json({ error: 'Categorie niet gevonden' }, 404);

  let name = existing.name;
  if (body.name !== undefined) {
    const parsed = parseName(body.name, 60);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    name = parsed.value;
  }
  let position = existing.position;
  if (body.position !== undefined) {
    if (!Number.isInteger(body.position)) return json({ error: 'position must be an integer' }, 400);
    position = body.position as number;
  }
  await env.DB.prepare('UPDATE categories SET name = ?, position = ? WHERE id = ?').bind(name, position, categoryId).run();
  return json(toCategory({ id: categoryId, name, position }));
}

async function deleteCategory(env: Env, orgId: string, categoryId: string) {
  const result = await env.DB.prepare('DELETE FROM categories WHERE id = ? AND org_id = ? AND NOT EXISTS (SELECT 1 FROM products WHERE category_id = ?)')
    .bind(categoryId, orgId, categoryId)
    .run();
  if ((result.meta.changes || 0) > 0) return json({ ok: true });
  const exists = await env.DB.prepare('SELECT 1 FROM categories WHERE id = ? AND org_id = ?').bind(categoryId, orgId).first();
  return exists ? json({ error: 'Deze categorie wordt nog gebruikt door producten' }, 409) : json({ error: 'Categorie niet gevonden' }, 404);
}

// --- Prep stations ---
// Who prepares a product (Bar, Keuken, …). Names are unique per org,
// case-insensitively (idx_prep_stations_org_name).

const STATION_NAME_CONFLICT = /prep_stations\.(org_id|name)|idx_prep_stations_org_name|lower\(name\)/;

async function listStations(env: Env, orgId: string) {
  const { results } = await env.DB.prepare('SELECT id, name, position FROM prep_stations WHERE org_id = ? ORDER BY position, created_at')
    .bind(orgId)
    .all<CategoryRow>();
  return json((results || []).map(toCategory));
}

async function createStation(request: Request, env: Env, orgId: string) {
  const name = parseName((await readBody(request)).name, 60);
  if (!name.ok) return json({ error: name.error }, 400);
  const id = crypto.randomUUID();
  try {
    await env.DB.prepare(
      `INSERT INTO prep_stations (id, org_id, name, position, created_at)
       SELECT ?, ?, ?, COALESCE((SELECT MAX(position) + 1 FROM prep_stations WHERE org_id = ?), 0), ?`
    )
      .bind(id, orgId, name.value, orgId, now())
      .run();
  } catch (err) {
    if (isUniqueViolation(err, STATION_NAME_CONFLICT)) return json({ error: 'Er bestaat al een station met die naam' }, 409);
    throw err;
  }
  const row = await env.DB.prepare('SELECT id, name, position FROM prep_stations WHERE id = ?').bind(id).first<CategoryRow>();
  return json(toCategory(row!), 201);
}

async function updateStation(request: Request, env: Env, orgId: string, stationId: string) {
  const body = await readBody(request);
  const existing = await env.DB.prepare('SELECT id, name, position FROM prep_stations WHERE id = ? AND org_id = ?').bind(stationId, orgId).first<CategoryRow>();
  if (!existing) return json({ error: 'Station niet gevonden' }, 404);

  let name = existing.name;
  if (body.name !== undefined) {
    const parsed = parseName(body.name, 60);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    name = parsed.value;
  }
  let position = existing.position;
  if (body.position !== undefined) {
    if (!Number.isInteger(body.position)) return json({ error: 'position must be an integer' }, 400);
    position = body.position as number;
  }
  try {
    await env.DB.prepare('UPDATE prep_stations SET name = ?, position = ? WHERE id = ?').bind(name, position, stationId).run();
  } catch (err) {
    if (isUniqueViolation(err, STATION_NAME_CONFLICT)) return json({ error: 'Er bestaat al een station met die naam' }, 409);
    throw err;
  }
  return json(toCategory({ id: stationId, name, position }));
}

async function deleteStation(env: Env, orgId: string, stationId: string) {
  const result = await env.DB.prepare('DELETE FROM prep_stations WHERE id = ? AND org_id = ? AND NOT EXISTS (SELECT 1 FROM products WHERE prep_station_id = ?)')
    .bind(stationId, orgId, stationId)
    .run();
  if ((result.meta.changes || 0) > 0) return json({ ok: true });
  const exists = await env.DB.prepare('SELECT 1 FROM prep_stations WHERE id = ? AND org_id = ?').bind(stationId, orgId).first();
  return exists ? json({ error: 'Dit station wordt nog gebruikt door producten' }, 409) : json({ error: 'Station niet gevonden' }, 404);
}

async function stationBelongsToOrg(env: Env, orgId: string, stationId: string | null): Promise<boolean> {
  if (!stationId) return true;
  return !!(await env.DB.prepare('SELECT 1 FROM prep_stations WHERE id = ? AND org_id = ?').bind(stationId, orgId).first());
}

// --- Products & variants ---

async function categoryBelongsToOrg(env: Env, orgId: string, categoryId: string | null): Promise<boolean> {
  if (!categoryId) return true;
  return !!(await env.DB.prepare('SELECT 1 FROM categories WHERE id = ? AND org_id = ?').bind(categoryId, orgId).first());
}

async function loadProduct(env: Env, orgId: string, productId: string) {
  const row = await env.DB.prepare('SELECT id, category_id, prep_station_id, name, vat_rate_bp, archived_at FROM products WHERE id = ? AND org_id = ?')
    .bind(productId, orgId)
    .first<ProductRow>();
  if (!row) return null;
  const { results } = await env.DB.prepare(
    'SELECT id, product_id, name, code, position, archived_at FROM product_variants WHERE product_id = ? ORDER BY position, created_at'
  )
    .bind(productId)
    .all<VariantRow>();
  return toProduct(row, results || []);
}

async function listProducts(request: Request, env: Env, orgId: string) {
  const includeArchived = new URL(request.url).searchParams.has('includeArchived');
  const [products, variants] = await env.DB.batch([
    env.DB.prepare(
      `SELECT id, category_id, prep_station_id, name, vat_rate_bp, archived_at FROM products WHERE org_id = ? ${includeArchived ? '' : 'AND archived_at IS NULL'} ORDER BY name`
    ).bind(orgId),
    env.DB.prepare('SELECT id, product_id, name, code, position, archived_at FROM product_variants WHERE org_id = ? ORDER BY position, created_at').bind(orgId),
  ]);
  const variantRows = (variants.results || []) as VariantRow[];
  return json(((products.results || []) as ProductRow[]).map((p) => toProduct(p, variantRows)));
}

interface VariantInput {
  name: string;
  code: string | null;
}

function parseVariant(raw: unknown): Parsed<VariantInput> {
  const item = (raw || {}) as Record<string, unknown>;
  const name = typeof item.name === 'string' ? item.name.trim() : '';
  if (name.length > 60) return { ok: false, error: 'variant name max 60 characters' };
  const code = parseOptionalText(item.code, 40, 'code');
  if (!code.ok) return code;
  return { ok: true, value: { name, code: code.value } };
}

async function createProduct(request: Request, env: Env, orgId: string) {
  const body = await readBody(request);
  const name = parseName(body.name, 100);
  if (!name.ok) return json({ error: name.error }, 400);
  const vat = parseVat(body.vatRateBp);
  if (!vat.ok) return json({ error: vat.error }, 400);
  const categoryId = body.categoryId ? String(body.categoryId) : null;
  if (!(await categoryBelongsToOrg(env, orgId, categoryId))) return json({ error: 'Onbekende categorie' }, 400);
  const prepStationId = body.prepStationId ? String(body.prepStationId) : null;
  if (!(await stationBelongsToOrg(env, orgId, prepStationId))) return json({ error: 'Onbekend station' }, 400);

  // Every product has at least one variant; a single-version product gets
  // one with an empty name.
  const rawVariants = Array.isArray(body.variants) && body.variants.length > 0 ? body.variants : [{ name: '' }];
  if (rawVariants.length > 20) return json({ error: 'at most 20 variants' }, 400);
  const variants: VariantInput[] = [];
  for (const raw of rawVariants) {
    const parsed = parseVariant(raw);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    variants.push(parsed.value);
  }

  const productId = crypto.randomUUID();
  const createdAt = now();
  try {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO products (id, org_id, category_id, prep_station_id, name, vat_rate_bp, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(
        productId,
        orgId,
        categoryId,
        prepStationId,
        name.value,
        vat.value,
        createdAt
      ),
      ...variants.map((v, i) =>
        env.DB.prepare('INSERT INTO product_variants (id, org_id, product_id, name, code, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(
          crypto.randomUUID(),
          orgId,
          productId,
          v.name,
          v.code,
          i,
          createdAt
        )
      ),
    ]);
  } catch (err) {
    if (isUniqueViolation(err, VARIANT_CODE_CONFLICT)) return json({ error: 'Deze code wordt al gebruikt' }, 409);
    throw err;
  }
  return json(await loadProduct(env, orgId, productId), 201);
}

async function updateProduct(request: Request, env: Env, orgId: string, productId: string) {
  const body = await readBody(request);
  const existing = await env.DB.prepare('SELECT id, category_id, prep_station_id, name, vat_rate_bp, archived_at FROM products WHERE id = ? AND org_id = ?')
    .bind(productId, orgId)
    .first<ProductRow>();
  if (!existing) return json({ error: 'Product niet gevonden' }, 404);

  let { name, category_id: categoryId, prep_station_id: prepStationId, vat_rate_bp: vatRateBp, archived_at: archivedAt } = existing;
  if (body.name !== undefined) {
    const parsed = parseName(body.name, 100);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    name = parsed.value;
  }
  if (body.categoryId !== undefined) {
    categoryId = body.categoryId ? String(body.categoryId) : null;
    if (!(await categoryBelongsToOrg(env, orgId, categoryId))) return json({ error: 'Onbekende categorie' }, 400);
  }
  if (body.prepStationId !== undefined) {
    prepStationId = body.prepStationId ? String(body.prepStationId) : null;
    if (!(await stationBelongsToOrg(env, orgId, prepStationId))) return json({ error: 'Onbekend station' }, 400);
  }
  if (body.vatRateBp !== undefined) {
    const parsed = parseVat(body.vatRateBp);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    vatRateBp = parsed.value;
  }
  if (body.archived !== undefined) archivedAt = body.archived ? archivedAt || now() : null;

  const statements = [
    env.DB.prepare('UPDATE products SET name = ?, category_id = ?, prep_station_id = ?, vat_rate_bp = ?, archived_at = ? WHERE id = ?').bind(
      name,
      categoryId,
      prepStationId,
      vatRateBp,
      archivedAt,
      productId
    ),
  ];
  // Archiving a product archives its active variants with the same
  // timestamp (which frees their codes for reuse); unarchiving restores
  // exactly those, not variants that were archived on their own earlier.
  if (archivedAt && !existing.archived_at) {
    statements.push(env.DB.prepare('UPDATE product_variants SET archived_at = ? WHERE product_id = ? AND archived_at IS NULL').bind(archivedAt, productId));
  } else if (!archivedAt && existing.archived_at) {
    statements.push(env.DB.prepare('UPDATE product_variants SET archived_at = NULL WHERE product_id = ? AND archived_at = ?').bind(productId, existing.archived_at));
  }
  try {
    await env.DB.batch(statements);
  } catch (err) {
    if (isUniqueViolation(err, VARIANT_CODE_CONFLICT)) return json({ error: 'Een code van dit product wordt intussen door een ander product gebruikt' }, 409);
    throw err;
  }
  return json(await loadProduct(env, orgId, productId));
}

async function createVariant(request: Request, env: Env, orgId: string, productId: string) {
  const parsed = parseVariant(await readBody(request));
  if (!parsed.ok) return json({ error: parsed.error }, 400);
  if (!(await env.DB.prepare('SELECT 1 FROM products WHERE id = ? AND org_id = ?').bind(productId, orgId).first())) {
    return json({ error: 'Product niet gevonden' }, 404);
  }

  const id = crypto.randomUUID();
  try {
    await env.DB.prepare(
      `INSERT INTO product_variants (id, org_id, product_id, name, code, position, created_at)
       SELECT ?, ?, ?, ?, ?, COALESCE((SELECT MAX(position) + 1 FROM product_variants WHERE product_id = ?), 0), ?`
    )
      .bind(id, orgId, productId, parsed.value.name, parsed.value.code, productId, now())
      .run();
  } catch (err) {
    if (isUniqueViolation(err, VARIANT_CODE_CONFLICT)) return json({ error: 'Deze code wordt al gebruikt' }, 409);
    throw err;
  }
  const row = await env.DB.prepare('SELECT id, product_id, name, code, position, archived_at FROM product_variants WHERE id = ?').bind(id).first<VariantRow>();
  return json(toVariant(row!), 201);
}

async function updateVariant(request: Request, env: Env, orgId: string, variantId: string) {
  const body = await readBody(request);
  const existing = await env.DB.prepare('SELECT id, product_id, name, code, position, archived_at FROM product_variants WHERE id = ? AND org_id = ?')
    .bind(variantId, orgId)
    .first<VariantRow>();
  if (!existing) return json({ error: 'Variant niet gevonden' }, 404);

  let { name, code, position } = existing;
  if (body.name !== undefined || body.code !== undefined) {
    const parsed = parseVariant({ name: body.name ?? existing.name, code: body.code !== undefined ? body.code : existing.code });
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    ({ name, code } = parsed.value);
  }
  if (body.position !== undefined) {
    if (!Number.isInteger(body.position)) return json({ error: 'position must be an integer' }, 400);
    position = body.position as number;
  }

  const statements = [
    env.DB.prepare('UPDATE product_variants SET name = ?, code = ?, position = ? WHERE id = ?').bind(name, code, position, variantId),
  ];
  if (body.archived === false) statements.push(env.DB.prepare('UPDATE product_variants SET archived_at = NULL WHERE id = ?').bind(variantId));

  try {
    await env.DB.batch(statements);
  } catch (err) {
    if (isUniqueViolation(err, VARIANT_CODE_CONFLICT)) return json({ error: 'Deze code wordt al gebruikt' }, 409);
    throw err;
  }

  // Archiving is conditional in SQL: a product always keeps >= 1 active variant.
  if (body.archived === true && !existing.archived_at) {
    const result = await env.DB.prepare(
      `UPDATE product_variants SET archived_at = ? WHERE id = ? AND archived_at IS NULL
         AND (SELECT COUNT(*) FROM product_variants o WHERE o.product_id = product_variants.product_id AND o.archived_at IS NULL) > 1`
    )
      .bind(now(), variantId)
      .run();
    if ((result.meta.changes || 0) === 0) {
      return json({ error: 'Een product heeft minstens één actieve variant nodig — archiveer dan het product' }, 409);
    }
  }

  const row = await env.DB.prepare('SELECT id, product_id, name, code, position, archived_at FROM product_variants WHERE id = ?').bind(variantId).first<VariantRow>();
  return json(toVariant(row!));
}

// --- Catalogs ---

async function loadCatalogRow(env: Env, orgId: string, catalogId: string) {
  return env.DB.prepare('SELECT id, name, is_default, archived_at, created_at, updated_at FROM catalogs WHERE id = ? AND org_id = ?')
    .bind(catalogId, orgId)
    .first<CatalogRow>();
}

function touch(env: Env, catalogId: string) {
  return env.DB.prepare('UPDATE catalogs SET updated_at = ? WHERE id = ?').bind(now(), catalogId);
}

async function loadCatalogDetail(env: Env, orgId: string, catalogId: string) {
  const row = await loadCatalogRow(env, orgId, catalogId);
  if (!row) return null;
  const [sections, entries] = await env.DB.batch([
    env.DB.prepare('SELECT id, name, position FROM catalog_sections WHERE catalog_id = ? ORDER BY position, rowid').bind(catalogId),
    env.DB.prepare(`${ENTRY_SELECT} WHERE e.catalog_id = ? ORDER BY e.position, e.rowid`).bind(catalogId),
  ]);
  const entryRows = (entries.results || []) as EntryRow[];
  return {
    ...toCatalogSummary({ ...row, entry_count: entryRows.length }),
    sections: ((sections.results || []) as SectionRow[]).map((s) => ({
      id: s.id,
      name: s.name,
      position: s.position,
      entries: entryRows.filter((e) => e.section_id === s.id).map(toEntry),
    })),
  };
}

async function listCatalogs(env: Env, orgId: string) {
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.name, c.is_default, c.archived_at, c.created_at, c.updated_at,
       (SELECT COUNT(*) FROM catalog_entries e WHERE e.catalog_id = c.id) AS entry_count
     FROM catalogs c WHERE c.org_id = ? AND c.archived_at IS NULL ORDER BY c.is_default DESC, c.name`
  )
    .bind(orgId)
    .all<CatalogRow & { entry_count: number }>();
  return json((results || []).map(toCatalogSummary));
}

async function createCatalog(request: Request, env: Env, orgId: string) {
  const name = parseName((await readBody(request)).name, 60);
  if (!name.ok) return json({ error: name.error }, 400);
  const id = crypto.randomUUID();
  const t = now();
  // An org's first catalog becomes its default — decided inside the one
  // INSERT, so two concurrent first creates can't both claim it.
  await env.DB.prepare(
    `INSERT INTO catalogs (id, org_id, name, is_default, created_at, updated_at)
     SELECT ?, ?, ?, CASE WHEN EXISTS (SELECT 1 FROM catalogs WHERE org_id = ? AND is_default = 1) THEN 0 ELSE 1 END, ?, ?`
  )
    .bind(id, orgId, name.value, orgId, t, t)
    .run();
  return json(await loadCatalogDetail(env, orgId, id), 201);
}

async function renameCatalog(request: Request, env: Env, orgId: string, catalogId: string) {
  const name = parseName((await readBody(request)).name, 60);
  if (!name.ok) return json({ error: name.error }, 400);
  const result = await env.DB.prepare('UPDATE catalogs SET name = ?, updated_at = ? WHERE id = ? AND org_id = ?').bind(name.value, now(), catalogId, orgId).run();
  if ((result.meta.changes || 0) === 0) return json({ error: 'Menukaart niet gevonden' }, 404);
  return json(await loadCatalogDetail(env, orgId, catalogId));
}

async function setDefaultCatalog(env: Env, orgId: string, catalogId: string) {
  const row = await loadCatalogRow(env, orgId, catalogId);
  if (!row || row.archived_at) return json({ error: 'Menukaart niet gevonden' }, 404);
  // One transaction: clear the old default, set the new one.
  await env.DB.batch([
    env.DB.prepare('UPDATE catalogs SET is_default = 0 WHERE org_id = ? AND is_default = 1 AND id != ?').bind(orgId, catalogId),
    env.DB.prepare('UPDATE catalogs SET is_default = 1, updated_at = ? WHERE id = ? AND archived_at IS NULL').bind(now(), catalogId),
  ]);
  return json(await loadCatalogDetail(env, orgId, catalogId));
}

async function archiveCatalog(env: Env, orgId: string, catalogId: string) {
  const result = await env.DB.prepare('UPDATE catalogs SET archived_at = ?, updated_at = ? WHERE id = ? AND org_id = ? AND is_default = 0 AND archived_at IS NULL')
    .bind(now(), now(), catalogId, orgId)
    .run();
  if ((result.meta.changes || 0) > 0) return json({ ok: true });
  const row = await loadCatalogRow(env, orgId, catalogId);
  if (!row || row.archived_at) return json({ error: 'Menukaart niet gevonden' }, 404);
  return json({ error: 'De standaardmenukaart kan niet gearchiveerd worden — maak eerst een andere standaard' }, 409);
}

async function duplicateCatalog(request: Request, env: Env, orgId: string, catalogId: string) {
  const source = await loadCatalogRow(env, orgId, catalogId);
  if (!source) return json({ error: 'Menukaart niet gevonden' }, 404);
  const body = await readBody(request);
  const name = parseName(body.name ?? `${source.name} (kopie)`, 60);
  if (!name.ok) return json({ error: name.error }, 400);

  const [sections, entries] = await env.DB.batch([
    env.DB.prepare('SELECT id, name, position FROM catalog_sections WHERE catalog_id = ?').bind(catalogId),
    env.DB.prepare('SELECT id, section_id, variant_id, price_cents, visible, position, quick_quantities FROM catalog_entries WHERE catalog_id = ?').bind(catalogId),
  ]);

  const id = crypto.randomUUID();
  const t = now();
  const sectionIds = new Map<string, string>();
  const sectionRows = ((sections.results || []) as SectionRow[]).map((s) => {
    const newId = crypto.randomUUID();
    sectionIds.set(s.id, newId);
    return { id: newId, org_id: orgId, catalog_id: id, name: s.name, position: s.position };
  });
  const entryRows = ((entries.results || []) as EntryRow[]).map((e) => ({
    id: crypto.randomUUID(),
    org_id: orgId,
    catalog_id: id,
    section_id: sectionIds.get(e.section_id)!,
    variant_id: e.variant_id,
    price_cents: e.price_cents,
    visible: e.visible,
    position: e.position,
    quick_quantities: e.quick_quantities,
  }));
  // One statement per table, however big the menukaart (Free-plan D1 limit, see sql-json.ts).
  await env.DB.batch(
    present([
      env.DB.prepare('INSERT INTO catalogs (id, org_id, name, is_default, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)').bind(id, orgId, name.value, t, t),
      jsonRowsStatement(env.DB, 'catalog_sections', ['id', 'org_id', 'catalog_id', 'name', 'position'], sectionRows),
      jsonRowsStatement(
        env.DB,
        'catalog_entries',
        ['id', 'org_id', 'catalog_id', 'section_id', 'variant_id', 'price_cents', 'visible', 'position', 'quick_quantities'],
        entryRows
      ),
    ])
  );
  return json(await loadCatalogDetail(env, orgId, id), 201);
}

// PUT /catalogs/:id/layout { sections: [{ id, entryIds: [...] }] } — the
// complete new order of sections and of entries within them (entries may
// move between sections). Must name every section and entry exactly once,
// so a stale editor can't silently drop or duplicate anything.
async function setLayout(request: Request, env: Env, orgId: string, catalogId: string) {
  if (!(await loadCatalogRow(env, orgId, catalogId))) return json({ error: 'Menukaart niet gevonden' }, 404);
  const body = await readBody(request);
  const layout = Array.isArray(body.sections) ? (body.sections as { id?: unknown; entryIds?: unknown }[]) : null;
  if (!layout || !layout.every((s) => typeof s?.id === 'string' && Array.isArray(s.entryIds) && s.entryIds.every((e) => typeof e === 'string'))) {
    return json({ error: 'sections must be [{ id, entryIds: [] }]' }, 400);
  }

  const [sections, entries] = await env.DB.batch([
    env.DB.prepare('SELECT id, org_id, catalog_id, name, position FROM catalog_sections WHERE catalog_id = ?').bind(catalogId),
    env.DB.prepare(
      'SELECT id, org_id, catalog_id, section_id, variant_id, price_cents, visible, position, quick_quantities FROM catalog_entries WHERE catalog_id = ?'
    ).bind(catalogId),
  ]);
  const sameSet = (given: string[], actual: { id: string }[]) =>
    given.length === actual.length && new Set(given).size === given.length && actual.every((row) => given.includes(row.id));

  const givenSections = layout.map((s) => s.id as string);
  const givenEntries = layout.flatMap((s) => s.entryIds as string[]);
  if (!sameSet(givenSections, (sections.results || []) as { id: string }[]) || !sameSet(givenEntries, (entries.results || []) as { id: string }[])) {
    return json({ error: 'De indeling is intussen gewijzigd — herlaad en probeer opnieuw' }, 400);
  }

  // Rewritten as two upserts (full rows, only position/section changing) —
  // one statement per table instead of one per section and entry.
  const sectionById = new Map(((sections.results || []) as Record<string, unknown>[]).map((r) => [r.id as string, r]));
  const entryById = new Map(((entries.results || []) as Record<string, unknown>[]).map((r) => [r.id as string, r]));
  const sectionRows = layout.map((s, sectionIndex) => ({ ...sectionById.get(s.id as string)!, position: sectionIndex }));
  const entryRows = layout.flatMap((s) =>
    (s.entryIds as string[]).map((entryId, entryIndex) => ({ ...entryById.get(entryId)!, section_id: s.id as string, position: entryIndex }))
  );
  await env.DB.batch(
    present([
      jsonRowsStatement(env.DB, 'catalog_sections', ['id', 'org_id', 'catalog_id', 'name', 'position'], sectionRows, {
        upsert: { conflict: 'id', update: ['position'] },
      }),
      jsonRowsStatement(
        env.DB,
        'catalog_entries',
        ['id', 'org_id', 'catalog_id', 'section_id', 'variant_id', 'price_cents', 'visible', 'position', 'quick_quantities'],
        entryRows,
        { upsert: { conflict: 'id', update: ['section_id', 'position'] } }
      ),
      touch(env, catalogId),
    ])
  );
  return json(await loadCatalogDetail(env, orgId, catalogId));
}

// --- Sections ---

async function createSection(request: Request, env: Env, orgId: string, catalogId: string) {
  if (!(await loadCatalogRow(env, orgId, catalogId))) return json({ error: 'Menukaart niet gevonden' }, 404);
  const name = parseName((await readBody(request)).name, 60);
  if (!name.ok) return json({ error: name.error }, 400);
  const id = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO catalog_sections (id, org_id, catalog_id, name, position)
       SELECT ?, ?, ?, ?, COALESCE((SELECT MAX(position) + 1 FROM catalog_sections WHERE catalog_id = ?), 0)`
    ).bind(id, orgId, catalogId, name.value, catalogId),
    touch(env, catalogId),
  ]);
  const row = await env.DB.prepare('SELECT id, name, position FROM catalog_sections WHERE id = ?').bind(id).first<SectionRow>();
  return json({ ...row!, entries: [] }, 201);
}

async function renameSection(request: Request, env: Env, orgId: string, catalogId: string, sectionId: string) {
  const name = parseName((await readBody(request)).name, 60);
  if (!name.ok) return json({ error: name.error }, 400);
  const [result] = await env.DB.batch([
    env.DB.prepare('UPDATE catalog_sections SET name = ? WHERE id = ? AND catalog_id = ? AND org_id = ?').bind(name.value, sectionId, catalogId, orgId),
    touch(env, catalogId),
  ]);
  if ((result.meta.changes || 0) === 0) return json({ error: 'Groep niet gevonden' }, 404);
  return json({ ok: true });
}

async function deleteSection(env: Env, orgId: string, catalogId: string, sectionId: string) {
  if (!(await env.DB.prepare('SELECT 1 FROM catalog_sections WHERE id = ? AND catalog_id = ? AND org_id = ?').bind(sectionId, catalogId, orgId).first())) {
    return json({ error: 'Groep niet gevonden' }, 404);
  }
  await env.DB.batch([
    env.DB.prepare('DELETE FROM catalog_entries WHERE section_id = ?').bind(sectionId),
    env.DB.prepare('DELETE FROM catalog_sections WHERE id = ?').bind(sectionId),
    touch(env, catalogId),
  ]);
  return json({ ok: true });
}

// --- Entries ---

async function sectionInCatalog(env: Env, catalogId: string, sectionId: string): Promise<boolean> {
  return !!(await env.DB.prepare('SELECT 1 FROM catalog_sections WHERE id = ? AND catalog_id = ?').bind(sectionId, catalogId).first());
}

async function loadEntry(env: Env, entryId: string) {
  const row = await env.DB.prepare(`${ENTRY_SELECT} WHERE e.id = ?`).bind(entryId).first<EntryRow>();
  return row ? toEntry(row) : null;
}

async function createEntry(request: Request, env: Env, orgId: string, catalogId: string) {
  if (!(await loadCatalogRow(env, orgId, catalogId))) return json({ error: 'Menukaart niet gevonden' }, 404);
  const body = await readBody(request);
  const price = parsePrice(body.priceCents);
  if (!price.ok) return json({ error: price.error }, 400);
  const quick = parseQuickQuantities(body.quickQuantities);
  if (!quick.ok) return json({ error: quick.error }, 400);
  const sectionId = String(body.sectionId || '');
  const variantId = String(body.variantId || '');
  if (!(await sectionInCatalog(env, catalogId, sectionId))) return json({ error: 'Onbekende groep voor deze menukaart' }, 400);
  const variant = await env.DB.prepare(
    `SELECT 1 FROM product_variants v JOIN products p ON p.id = v.product_id
     WHERE v.id = ? AND v.org_id = ? AND v.archived_at IS NULL AND p.archived_at IS NULL`
  )
    .bind(variantId, orgId)
    .first();
  if (!variant) return json({ error: 'Onbekend of gearchiveerd product' }, 400);

  const id = crypto.randomUUID();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO catalog_entries (id, org_id, catalog_id, section_id, variant_id, price_cents, visible, position, quick_quantities)
         SELECT ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT MAX(position) + 1 FROM catalog_entries WHERE section_id = ?), 0), ?`
      ).bind(id, orgId, catalogId, sectionId, variantId, price.value, body.visible === false ? 0 : 1, sectionId, quick.value ? JSON.stringify(quick.value) : null),
      touch(env, catalogId),
    ]);
  } catch (err) {
    if (isUniqueViolation(err, ENTRY_VARIANT_CONFLICT)) return json({ error: 'Dit product staat al op deze menukaart' }, 409);
    throw err;
  }
  return json(await loadEntry(env, id), 201);
}

async function updateEntry(request: Request, env: Env, orgId: string, catalogId: string, entryId: string) {
  const existing = await env.DB.prepare('SELECT id, section_id, price_cents, visible, quick_quantities FROM catalog_entries WHERE id = ? AND catalog_id = ? AND org_id = ?')
    .bind(entryId, catalogId, orgId)
    .first<{ id: string; section_id: string; price_cents: number; visible: number; quick_quantities: string | null }>();
  if (!existing) return json({ error: 'Lijn niet gevonden' }, 404);
  const body = await readBody(request);

  let { price_cents: priceCents, visible, quick_quantities: quickQuantities, section_id: sectionId } = existing;
  if (body.priceCents !== undefined) {
    const parsed = parsePrice(body.priceCents);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    priceCents = parsed.value;
  }
  if (body.visible !== undefined) visible = body.visible ? 1 : 0;
  if (body.quickQuantities !== undefined) {
    const parsed = parseQuickQuantities(body.quickQuantities);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    quickQuantities = parsed.value ? JSON.stringify(parsed.value) : null;
  }
  if (body.sectionId !== undefined) {
    sectionId = String(body.sectionId);
    if (!(await sectionInCatalog(env, catalogId, sectionId))) return json({ error: 'Onbekende groep voor deze menukaart' }, 400);
  }

  await env.DB.batch([
    env.DB.prepare('UPDATE catalog_entries SET price_cents = ?, visible = ?, quick_quantities = ?, section_id = ? WHERE id = ?').bind(
      priceCents,
      visible,
      quickQuantities,
      sectionId,
      entryId
    ),
    touch(env, catalogId),
  ]);
  return json(await loadEntry(env, entryId));
}

async function deleteEntry(env: Env, orgId: string, catalogId: string, entryId: string) {
  const [result] = await env.DB.batch([
    env.DB.prepare('DELETE FROM catalog_entries WHERE id = ? AND catalog_id = ? AND org_id = ?').bind(entryId, catalogId, orgId),
    touch(env, catalogId),
  ]);
  if ((result.meta.changes || 0) === 0) return json({ error: 'Lijn niet gevonden' }, 404);
  return json({ ok: true });
}

// --- Kassa view ---

// What a kassa renders: only visible entries of sellable (non-archived)
// products, empty sections left out. Deliberately compact — the kassa
// never needs admin-only fields.
async function kassaView(env: Env, orgId: string, catalogIdOrDefault: string) {
  const row =
    catalogIdOrDefault === 'default'
      ? await env.DB.prepare('SELECT id, name, is_default, archived_at, created_at, updated_at FROM catalogs WHERE org_id = ? AND is_default = 1 AND archived_at IS NULL')
          .bind(orgId)
          .first<CatalogRow>()
      : await loadCatalogRow(env, orgId, catalogIdOrDefault);
  if (!row || row.archived_at) return json({ error: 'Geen menukaart gevonden' }, 404);

  const [sections, entries] = await env.DB.batch([
    env.DB.prepare('SELECT id, name, position FROM catalog_sections WHERE catalog_id = ? ORDER BY position, rowid').bind(row.id),
    env.DB.prepare(
      `${ENTRY_SELECT} WHERE e.catalog_id = ? AND e.visible = 1 AND v.archived_at IS NULL AND p.archived_at IS NULL ORDER BY e.position, e.rowid`
    ).bind(row.id),
  ]);
  const entryRows = (entries.results || []) as EntryRow[];

  return json({
    id: row.id,
    name: row.name,
    updatedAt: row.updated_at,
    sections: ((sections.results || []) as SectionRow[])
      .map((s) => ({
        id: s.id,
        name: s.name,
        entries: entryRows
          .filter((e) => e.section_id === s.id)
          .map((e) => ({
            entryId: e.id,
            variantId: e.variant_id,
            name: displayName(e.product_name, e.variant_name),
            priceCents: e.price_cents,
            code: e.code,
            categoryName: e.category_name,
            quickQuantities: parseQuick(e.quick_quantities),
          })),
      }))
      .filter((s) => s.entries.length > 0),
  });
}

// --- Routing ---

async function authorize(request: Request, env: Env, orgId: string, write: boolean): Promise<Response | null> {
  const caller = extractCaller(request);
  if (!caller) return json({ error: 'Unauthorized' }, 401);
  const membership = await requireOrgRole(env, orgId, caller, write ? ['admin'] : ['admin', 'cashier']);
  if (!membership) return json({ error: 'Forbidden' }, 403);
  return null;
}

// Handles /organizations/:orgId/catalog/... (categories, products,
// variants) and /organizations/:orgId/catalogs/... Returns null for
// anything it doesn't recognize.
export async function dispatchCatalogRoute(request: Request, env: Env, pathname: string): Promise<Response | null> {
  const match = pathname.match(/^\/organizations\/([^/]+)\/(catalog|catalogs)(?:\/(.*))?$/);
  if (!match) return null;
  const [, orgId, root, rest = ''] = match;
  const parts = rest ? rest.split('/') : [];
  const method = request.method;

  const refusal = await authorize(request, env, orgId, method !== 'GET');
  if (refusal) return refusal;

  if (root === 'catalog') {
    const [kind, id, sub] = parts;
    if (kind === 'categories' && !id) {
      if (method === 'GET') return listCategories(env, orgId);
      if (method === 'POST') return createCategory(request, env, orgId);
    }
    if (kind === 'categories' && id && !sub) {
      if (method === 'PATCH') return updateCategory(request, env, orgId, id);
      if (method === 'DELETE') return deleteCategory(env, orgId, id);
    }
    if (kind === 'stations' && !id) {
      if (method === 'GET') return listStations(env, orgId);
      if (method === 'POST') return createStation(request, env, orgId);
    }
    if (kind === 'stations' && id && !sub) {
      if (method === 'PATCH') return updateStation(request, env, orgId, id);
      if (method === 'DELETE') return deleteStation(env, orgId, id);
    }
    if (kind === 'products' && !id) {
      if (method === 'GET') return listProducts(request, env, orgId);
      if (method === 'POST') return createProduct(request, env, orgId);
    }
    if (kind === 'products' && id && !sub && method === 'PATCH') return updateProduct(request, env, orgId, id);
    if (kind === 'products' && id && sub === 'variants' && parts.length === 3 && method === 'POST') return createVariant(request, env, orgId, id);
    if (kind === 'variants' && id && !sub && method === 'PATCH') return updateVariant(request, env, orgId, id);
    return null;
  }

  const [catalogId, action, childId] = parts;
  if (!catalogId) {
    if (method === 'GET') return listCatalogs(env, orgId);
    if (method === 'POST') return createCatalog(request, env, orgId);
    return null;
  }
  if (action === 'kassa' && !childId && method === 'GET') return kassaView(env, orgId, catalogId);
  if (catalogId === 'default') return null;

  if (!action) {
    if (method === 'GET') {
      const detail = await loadCatalogDetail(env, orgId, catalogId);
      return detail ? json(detail) : json({ error: 'Menukaart niet gevonden' }, 404);
    }
    if (method === 'PATCH') return renameCatalog(request, env, orgId, catalogId);
    return null;
  }
  if (!childId) {
    if (action === 'default' && method === 'POST') return setDefaultCatalog(env, orgId, catalogId);
    if (action === 'archive' && method === 'POST') return archiveCatalog(env, orgId, catalogId);
    if (action === 'duplicate' && method === 'POST') return duplicateCatalog(request, env, orgId, catalogId);
    if (action === 'layout' && method === 'PUT') return setLayout(request, env, orgId, catalogId);
    if (action === 'sections' && method === 'POST') return createSection(request, env, orgId, catalogId);
    if (action === 'entries' && method === 'POST') return createEntry(request, env, orgId, catalogId);
    return null;
  }
  if (parts.length !== 3) return null;
  if (action === 'sections') {
    if (method === 'PATCH') return renameSection(request, env, orgId, catalogId, childId);
    if (method === 'DELETE') return deleteSection(env, orgId, catalogId, childId);
  }
  if (action === 'entries') {
    if (method === 'PATCH') return updateEntry(request, env, orgId, catalogId, childId);
    if (method === 'DELETE') return deleteEntry(env, orgId, catalogId, childId);
  }
  return null;
}
