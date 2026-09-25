// Menukaart import/export (DOMAIN_MODEL.md "Menukaart import/export").
//
//   GET  /organizations/:orgId/catalogs/:id/export  (members)
//   POST /organizations/:orgId/catalogs/import      (admin) { catalogId? | name, rows, dryRun }
//
// One file = one menukaart, one row = one kassa button. The browser only
// reads the sheet and sends raw cell values; every interpretation rule is
// here, so there's one tested source of truth:
//
//   - Groep and Product: empty = the row above.
//   - Categorie, Station and BTW belong to the product: stating them on any one row
//     of that product is enough; two different values = error. Empty
//     everywhere (and an empty Code) = not set for a new product/variant,
//     unchanged for an existing one — products are shared across
//     menukaarten, so a sparse file for one menukaart never wipes org-level
//     product data.
//   - Prijs, Variant, Code, Snelknoppen, Zichtbaar are never inherited.
//   - Matching (active products/variants only): variant by Code first,
//     else product by name and variant by name within it (case- and
//     whitespace-insensitive). A Code kept with a new name = a rename.
//   - An import replaces the menukaart's groups, order and prices. It never
//     deletes or archives products; history (order lines) is untouched.
//   - dryRun previews every change; apply is one D1 batch — all or nothing —
//     with one json_each statement per table, so the query count stays the
//     same however long the sheet is (the Free plan allows 50 per request).
import type { Env } from './env';
import { json } from './http';
import { displayName } from './catalog';
import { extractCaller, requireOrgRole } from './organizations/auth';
import { jsonRowsStatement, present } from './sql-json';

type Cell = string | number | boolean | null | undefined;

interface RawRow {
  row?: unknown;
  groep?: Cell;
  product?: Cell;
  variant?: Cell;
  prijs?: Cell;
  categorie?: Cell;
  station?: Cell;
  btw?: Cell;
  code?: Cell;
  snelknoppen?: Cell;
  zichtbaar?: Cell;
}

interface ParsedRow {
  row: number;
  groep: string;
  product: string;
  variant: string;
  priceCents: number;
  categorie: string | null; // null = empty cell
  station: string | null; // null = empty cell
  vatBp: number | null | undefined; // undefined = empty cell
  code: string | null;
  quick: number[] | null;
  visible: boolean;
}

interface ImportError {
  row: number | null;
  message: string;
}

const MAX_ROWS = 500;
const VAT_RATES = [0, 6, 12, 21];

// --- Cell reading ---

function text(cell: Cell): string {
  if (cell === null || cell === undefined) return '';
  return String(cell).replace(/\s+/g, ' ').trim();
}

function norm(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLocaleLowerCase('nl-BE');
}

function parsePrice(cell: Cell): number | string {
  if (typeof cell === 'number') {
    if (!Number.isFinite(cell) || cell < 0) return 'Prijs moet 0 of meer zijn';
    const cents = Math.round(cell * 100);
    return cents <= 1_000_000 ? cents : 'Prijs is te hoog (max € 10.000)';
  }
  let s = text(cell).replace(/€/g, '').replace(/\s/g, '');
  if (!s) return 'Prijs ontbreekt';
  if (s.includes(',') && s.includes('.')) s = s.replace(/\./g, ''); // 1.234,50
  s = s.replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return `Prijs "${text(cell)}" is geen geldig bedrag`;
  const cents = Math.round(Number(s) * 100);
  return cents <= 1_000_000 ? cents : 'Prijs is te hoog (max € 10.000)';
}

// Accepts 21, "21", "21%", and 0.21 (a %-formatted Excel cell's value).
function parseVat(cell: Cell): number | undefined | string {
  let n: number;
  if (typeof cell === 'number') n = cell;
  else {
    const s = text(cell).replace('%', '').replace(',', '.').trim();
    if (!s) return undefined;
    n = Number(s);
    if (!Number.isFinite(n)) return `BTW "${text(cell)}" is geen getal`;
  }
  if (n > 0 && n < 1) n = n * 100;
  n = Math.round(n * 100) / 100;
  if (!VAT_RATES.includes(n)) return `BTW ${n}% bestaat niet — gebruik ${VAT_RATES.join(', ')}`;
  return n * 100;
}

