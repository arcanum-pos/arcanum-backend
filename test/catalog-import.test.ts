// Menukaart import/export (DOMAIN_MODEL.md "Menukaart import/export"): one
// file = one menukaart, one row = one kassa button. The browser sends raw
// cell values; every interpretation rule lives here and is tested here.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { api, seedOrg, type TestOrg } from './helpers';

type Cell = string | number | boolean | null;
interface Row {
  row: number;
  groep?: Cell;
  product?: Cell;
  variant?: Cell;
  prijs?: Cell;
  categorie?: Cell;
  btw?: Cell;
  code?: Cell;
  snelknoppen?: Cell;
  zichtbaar?: Cell;
}

// Rows as [groep, product, variant, prijs, categorie?, btw?, code?, snelknoppen?, zichtbaar?],
// numbered from sheet row 2 (row 1 is the header).
function sheet(...cells: Cell[][]): Row[] {
  return cells.map(([groep, product, variant, prijs, categorie = null, btw = null, code = null, snelknoppen = null, zichtbaar = null], i) => ({
    row: i + 2,
    groep,
    product,
    variant,
    prijs,
    categorie,
    btw,
    code,
    snelknoppen,
    zichtbaar,
  }));
}

const importPath = (org: TestOrg) => `/organizations/${org.orgId}/catalogs/import`;
const importInto = (org: TestOrg, catalogId: string, rows: Row[], dryRun = false) =>
  api('POST', importPath(org), { user: org.admin, body: { catalogId, rows, dryRun } });
const importNew = (org: TestOrg, name: string, rows: Row[], dryRun = false) => api('POST', importPath(org), { user: org.admin, body: { name, rows, dryRun } });
const exportOf = (org: TestOrg, catalogId: string, user = org.admin) => api('GET', `/organizations/${org.orgId}/catalogs/${catalogId}/export`, { user });
const kassa = async (org: TestOrg, catalogId: string) => (await api('GET', `/organizations/${org.orgId}/catalogs/${catalogId}/kassa`, { user: org.cashier })).body;

