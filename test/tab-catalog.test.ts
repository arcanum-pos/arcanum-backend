// Step 3c: order lines that reference a catalog entry are priced by the
// server from that entry — the kassa's own price/name are ignored — and
// name/price/category/VAT/code are copied into the line at sale time.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { api, createTab, DEVICE, getTab, payCash, seedOrg, tabsPath, type TestOrg } from './helpers';

const cat = (orgId: string, suffix = '') => `/organizations/${orgId}/catalog${suffix}`;
const catalogs = (orgId: string, suffix = '') => `/organizations/${orgId}/catalogs${suffix}`;

async function ok<T = any>(p: Promise<{ status: number; body: T }>, expected = 200): Promise<T> {
  const res = await p;
  if (res.status !== expected) throw new Error(`expected ${expected}, got ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
}

// Fietstocht (niet-lid 800 / lid 500) in category Inschrijvingen, 6% VAT,
// on a default catalog.
async function seedCatalog(org: TestOrg) {
  const category = await ok(api('POST', cat(org.orgId, '/categories'), { user: org.admin, body: { name: 'Inschrijvingen' } }), 201);
  const product = await ok(
    api('POST', cat(org.orgId, '/products'), {
      user: org.admin,
      body: {
        name: 'Fietstocht',
        categoryId: category.id,
        vatRateBp: 600,
        variants: [
          { name: 'niet-lid', code: 'fietstocht' },
          { name: 'lid', code: 'fietstochtMember' },
        ],
      },
    }),
    201
  );
  const catalog = await ok(api('POST', catalogs(org.orgId), { user: org.admin, body: { name: 'Standaard' } }), 201);
  const section = await ok(api('POST', catalogs(org.orgId, `/${catalog.id}/sections`), { user: org.admin, body: { name: 'Tochten' } }), 201);
  const full = await ok(
    api('POST', catalogs(org.orgId, `/${catalog.id}/entries`), { user: org.admin, body: { sectionId: section.id, variantId: product.variants[0].id, priceCents: 800 } }),
    201
  );
  const member = await ok(
    api('POST', catalogs(org.orgId, `/${catalog.id}/entries`), { user: org.admin, body: { sectionId: section.id, variantId: product.variants[1].id, priceCents: 500 } }),
    201
  );
  return { catalog, section, product, full, member };
}

const variantLine = (variantId: string, quantity: number, extra: Record<string, unknown> = {}) => ({ variantId, quantity, ...extra });

describe('tabs: lines priced from the catalog', () => {
  it('prices a variant line from the catalog entry and ignores the kassa price and name', async () => {
    const org = await seedOrg();
    const c = await seedCatalog(org);
    const tab = await createTab(org, {
      catalogId: c.catalog.id,
      lines: [variantLine(c.product.variants[1].id, 2, { unitPriceCents: 1, name: 'Gratis!' })],
    });
    expect(tab.totalCents).toBe(1000);
    expect(tab.lines[0]).toMatchObject({
      name: 'Fietstocht (lid)',
      unitPriceCents: 500,
      quantity: 2,
      itemCode: 'fietstochtMember',
      variantId: c.product.variants[1].id,
      category: 'Inschrijvingen',
      vatRateBp: 600,
    });
  });

  it('records which catalog an order was sold from', async () => {
    const org = await seedOrg();
    const c = await seedCatalog(org);
    const tab = await createTab(org, { catalogId: c.catalog.id, lines: [variantLine(c.product.variants[0].id, 1)] });
    const row = await env.DB.prepare('SELECT catalog_id FROM orders WHERE tab_id = ?').bind(tab.id).first<{ catalog_id: string }>();
    expect(row!.catalog_id).toBe(c.catalog.id);
  });

  it('works the same when adding an order to an existing tab', async () => {
    const org = await seedOrg();
    const c = await seedCatalog(org);
    const tab = await createTab(org);
    const res = await api('POST', tabsPath(org.orgId, `/${tab.id}/orders`), {
      user: org.cashier,
      body: { ...DEVICE, catalogId: c.catalog.id, lines: [variantLine(c.product.variants[0].id, 3)] },
    });
    expect(res.status).toBe(201);
    expect(res.body.totalCents).toBe(2400);
  });

  it('keeps the sold price when the catalog price changes later', async () => {
    const org = await seedOrg();
    const c = await seedCatalog(org);
    const tab = await createTab(org, { catalogId: c.catalog.id, lines: [variantLine(c.product.variants[0].id, 1)] });
    await ok(api('PATCH', catalogs(org.orgId, `/${c.catalog.id}/entries/${c.full.id}`), { user: org.admin, body: { priceCents: 999 } }));
    expect((await getTab(org, tab.id)).totalCents).toBe(800);
  });

  it('derives the legacy transactions.items JSON from the variant codes', async () => {
    const org = await seedOrg();
    const c = await seedCatalog(org);
    const tab = await createTab(org, {
      catalogId: c.catalog.id,
      lines: [variantLine(c.product.variants[1].id, 2), variantLine(c.product.variants[0].id, 1)],
    });
    await payCash(org, tab.id, 1800);
    const row = await env.DB.prepare('SELECT items FROM transactions WHERE tab_id = ?').bind(tab.id).first<{ items: string }>();
    expect(JSON.parse(row!.items)).toEqual({ fietstochtMember: 2, fietstocht: 1 });
  });

  it('still accepts free lines without a variant (fooi until 3d) alongside catalog lines', async () => {
    const org = await seedOrg();
    const c = await seedCatalog(org);
    const tab = await createTab(org, {
      catalogId: c.catalog.id,
      lines: [variantLine(c.product.variants[0].id, 1), { itemCode: 'fooi', name: 'Fooi', unitPriceCents: 150, quantity: 1 }],
    });
    expect(tab.totalCents).toBe(950);
  });

  describe('refuses (400) and creates nothing when', () => {
    async function refused(org: TestOrg, body: Record<string, unknown>) {
      const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM tabs WHERE org_id = ?').bind(org.orgId).first<{ n: number }>();
      const res = await api('POST', tabsPath(org.orgId), { user: org.cashier, body: { ...DEVICE, ...body } });
      const after = await env.DB.prepare('SELECT COUNT(*) AS n FROM tabs WHERE org_id = ?').bind(org.orgId).first<{ n: number }>();
      expect(res.status).toBe(400);
      expect(after!.n).toBe(before!.n);
    }

    it('a variant line comes without a catalogId', async () => {
      const org = await seedOrg();
      const c = await seedCatalog(org);
      await refused(org, { lines: [variantLine(c.product.variants[0].id, 1)] });
    });

    it("the catalog belongs to another org", async () => {
      const org = await seedOrg();
      const other = await seedOrg();
      const c = await seedCatalog(org);
      const foreign = await seedCatalog(other);
      await refused(org, { catalogId: foreign.catalog.id, lines: [variantLine(c.product.variants[0].id, 1)] });
    });

    it('the variant is not on that catalog', async () => {
      const org = await seedOrg();
      const c = await seedCatalog(org);
      const loose = await ok(api('POST', cat(org.orgId, '/products'), { user: org.admin, body: { name: 'Niet op de kaart' } }), 201);
      await refused(org, { catalogId: c.catalog.id, lines: [variantLine(loose.variants[0].id, 1)] });
    });

    it('the entry is hidden', async () => {
      const org = await seedOrg();
      const c = await seedCatalog(org);
      await ok(api('PATCH', catalogs(org.orgId, `/${c.catalog.id}/entries/${c.full.id}`), { user: org.admin, body: { visible: false } }));
      await refused(org, { catalogId: c.catalog.id, lines: [variantLine(c.product.variants[0].id, 1)] });
    });

    it('the product is archived', async () => {
      const org = await seedOrg();
      const c = await seedCatalog(org);
      await ok(api('PATCH', cat(org.orgId, `/products/${c.product.id}`), { user: org.admin, body: { archived: true } }));
      await refused(org, { catalogId: c.catalog.id, lines: [variantLine(c.product.variants[0].id, 1)] });
    });

    it('the catalog is archived', async () => {
      const org = await seedOrg();
      const c = await seedCatalog(org);
      const other = await ok(api('POST', catalogs(org.orgId), { user: org.admin, body: { name: 'Oud' } }), 201);
      await ok(api('POST', catalogs(org.orgId, `/${other.id}/default`), { user: org.admin }));
      await ok(api('POST', catalogs(org.orgId, `/${c.catalog.id}/archive`), { user: org.admin }));
      await refused(org, { catalogId: c.catalog.id, lines: [variantLine(c.product.variants[0].id, 1)] });
    });

    it('a variant line has an invalid quantity', async () => {
      const org = await seedOrg();
      const c = await seedCatalog(org);
      await refused(org, { catalogId: c.catalog.id, lines: [variantLine(c.product.variants[0].id, 0)] });
    });
  });
});