function parseQuick(cell: Cell): number[] | null | string {
  if (typeof cell === 'number') cell = String(cell);
  const s = text(cell);
  if (!s) return null;
  const parts = s.split(/[,;\s]+/).filter(Boolean);
  const numbers = parts.map(Number);
  if (parts.length > 10 || !numbers.every((n) => Number.isInteger(n) && n >= 1 && n <= 999)) {
    return `Snelknoppen "${s}" — gebruik hele getallen tussen 1 en 999, bv. 5, 10, 20 (max 10)`;
  }
  return numbers;
}

function parseVisible(cell: Cell): boolean | string {
  if (typeof cell === 'boolean') return cell;
  if (typeof cell === 'number') return cell === 1 ? true : cell === 0 ? false : `Zichtbaar "${cell}" — gebruik ja of nee`;
  const s = norm(text(cell));
  if (!s || ['ja', 'j', 'yes', 'y', 'x', '1', 'true', 'waar'].includes(s)) return true;
  if (['nee', 'n', 'no', '0', 'false', 'onwaar'].includes(s)) return false;
  return `Zichtbaar "${text(cell)}" — gebruik ja of nee`;
}

function limit(value: string, max: number, label: string, errors: ImportError[], row: number): string {
  if (value.length > max) errors.push({ row, message: `${label} is te lang (max ${max} tekens)` });
  return value.slice(0, max);
}

// Reads every row, applying the Groep/Product fill-down.
function parseRows(raw: RawRow[], errors: ImportError[]): ParsedRow[] {
  const parsed: ParsedRow[] = [];
  let lastGroep = '';
  let lastProduct = '';
  raw.forEach((r, i) => {
    const row = Number.isInteger(r.row) ? (r.row as number) : i + 2;
    const before = errors.length;

    const groepCell = text(r.groep);
    const productCell = text(r.product);
    if (groepCell) lastGroep = groepCell;
    if (productCell) lastProduct = productCell;
    if (!lastGroep) errors.push({ row, message: 'Groep ontbreekt (en er is geen rij erboven om van over te nemen)' });
    if (!lastProduct) errors.push({ row, message: 'Product ontbreekt (en er is geen rij erboven om van over te nemen)' });

    const price = parsePrice(r.prijs);
    if (typeof price === 'string') errors.push({ row, message: price });
    const vat = parseVat(r.btw);
    if (typeof vat === 'string') errors.push({ row, message: vat });
    const quick = parseQuick(r.snelknoppen);
    if (typeof quick === 'string') errors.push({ row, message: quick });
    const visible = parseVisible(r.zichtbaar);
    if (typeof visible === 'string') errors.push({ row, message: visible });

    const categorie = text(r.categorie);
    const station = text(r.station);
    const code = text(r.code);
    const entry: ParsedRow = {
      row,
      groep: limit(lastGroep, 60, 'Groep', errors, row),
      product: limit(lastProduct, 100, 'Product', errors, row),
      variant: limit(text(r.variant), 60, 'Variant', errors, row),
      priceCents: typeof price === 'number' ? price : 0,
      categorie: categorie ? limit(categorie, 60, 'Categorie', errors, row) : null,
      station: station ? limit(station, 60, 'Station', errors, row) : null,
      vatBp: typeof vat === 'string' ? undefined : vat,
      code: code ? limit(code, 40, 'Code', errors, row) : null,
      quick: typeof quick === 'string' ? null : quick,
      visible: typeof visible === 'string' ? true : visible,
    };
    if (errors.length === before) parsed.push(entry);
    else parsed.push({ ...entry, row: -row }); // marked invalid, still takes part in grouping checks
  });
  return parsed;
}

// --- Existing org data ---