async function count(table: string, orgId: string) {
  return (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE org_id = ?`).bind(orgId).first<{ n: number }>())!.n;
}

const RESTAURANT = sheet(
  ['Drank', 'Pintje', '', '2,50', 'Drank', 21, 'pintje'],
  [null, 'Duvel', null, '€ 4,00'],
  ['Menu', 'Steak', 'normaal', 34, 'Eten', '12%'],
  [null, null, 'kind', '26.00'],
  ['Dessert', 'Dame blanche', '', 8, 'Dessert', 0.06, null, null, 'nee']
);

async function restaurant(org: TestOrg) {
  const res = await importNew(org, 'Restaurant', RESTAURANT);
  if (res.status !== 200 || !res.body.ok) throw new Error(JSON.stringify(res.body));
  return res.body.catalog.id as string;
}

function errorsOf(body: any): [number | null, string][] {
  return body.errors.map((e: any) => [e.row, e.message]);
}

describe('import: access and limits', () => {
  it('is admin-only; export is open to members', async () => {
    const org = await seedOrg();
    const id = await restaurant(org);
    expect((await api('POST', importPath(org), { user: org.cashier, body: { catalogId: id, rows: RESTAURANT, dryRun: true } })).status).toBe(403);
    expect((await exportOf(org, id, org.cashier)).status).toBe(200);
  });

  it('validates the body: rows, name for a new menukaart, unknown catalog, 500-row limit', async () => {
    const org = await seedOrg();
    expect((await api('POST', importPath(org), { user: org.admin, body: { name: 'X', dryRun: true } })).status).toBe(400);
    expect((await api('POST', importPath(org), { user: org.admin, body: { rows: RESTAURANT, dryRun: true } })).status).toBe(400);
    expect((await importInto(org, 'nope', RESTAURANT, true)).status).toBe(404);
    const many = sheet(...Array.from({ length: 501 }, (_, i) => ['G', `P${i}`, '', 1] as Cell[]));
    expect((await importNew(org, 'Groot', many, true)).status).toBe(400);
  });
});

describe('import: reading cells', () => {
  it('reads prices, VAT, quick quantities and visibility in every common spelling', async () => {
    const org = await seedOrg();
    const res = await importNew(
      org,
      'Spellingen',
      sheet(
        ['G', 'A', '', '8,50', null, '21'],
        [null, 'B', '', '€ 8,50', null, '21%'],
        [null, 'C', '', '8.50', null, 21],
        [null, 'D', '', 8.5, null, 0.21],
        [null, 'E', '', '€8', null, '', null, '5, 10, 20'],
        [null, 'F', '', '1', null, null, null, '5;10', 'x'],
        [null, 'H', '', '1', null, null, null, null, 'nee'],
        [null, 'I', '', '1', null, null, null, null, false],
        [null, 'J', '', '1', null, null, null, null, 0]
      )
    );
    expect(res.body.errors).toEqual([]);
    const exported = (await exportOf(org, res.body.catalog.id)).body.rows;
    expect(exported.map((r: any) => [r.product, r.prijsCents, r.btwBp, r.snelknoppen, r.zichtbaar])).toEqual([
      ['A', 850, 2100, null, true],
      ['B', 850, 2100, null, true],
      ['C', 850, 2100, null, true],
      ['D', 850, 2100, null, true],
      ['E', 800, null, [5, 10, 20], true],
      ['F', 100, null, [5, 10], true],
      ['H', 100, null, null, false],
      ['I', 100, null, null, false],
      ['J', 100, null, null, false],
    ]);
  });

  it('reports unreadable cells with their row number', async () => {
    const org = await seedOrg();
    const res = await importNew(
      org,
      'Fout',
      sheet(['G', 'A', '', 'acht'], [null, 'B', '', ''], [null, 'C', '', -1], [null, 'D', '', 1, null, 19], [null, 'E', '', 1, null, null, null, 'veel'], [null, 'F', '', 1, null, null, null, null, 'misschien']),
      true
    );
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(errorsOf(res.body).map(([row]) => row)).toEqual([2, 3, 4, 5, 6, 7]);
  });
});

describe('import: fill-down and product rules', () => {
  it('takes an empty Groep/Product from the row above, never the price', async () => {
    const org = await seedOrg();
    const id = await restaurant(org);
    const k = await kassa(org, id);
    expect(k.sections.map((s: any) => [s.name, s.entries.map((e: any) => [e.name, e.priceCents])])).toEqual([
      ['Drank', [['Pintje', 250], ['Duvel', 400]]],
      ['Menu', [['Steak (normaal)', 3400], ['Steak (kind)', 2600]]],
      // Dame blanche is zichtbaar=nee, so not on the kassa.
    ]);
  });

  it('needs a Groep and a Product on the first row', async () => {
    const org = await seedOrg();
    expect(errorsOf((await importNew(org, 'X', sheet([null, 'A', '', 1]), true)).body).map(([row]) => row)).toEqual([2]);
    expect(errorsOf((await importNew(org, 'X', sheet(['G', null, 'v', 1]), true)).body).map(([row]) => row)).toEqual([2]);
  });

  it('applies Categorie/BTW given on any row of a product to all its rows', async () => {
    const org = await seedOrg();
    const res = await importNew(org, 'X', sheet(['Menu', 'Steak', 'normaal', 34], ['Kids', 'Steak', 'kind', 26, 'Eten', 12]));
    expect(res.body.errors).toEqual([]);
    const rows = (await exportOf(org, res.body.catalog.id)).body.rows;
    expect(rows.map((r: any) => [r.variant, r.categorie, r.btwBp])).toEqual([
      ['normaal', 'Eten', 1200],
      ['kind', 'Eten', 1200],
    ]);
  });

  it('refuses different Categorie or BTW for one product, naming both rows', async () => {
    const org = await seedOrg();
    const res = await importNew(org, 'X', sheet(['Menu', 'Steak', 'normaal', 34, 'Eten'], [null, null, 'kind', 26, 'Kinderen']), true);
    expect(res.body.ok).toBe(false);
    expect(res.body.errors[0].message).toMatch(/Steak/);
    expect(res.body.errors[0].message).toMatch(/2.*3/);
  });

  it('refuses the same product + variant twice, and a code used twice', async () => {
    const org = await seedOrg();
    const res = await importNew(org, 'X', sheet(['G', 'Pils', '', 2], [null, 'Pils', '', 3], [null, 'Cola', '', 2, null, null, 'c'], [null, 'Fanta', '', 2, null, null, 'c']), true);
    expect(errorsOf(res.body).map(([row]) => row)).toEqual([3, 5]);
  });
});

describe('import: preview (dry run)', () => {
  it('previews a new menukaart without writing anything', async () => {
    const org = await seedOrg();
    const res = await importNew(org, 'Restaurant', RESTAURANT, true);
    expect(res.body.ok).toBe(true);
    expect(res.body.catalog).toBeUndefined();
    expect(res.body.summary).toMatchObject({
      rows: 5,
      groups: 3,
      newCategories: ['Drank', 'Eten', 'Dessert'],
      newProducts: ['Pintje', 'Duvel', 'Steak', 'Dame blanche'],
      // Only variants added to products that already exist.
      newVariants: [],
      added: ['Pintje', 'Duvel', 'Steak (normaal)', 'Steak (kind)', 'Dame blanche'],
      removed: [],
      priceChanges: [],
    });
    for (const table of ['catalogs', 'products', 'categories']) expect(await count(table, org.orgId)).toBe(0);
  });

  it('previews price changes, removals, additions and product changes against an existing menukaart', async () => {
    const org = await seedOrg();
    const id = await restaurant(org);
    const res = await importInto(
      org,
      id,
      sheet(
        ['Drank', 'Pintje', '', '2,80', 'Drank', 21, 'pintje'],
        [null, 'Duvel', '', 4, 'Bier'],
        ['Menu', 'Steak', 'normaal', 34, 'Eten', 12],
        [null, null, 'kind', 26],
        [null, 'Scampi', '', 28, 'Eten', 12]
      ),
      true
    );
    expect(res.body.ok).toBe(true);
    expect(res.body.summary).toMatchObject({
      newCategories: ['Bier'],
      newProducts: ['Scampi'],
      priceChanges: [{ name: 'Pintje', fromCents: 250, toCents: 280 }],
      added: ['Scampi'],
      removed: ['Dame blanche'],
      unchanged: 3,
    });
    expect(res.body.summary.updatedProducts).toEqual([{ name: 'Duvel', changes: ['categorie: (geen) → Bier'] }]);
    // Still a dry run.
    expect((await kassa(org, id)).sections[0].entries[0].priceCents).toBe(250);
  });
});

describe('import: apply', () => {
  it('replaces groups, order and prices exactly as in the file', async () => {
    const org = await seedOrg();
    const id = await restaurant(org);
    const res = await importInto(org, id, sheet(['Eten', 'Steak', 'kind', 25], [null, null, 'normaal', 35], ['Bar', 'Duvel', '', 4.5]));
    expect(res.body.ok).toBe(true);
    const k = await kassa(org, id);
    expect(k.sections.map((s: any) => [s.name, s.entries.map((e: any) => [e.name, e.priceCents])])).toEqual([
      ['Eten', [['Steak (kind)', 2500], ['Steak (normaal)', 3500]]],
      ['Bar', [['Duvel', 450]]],
    ]);
  });

  it('never deletes or archives products that leave the menukaart', async () => {
    const org = await seedOrg();
    const id = await restaurant(org);
    const before = await count('products', org.orgId);
    await importInto(org, id, sheet(['Drank', 'Pintje', '', 2.5]));
    expect(await count('products', org.orgId)).toBe(before);
    const archived = await env.DB.prepare('SELECT COUNT(*) AS n FROM products WHERE org_id = ? AND archived_at IS NOT NULL').bind(org.orgId).first<{ n: number }>();
    expect(archived!.n).toBe(0);
  });

  it('matches existing products by name regardless of case and spaces', async () => {
    const org = await seedOrg();
    const id = await restaurant(org);
    const before = await count('products', org.orgId);
    const res = await importInto(org, id, sheet(['Drank', '  pintje ', '', 3]), true);
    expect(res.body.summary).toMatchObject({ newProducts: [], priceChanges: [{ name: 'Pintje', fromCents: 250, toCents: 300 }] });
    expect(await count('products', org.orgId)).toBe(before);
  });

  it('renames a product when its code stays the same', async () => {
    const org = await seedOrg();
    const id = await restaurant(org);
    const res = await importInto(org, id, sheet(['Drank', 'Pintje 25cl', '', 2.5, 'Drank', 21, 'pintje']));
    expect(res.body.summary.newProducts).toEqual([]);
    expect(res.body.summary.updatedProducts).toEqual([{ name: 'Pintje 25cl', changes: ['naam: Pintje → Pintje 25cl'] }]);
    expect((await kassa(org, id)).sections[0].entries[0].name).toBe('Pintje 25cl');
  });

  it("refuses a code that belongs to another product's variant", async () => {
    const org = await seedOrg();
    const id = await restaurant(org);
    const res = await importInto(org, id, sheet(['Drank', 'Duvel', '', 4, null, null, 'pintje'], [null, 'Pintje', '', 2.5]), true);
    expect(res.body.ok).toBe(false);
    expect(res.body.errors[0].row).toBe(2);
  });

  it('refuses to apply a file with errors and writes nothing (400)', async () => {
    const org = await seedOrg();
    const id = await restaurant(org);
    const res = await importInto(org, id, sheet(['Drank', 'Pintje', '', 'gratis'], [null, 'Nieuw', '', 1]));
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect((await exportOf(org, id)).body.rows.map((r: any) => r.product)).toEqual(['Pintje', 'Duvel', 'Steak', 'Steak', 'Dame blanche']);
    expect(
      (await env.DB.prepare("SELECT COUNT(*) AS n FROM products WHERE org_id = ? AND name = 'Nieuw'").bind(org.orgId).first<{ n: number }>())!.n
    ).toBe(0);
  });

  it('creates a new menukaart from a file (the first becomes the default)', async () => {
    const org = await seedOrg();
    const res = await importNew(org, 'Restaurant', RESTAURANT);
    expect(res.body.catalog.name).toBe('Restaurant');
    const list = (await api('GET', `/organizations/${org.orgId}/catalogs`, { user: org.admin })).body;
    expect(list.map((c: any) => [c.name, c.isDefault])).toEqual([['Restaurant', true]]);
  });

  it('adds a variant to an existing product', async () => {
    const org = await seedOrg();
    const id = await restaurant(org);
    const res = await importInto(org, id, sheet(['Menu', 'Steak', 'normaal', 34], [null, null, 'kind', 26], [null, null, 'jeugd', 30]), true);
    expect(res.body.summary).toMatchObject({ newProducts: [], newVariants: ['Steak (jeugd)'], added: ['Steak (jeugd)'] });
  });

  it("leaves an existing product's categorie, BTW and code alone when the file leaves them empty", async () => {
    const org = await seedOrg();
    await restaurant(org);
    // A sparse file for another menukaart must not wipe org-level product data.
    const fuif = await importNew(org, 'Fuif', sheet(['Bar', 'Pintje', '', 3]));
    expect(fuif.body.summary.updatedProducts).toEqual([]);
    const row = (await exportOf(org, fuif.body.catalog.id)).body.rows[0];
    expect([row.categorie, row.btwBp, row.code]).toEqual(['Drank', 2100, 'pintje']);
  });

  it('keeps a product on other menukaarten untouched when replacing one', async () => {
    const org = await seedOrg();
    const a = await restaurant(org);
    const b = (await importNew(org, 'Fuif', sheet(['Bar', 'Pintje', '', 3]))).body.catalog.id;
    await importInto(org, a, sheet(['Drank', 'Duvel', '', 4]));
    expect((await kassa(org, b)).sections[0].entries.map((e: any) => [e.name, e.priceCents])).toEqual([['Pintje', 300]]);
  });
});

describe('export', () => {
  it('exports every value filled in, in kassa order, sellable entries only', async () => {
    const org = await seedOrg();
    const id = await restaurant(org);
    const { body } = await exportOf(org, id);
    expect(body.catalog.name).toBe('Restaurant');
    expect(body.rows).toEqual([
      { groep: 'Drank', product: 'Pintje', variant: '', prijsCents: 250, categorie: 'Drank', btwBp: 2100, code: 'pintje', snelknoppen: null, zichtbaar: true },
      { groep: 'Drank', product: 'Duvel', variant: '', prijsCents: 400, categorie: null, btwBp: null, code: null, snelknoppen: null, zichtbaar: true },
      { groep: 'Menu', product: 'Steak', variant: 'normaal', prijsCents: 3400, categorie: 'Eten', btwBp: 1200, code: null, snelknoppen: null, zichtbaar: true },
      { groep: 'Menu', product: 'Steak', variant: 'kind', prijsCents: 2600, categorie: 'Eten', btwBp: 1200, code: null, snelknoppen: null, zichtbaar: true },
      { groep: 'Dessert', product: 'Dame blanche', variant: '', prijsCents: 800, categorie: 'Dessert', btwBp: 600, code: null, snelknoppen: null, zichtbaar: false },
    ]);
  });

  it('round-trips: importing an export back changes nothing', async () => {
    const org = await seedOrg();
    const id = await restaurant(org);
    const exported = (await exportOf(org, id)).body.rows as any[];
    // What the console writes into the sheet: euros, VAT %, "5, 10" text, ja/nee.
    const rows = sheet(
      ...exported.map((r) => [
        r.groep,
        r.product,
        r.variant,
        r.prijsCents / 100,
        r.categorie,
        r.btwBp === null ? null : r.btwBp / 100,
        r.code,
        r.snelknoppen ? r.snelknoppen.join(', ') : null,
        r.zichtbaar ? 'ja' : 'nee',
      ])
    );
    const res = await importInto(org, id, rows, true);
    expect(res.body.ok).toBe(true);
    expect(res.body.summary).toMatchObject({ newCategories: [], newProducts: [], newVariants: [], updatedProducts: [], priceChanges: [], added: [], removed: [], unchanged: 5 });
  });

  it('leaves out entries whose product is archived', async () => {
    const org = await seedOrg();
    const id = await restaurant(org);
    const products = (await api('GET', `/organizations/${org.orgId}/catalog/products`, { user: org.admin })).body;
    const duvel = products.find((p: any) => p.name === 'Duvel');
    await api('PATCH', `/organizations/${org.orgId}/catalog/products/${duvel.id}`, { user: org.admin, body: { archived: true } });
    expect((await exportOf(org, id)).body.rows.map((r: any) => r.product)).not.toContain('Duvel');
  });
});