interface ExistingProduct {
  id: string;
  name: string;
  category_id: string | null;
  prep_station_id: string | null;
  vat_rate_bp: number | null;
}

interface ExistingVariant {
  id: string;
  product_id: string;
  name: string;
  code: string | null;
  position: number;
}

interface ExistingEntry {
  variant_id: string;
  price_cents: number;
  visible: number;
  quick_quantities: string | null;
  product_name: string;
  variant_name: string;
}

async function loadOrgCatalogData(env: Env, orgId: string, catalogId: string | null) {
  const [products, variants, categories, entries, stations] = await env.DB.batch([
    env.DB.prepare('SELECT id, name, category_id, prep_station_id, vat_rate_bp FROM products WHERE org_id = ? AND archived_at IS NULL ORDER BY created_at').bind(orgId),
    env.DB.prepare(
      `SELECT v.id, v.product_id, v.name, v.code, v.position FROM product_variants v JOIN products p ON p.id = v.product_id
       WHERE v.org_id = ? AND v.archived_at IS NULL AND p.archived_at IS NULL ORDER BY v.position, v.created_at`
    ).bind(orgId),
    env.DB.prepare('SELECT id, name FROM categories WHERE org_id = ? ORDER BY position, created_at').bind(orgId),
    env.DB.prepare(
      `SELECT e.variant_id, e.price_cents, e.visible, e.quick_quantities, p.name AS product_name, v.name AS variant_name
       FROM catalog_entries e JOIN product_variants v ON v.id = e.variant_id JOIN products p ON p.id = v.product_id
       JOIN catalog_sections s ON s.id = e.section_id
       WHERE e.catalog_id = ? ORDER BY s.position, s.rowid, e.position, e.rowid`
    ).bind(catalogId ?? ''),
    env.DB.prepare('SELECT id, name FROM prep_stations WHERE org_id = ? ORDER BY position, created_at').bind(orgId),
  ]);
  return {
    products: (products.results || []) as ExistingProduct[],
    variants: (variants.results || []) as ExistingVariant[],
    categories: (categories.results || []) as { id: string; name: string }[],
    entries: (entries.results || []) as ExistingEntry[],
    stations: (stations.results || []) as { id: string; name: string }[],
  };
}

// --- Import ---

interface Summary {
  rows: number;
  groups: number;
  newCategories: string[];
  newStations: string[];
  newProducts: string[];
  newVariants: string[];
  updatedProducts: { name: string; changes: string[] }[];
  priceChanges: { name: string; fromCents: number; toCents: number }[];
  added: string[];
  removed: string[];
  unchanged: number;
}

const vatLabel = (bp: number | null) => (bp === null ? '(geen)' : `${bp / 100}%`);

async function importCatalog(request: Request, env: Env, orgId: string): Promise<Response> {
  const body = ((await request.json().catch(() => null)) || {}) as { catalogId?: unknown; name?: unknown; rows?: unknown; dryRun?: unknown };
  if (!Array.isArray(body.rows) || body.rows.length === 0) return json({ error: 'rows must be a non-empty array' }, 400);
  if (body.rows.length > MAX_ROWS) return json({ error: `Maximaal ${MAX_ROWS} rijen per bestand` }, 400);
  const dryRun = body.dryRun !== false;

  let catalogId: string | null = null;
  let catalogName = '';
  if (typeof body.catalogId === 'string' && body.catalogId) {
    const row = await env.DB.prepare('SELECT id, name FROM catalogs WHERE id = ? AND org_id = ? AND archived_at IS NULL')
      .bind(body.catalogId, orgId)
      .first<{ id: string; name: string }>();
    if (!row) return json({ error: 'Menukaart niet gevonden' }, 404);
    catalogId = row.id;
    catalogName = row.name;
  } else {
    catalogName = typeof body.name === 'string' ? body.name.trim() : '';
    if (!catalogName || catalogName.length > 60) return json({ error: 'name is required for a new menukaart (max 60 characters)' }, 400);
  }

  const errors: ImportError[] = [];
  const rows = parseRows(body.rows as RawRow[], errors);
  const existing = await loadOrgCatalogData(env, orgId, catalogId);

  // Group rows per file product and check the product-level rules.
  interface FileProduct {
    key: string;
    name: string;
    rows: ParsedRow[];
    categorie: { value: string; row: number } | null;
    station: { value: string; row: number } | null;
    vat: { value: number | null; row: number } | undefined;
  }
  const fileProducts = new Map<string, FileProduct>();
  for (const r of rows) {
    const key = norm(r.product);
    if (!key) continue;
    let fp = fileProducts.get(key);
    if (!fp) {
      fp = { key, name: r.product, rows: [], categorie: null, station: null, vat: undefined };
      fileProducts.set(key, fp);
    }
    fp.rows.push(r);
    const row = Math.abs(r.row);
    if (r.categorie) {
      if (fp.categorie && norm(fp.categorie.value) !== norm(r.categorie)) {
        errors.push({ row, message: `${fp.name}: andere categorie ("${r.categorie}") dan op rij ${fp.categorie.row} ("${fp.categorie.value}") — rijen ${fp.categorie.row} en ${row}` });
      } else if (!fp.categorie) fp.categorie = { value: r.categorie, row };
    }
    if (r.station) {
      if (fp.station && norm(fp.station.value) !== norm(r.station)) {
        errors.push({ row, message: `${fp.name}: ander station ("${r.station}") dan op rij ${fp.station.row} ("${fp.station.value}") — rijen ${fp.station.row} en ${row}` });
      } else if (!fp.station) fp.station = { value: r.station, row };
    }
    if (r.vatBp !== undefined) {
      if (fp.vat && fp.vat.value !== r.vatBp) {
        errors.push({ row, message: `${fp.name}: ander BTW-tarief (${vatLabel(r.vatBp)}) dan op rij ${fp.vat.row} (${vatLabel(fp.vat.value)}) — rijen ${fp.vat.row} en ${row}` });
      } else if (!fp.vat) fp.vat = { value: r.vatBp, row };
    }
  }

  // Duplicate product+variant and duplicate codes within the file.
  const seenVariant = new Map<string, number>();
  const seenCode = new Map<string, number>();
  for (const r of rows) {
    const row = Math.abs(r.row);
    const key = `${norm(r.product)}\u0000${norm(r.variant)}`;
    if (seenVariant.has(key)) errors.push({ row, message: `${displayName(r.product, r.variant)} staat al op rij ${seenVariant.get(key)}` });
    else seenVariant.set(key, row);
    if (r.code) {
      if (seenCode.has(r.code)) errors.push({ row, message: `Code "${r.code}" staat al op rij ${seenCode.get(r.code)}` });
      else seenCode.set(r.code, row);
    }
  }

  // Resolve file products to existing products.
  const productById = new Map(existing.products.map((p) => [p.id, p]));
  const productByName = new Map<string, ExistingProduct>();
  for (const p of existing.products) if (!productByName.has(norm(p.name))) productByName.set(norm(p.name), p);
  const variantByCode = new Map(existing.variants.filter((v) => v.code).map((v) => [v.code as string, v]));
  const claimedProducts = new Map<string, string>(); // existing product id -> file product name

  const resolvedProduct = new Map<string, ExistingProduct | null>();
  for (const fp of fileProducts.values()) {
    let match: ExistingProduct | null = null;
    const coded = fp.rows.find((r) => r.code && variantByCode.has(r.code));
    if (coded) {
      const owner = productById.get(variantByCode.get(coded.code as string)!.product_id)!;
      const byName = productByName.get(fp.key);
      if (norm(owner.name) !== fp.key && byName && byName.id !== owner.id) {
        errors.push({ row: Math.abs(coded.row), message: `Code "${coded.code}" hoort bij product "${owner.name}", niet bij "${fp.name}" (dat bestaat al apart)` });
      } else match = owner;
    } else {
      match = productByName.get(fp.key) ?? null;
    }
    if (match) {
      const claimedBy = claimedProducts.get(match.id);
      if (claimedBy !== undefined) {
        errors.push({ row: Math.abs(fp.rows[0].row), message: `"${fp.name}" en "${claimedBy}" verwijzen naar hetzelfde bestaande product "${match.name}"` });
        match = null;
      } else claimedProducts.set(match.id, fp.name);
    }
    resolvedProduct.set(fp.key, match);
  }

  // Resolve every row to an existing or new variant.
  interface ResolvedRow extends ParsedRow {
    variantId: string | null; // existing variant, or null = new
  }
  const resolvedRows: ResolvedRow[] = [];
  const claimedVariants = new Map<string, number>();
  for (const r of rows) {
    const product = resolvedProduct.get(norm(r.product)) ?? null;
    let variant: ExistingVariant | null = null;
    const row = Math.abs(r.row);
    if (r.code && variantByCode.has(r.code)) {
      const v = variantByCode.get(r.code)!;
      if (product && v.product_id === product.id) variant = v;
      else if (product || !resolvedProduct.has(norm(r.product))) {
        errors.push({ row, message: `Code "${r.code}" is al in gebruik bij een ander product` });
      }
    } else if (product) {
      variant = existing.variants.find((v) => v.product_id === product.id && norm(v.name) === norm(r.variant)) ?? null;
    }
    if (variant) {
      if (claimedVariants.has(variant.id)) errors.push({ row, message: `Deze variant staat al op rij ${claimedVariants.get(variant.id)}` });
      else claimedVariants.set(variant.id, row);
    }
    resolvedRows.push({ ...r, row, variantId: variant?.id ?? null });
  }

  if (errors.length > 0) {
    errors.sort((a, b) => (a.row ?? 0) - (b.row ?? 0));
    return json({ ok: false, errors, summary: null }, dryRun ? 200 : 400);
  }

  // --- Plan the changes ---
  const now = new Date().toISOString();
  // Rows to write, collected per table and written with one statement each.
  const newCategoryRows: Record<string, unknown>[] = [];
  const newStationRows: Record<string, unknown>[] = [];
  const productRows: Record<string, unknown>[] = []; // new + changed, upserted
  const variantRows: Record<string, unknown>[] = []; // new + renamed/recoded, upserted
  const categoryByName = new Map(existing.categories.map((c) => [norm(c.name), c]));
  const categoryName = new Map(existing.categories.map((c) => [c.id, c.name]));
  const summary: Summary = {
    rows: resolvedRows.length,
    groups: new Set(resolvedRows.map((r) => norm(r.groep))).size,
    newCategories: [],
    newStations: [],
    newProducts: [],
    newVariants: [],
    updatedProducts: [],
    priceChanges: [],
    added: [],
    removed: [],
    unchanged: 0,
  };

  const categoryIdFor = (name: string): string => {
    const known = categoryByName.get(norm(name));
    if (known) return known.id;
    const id = crypto.randomUUID();
    categoryByName.set(norm(name), { id, name });
    categoryName.set(id, name);
    summary.newCategories.push(name);
    newCategoryRows.push({ id, org_id: orgId, name, position: existing.categories.length + newCategoryRows.length, created_at: now });
    return id;
  };

  const stationByName = new Map(existing.stations.map((st) => [norm(st.name), st]));
  const stationName = new Map(existing.stations.map((st) => [st.id, st.name]));
  const stationIdFor = (name: string): string => {
    const known = stationByName.get(norm(name));
    if (known) return known.id;
    const id = crypto.randomUUID();
    stationByName.set(norm(name), { id, name });
    stationName.set(id, name);
    summary.newStations.push(name);
    newStationRows.push({ id, org_id: orgId, name, position: existing.stations.length + newStationRows.length, created_at: now });
    return id;
  };

  const finalName = new Map<string, string>(); // file product key -> product name after import
  const productIdFor = new Map<string, string>(); // file product key -> product id
  for (const fp of fileProducts.values()) {
    const match = resolvedProduct.get(fp.key) ?? null;
    const categoryId = fp.categorie ? categoryIdFor(fp.categorie.value) : undefined;
    const stationId = fp.station ? stationIdFor(fp.station.value) : undefined;
    if (!match) {
      const id = crypto.randomUUID();
      productIdFor.set(fp.key, id);
      finalName.set(fp.key, fp.name);
      summary.newProducts.push(fp.name);
      productRows.push({
        id,
        org_id: orgId,
        category_id: categoryId ?? null,
        prep_station_id: stationId ?? null,
        name: fp.name,
        vat_rate_bp: fp.vat ? fp.vat.value : null,
        created_at: now,
      });
      continue;
    }

    productIdFor.set(fp.key, match.id);
    const changes: string[] = [];
    // Renamed only via a kept Code; a name-only match keeps the existing name.
    const renamed = fp.rows.some((r) => r.code && variantByCode.get(r.code)?.product_id === match.id) && norm(match.name) !== fp.key;
    const name = renamed ? fp.name : match.name;
    finalName.set(fp.key, name);
    if (renamed) changes.push(`naam: ${match.name} → ${fp.name}`);
    let newCategoryId = match.category_id;
    if (categoryId !== undefined && categoryId !== match.category_id) {
      changes.push(`categorie: ${match.category_id ? categoryName.get(match.category_id) : '(geen)'} → ${fp.categorie!.value}`);
      newCategoryId = categoryId;
    }
    let newStationId = match.prep_station_id;
    if (stationId !== undefined && stationId !== match.prep_station_id) {
      changes.push(`station: ${match.prep_station_id ? stationName.get(match.prep_station_id) : '(geen)'} → ${fp.station!.value}`);
      newStationId = stationId;
    }
    let newVat = match.vat_rate_bp;
    if (fp.vat && fp.vat.value !== match.vat_rate_bp) {
      changes.push(`btw: ${vatLabel(match.vat_rate_bp)} → ${vatLabel(fp.vat.value)}`);
      newVat = fp.vat.value;
    }
    for (const r of fp.rows) {
      const v = existing.variants.find((x) => x.id === resolvedRows.find((rr) => rr.row === r.row)?.variantId);
      if (!v) continue;
      if (norm(v.name) !== norm(r.variant)) changes.push(`variant: ${v.name || '(geen)'} → ${r.variant || '(geen)'}`);
      if (r.code && r.code !== v.code) changes.push(`code ${displayName(name, r.variant)}: ${v.code || '(geen)'} → ${r.code}`);
    }
    if (changes.length > 0) {
      summary.updatedProducts.push({ name, changes });
      productRows.push({ id: match.id, org_id: orgId, category_id: newCategoryId, prep_station_id: newStationId, name, vat_rate_bp: newVat, created_at: now });
    }
  }

  // Variants: new ones created, existing ones renamed / given a code.
  const nextPosition = new Map<string, number>();
  for (const v of existing.variants) nextPosition.set(v.product_id, Math.max(nextPosition.get(v.product_id) ?? 0, v.position + 1));
  const variantFor = new Map<number, string>(); // row -> variant id
  for (const r of resolvedRows) {
    const key = norm(r.product);
    const productId = productIdFor.get(key)!;
    if (r.variantId) {
      variantFor.set(r.row, r.variantId);
      const v = existing.variants.find((x) => x.id === r.variantId)!;
      const code = r.code ?? v.code; // empty Code = unchanged
      const renamed = v.name !== r.variant && norm(v.name) !== norm(r.variant);
      if (renamed || code !== v.code) {
        variantRows.push({ id: v.id, org_id: orgId, product_id: v.product_id, name: renamed ? r.variant : v.name, code, position: v.position, created_at: now });
      }
      continue;
    }
    const id = crypto.randomUUID();
    variantFor.set(r.row, id);
    const position = nextPosition.get(productId) ?? 0;
    nextPosition.set(productId, position + 1);
    if (resolvedProduct.get(key)) summary.newVariants.push(displayName(finalName.get(key)!, r.variant));
    variantRows.push({ id, org_id: orgId, product_id: productId, name: r.variant, code: r.code, position, created_at: now });
  }

  // Menukaart diff: what the kassa will show vs. now.
  const current = new Map(existing.entries.map((e) => [e.variant_id, e]));
  const inFile = new Set<string>();
  for (const r of resolvedRows) {
    const name = displayName(finalName.get(norm(r.product))!, r.variant);
    const was = r.variantId ? current.get(r.variantId) : undefined;
    if (r.variantId) inFile.add(r.variantId);
    if (!was) {
      summary.added.push(name);
      continue;
    }
    const sameQuick = (was.quick_quantities || null) === (r.quick ? JSON.stringify(r.quick) : null);
    if (was.price_cents !== r.priceCents) summary.priceChanges.push({ name, fromCents: was.price_cents, toCents: r.priceCents });
    else if (!!was.visible === r.visible && sameQuick) summary.unchanged++;
  }
  for (const e of existing.entries) if (!inFile.has(e.variant_id)) summary.removed.push(displayName(e.product_name, e.variant_name));

  if (dryRun) return json({ ok: true, errors: [], summary });

  // --- Apply: one batch, all or nothing — one statement per table ---
  const targetId = catalogId ?? crypto.randomUUID();
  const sectionRows: Record<string, unknown>[] = [];
  const entryRows: Record<string, unknown>[] = [];
  const sections = new Map<string, { id: string; count: number }>();
  for (const r of resolvedRows) {
    let section = sections.get(norm(r.groep));
    if (!section) {
      section = { id: crypto.randomUUID(), count: 0 };
      sections.set(norm(r.groep), section);
      sectionRows.push({ id: section.id, org_id: orgId, catalog_id: targetId, name: r.groep, position: sections.size - 1 });
    }
    entryRows.push({
      id: crypto.randomUUID(),
      org_id: orgId,
      catalog_id: targetId,
      section_id: section.id,
      variant_id: variantFor.get(r.row)!,
      price_cents: r.priceCents,
      visible: r.visible ? 1 : 0,
      position: section.count++,
      quick_quantities: r.quick ? JSON.stringify(r.quick) : null,
    });
  }

  const statements = present([
    catalogId
      ? null
      : env.DB.prepare(
          `INSERT INTO catalogs (id, org_id, name, is_default, created_at, updated_at)
           SELECT ?, ?, ?, CASE WHEN EXISTS (SELECT 1 FROM catalogs WHERE org_id = ? AND is_default = 1) THEN 0 ELSE 1 END, ?, ?`
        ).bind(targetId, orgId, catalogName, orgId, now, now),
    jsonRowsStatement(env.DB, 'categories', ['id', 'org_id', 'name', 'position', 'created_at'], newCategoryRows),
    jsonRowsStatement(env.DB, 'prep_stations', ['id', 'org_id', 'name', 'position', 'created_at'], newStationRows),
    jsonRowsStatement(env.DB, 'products', ['id', 'org_id', 'category_id', 'prep_station_id', 'name', 'vat_rate_bp', 'created_at'], productRows, {
      upsert: { conflict: 'id', update: ['name', 'category_id', 'prep_station_id', 'vat_rate_bp'] },
    }),
    jsonRowsStatement(env.DB, 'product_variants', ['id', 'org_id', 'product_id', 'name', 'code', 'position', 'created_at'], variantRows, {
      upsert: { conflict: 'id', update: ['name', 'code'] },
    }),
    catalogId ? env.DB.prepare('DELETE FROM catalog_entries WHERE catalog_id = ?').bind(targetId) : null,
    catalogId ? env.DB.prepare('DELETE FROM catalog_sections WHERE catalog_id = ?').bind(targetId) : null,
    catalogId ? env.DB.prepare('UPDATE catalogs SET updated_at = ? WHERE id = ?').bind(now, targetId) : null,
    jsonRowsStatement(env.DB, 'catalog_sections', ['id', 'org_id', 'catalog_id', 'name', 'position'], sectionRows),
    jsonRowsStatement(
      env.DB,
      'catalog_entries',
      ['id', 'org_id', 'catalog_id', 'section_id', 'variant_id', 'price_cents', 'visible', 'position', 'quick_quantities'],
      entryRows
    ),
  ]);

  try {
    await env.DB.batch(statements);
  } catch (err) {
    if (/UNIQUE constraint failed/i.test((err as Error)?.message || '')) {
      return json({ ok: false, errors: [{ row: null, message: 'Er is intussen iets gewijzigd (bv. een code wordt al gebruikt) — maak opnieuw een voorbeeld' }], summary }, 409);
    }
    throw err;
  }
  return json({ ok: true, errors: [], summary, catalog: { id: targetId, name: catalogName } });
}

// --- Export ---

async function exportCatalog(env: Env, orgId: string, catalogId: string): Promise<Response> {
  const catalog = await env.DB.prepare('SELECT id, name FROM catalogs WHERE id = ? AND org_id = ?').bind(catalogId, orgId).first<{ id: string; name: string }>();
  if (!catalog) return json({ error: 'Menukaart niet gevonden' }, 404);

  // Sellable entries only: an archived product can't be matched on
  // re-import (matching is on active products), so exporting it would
  // silently create a duplicate.
  const { results } = await env.DB.prepare(
    `SELECT s.name AS groep, p.name AS product, v.name AS variant, e.price_cents, c.name AS categorie, ps.name AS station, p.vat_rate_bp, v.code, e.quick_quantities, e.visible
     FROM catalog_entries e
     JOIN catalog_sections s ON s.id = e.section_id
     JOIN product_variants v ON v.id = e.variant_id
     JOIN products p ON p.id = v.product_id
     LEFT JOIN categories c ON c.id = p.category_id
     LEFT JOIN prep_stations ps ON ps.id = p.prep_station_id
     WHERE e.catalog_id = ? AND v.archived_at IS NULL AND p.archived_at IS NULL
     ORDER BY s.position, s.rowid, e.position, e.rowid`
  )
    .bind(catalogId)
    .all<{ groep: string; product: string; variant: string; price_cents: number; categorie: string | null; station: string | null; vat_rate_bp: number | null; code: string | null; quick_quantities: string | null; visible: number }>();

  return json({
    catalog,
    rows: (results || []).map((r) => ({
      groep: r.groep,
      product: r.product,
      variant: r.variant,
      prijsCents: r.price_cents,
      categorie: r.categorie,
      station: r.station,
      btwBp: r.vat_rate_bp,
      code: r.code,
      snelknoppen: r.quick_quantities ? JSON.parse(r.quick_quantities) : null,
      zichtbaar: !!r.visible,
    })),
  });
}

// Handles POST /organizations/:orgId/catalogs/import and
// GET /organizations/:orgId/catalogs/:id/export. Returns null otherwise.
export async function dispatchCatalogImportRoute(request: Request, env: Env, pathname: string): Promise<Response | null> {
  const importMatch = pathname.match(/^\/organizations\/([^/]+)\/catalogs\/import$/);
  const exportMatch = pathname.match(/^\/organizations\/([^/]+)\/catalogs\/([^/]+)\/export$/);
  const isImport = importMatch && request.method === 'POST';
  const isExport = exportMatch && request.method === 'GET';
  if (!isImport && !isExport) return null;
  const orgId = (importMatch || exportMatch)![1];

  const caller = extractCaller(request);
  if (!caller) return json({ error: 'Unauthorized' }, 401);
  if (!(await requireOrgRole(env, orgId, caller, isImport ? ['admin'] : ['admin', 'cashier']))) return json({ error: 'Forbidden' }, 403);
  return isImport ? importCatalog(request, env, orgId) : exportCatalog(env, orgId, exportMatch![2]);
}
