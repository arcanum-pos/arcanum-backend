// Prep stations: who prepares a product (Bar, Keuken, …) — separate from
// Categorie (reporting) and Groep (kassa layout per menukaart). A product
// has an optional station; every order line copies it at sale time.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { api, createTab, DEVICE, seedOrg, tabsPath, testMenu, type TestOrg } from './helpers';

const stations = (org: TestOrg, suffix = '') => `/organizations/${org.orgId}/catalog/stations${suffix}`;
const products = (org: TestOrg, suffix = '') => `/organizations/${org.orgId}/catalog/products${suffix}`;

async function ok<T = any>(p: Promise<{ status: number; body: T }>, expected = 200): Promise<T> {
  const res = await p;
  if (res.status !== expected) throw new Error(`expected ${expected}, got ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
}

const station = (org: TestOrg, name: string) => ok(api('POST', stations(org), { user: org.admin, body: { name } }), 201);

// A product with this station on the org's test menukaart; returns what an order needs.
async function sellable(org: TestOrg, name: string, prepStationId: string | null, priceCents = 300) {
  const menu = await testMenu(org);
  const product = await ok(api('POST', products(org), { user: org.admin, body: { name, prepStationId } }), 201);
  await ok(
    api('POST', `/organizations/${org.orgId}/catalogs/${menu.catalogId}/entries`, {
      user: org.admin,
      body: { sectionId: menu.sectionId, variantId: product.variants[0].id, priceCents },
    }),
    201
  );
  return { product, catalogId: menu.catalogId, variantId: product.variants[0].id };
}

describe('stations: CRUD', () => {
  it('lists in order for members; writes are admin-only', async () => {
    const org = await seedOrg();
    await station(org, 'Bar');
    await station(org, 'Keuken');
    expect((await ok(api('GET', stations(org), { user: org.cashier }))).map((s: any) => s.name)).toEqual(['Bar', 'Keuken']);
    expect((await api('POST', stations(org), { user: org.cashier, body: { name: 'X' } })).status).toBe(403);
  });

  it('renames, and refuses empty or duplicate names (case-insensitive)', async () => {
    const org = await seedOrg();
    const bar = await station(org, 'Bar');
    await station(org, 'Keuken');
    expect((await api('POST', stations(org), { user: org.admin, body: { name: ' ' } })).status).toBe(400);
    expect((await api('POST', stations(org), { user: org.admin, body: { name: 'bar' } })).status).toBe(409);
    expect((await api('PATCH', stations(org, `/${bar.id}`), { user: org.admin, body: { name: 'KEUKEN' } })).status).toBe(409);
    await ok(api('PATCH', stations(org, `/${bar.id}`), { user: org.admin, body: { name: 'Toog' } }));
    expect((await ok(api('GET', stations(org), { user: org.admin }))).map((s: any) => s.name)).toEqual(['Toog', 'Keuken']);
  });

  it('only deletes a station no product uses (409 otherwise)', async () => {
    const org = await seedOrg();
    const used = await station(org, 'Bar');
    const unused = await station(org, 'Leeg');
    await ok(api('POST', products(org), { user: org.admin, body: { name: 'Pils', prepStationId: used.id } }), 201);
    expect((await api('DELETE', stations(org, `/${used.id}`), { user: org.admin })).status).toBe(409);
    expect((await api('DELETE', stations(org, `/${unused.id}`), { user: org.admin })).status).toBe(200);
  });
});

describe('stations: on products', () => {
  it('sets, changes and clears a product station', async () => {
    const org = await seedOrg();
    const bar = await station(org, 'Bar');
    const keuken = await station(org, 'Keuken');
    const p = await ok(api('POST', products(org), { user: org.admin, body: { name: 'Koffie', prepStationId: bar.id } }), 201);
    expect(p.prepStationId).toBe(bar.id);
    expect((await ok(api('PATCH', products(org, `/${p.id}`), { user: org.admin, body: { prepStationId: keuken.id } }))).prepStationId).toBe(keuken.id);
    expect((await ok(api('PATCH', products(org, `/${p.id}`), { user: org.admin, body: { prepStationId: null } }))).prepStationId).toBe(null);
    // Leaving the field out keeps it.
    await ok(api('PATCH', products(org, `/${p.id}`), { user: org.admin, body: { prepStationId: bar.id } }));
    expect((await ok(api('PATCH', products(org, `/${p.id}`), { user: org.admin, body: { name: 'Espresso' } }))).prepStationId).toBe(bar.id);
  });

  it("refuses another org's station (400)", async () => {
    const org = await seedOrg();
    const other = await seedOrg();
    const foreign = await station(other, 'Bar');
    expect((await api('POST', products(org), { user: org.admin, body: { name: 'X', prepStationId: foreign.id } })).status).toBe(400);
  });
});

describe('stations: copied onto order lines', () => {
  it("copies the product's station id and name onto the line at sale time", async () => {
    const org = await seedOrg();
    const bar = await station(org, 'Bar');
    const pils = await sellable(org, 'Pils', bar.id);
    const bon = await sellable(org, 'Bon', null, 100);
    const tab = await createTab(org, { catalogId: pils.catalogId, lines: [{ variantId: pils.variantId, quantity: 2 }, { variantId: bon.variantId, quantity: 1 }] });
    expect(tab.lines.map((l: any) => [l.name, l.prepStationId, l.prepStationName])).toEqual([
      ['Pils', bar.id, 'Bar'],
      ['Bon', null, null],
    ]);
  });

  it('keeps the sold station name when the station is renamed later', async () => {
    const org = await seedOrg();
    const bar = await station(org, 'Bar');
    const pils = await sellable(org, 'Pils', bar.id);
    const tab = await createTab(org, { catalogId: pils.catalogId, lines: [{ variantId: pils.variantId, quantity: 1 }] });
    await ok(api('PATCH', stations(org, `/${bar.id}`), { user: org.admin, body: { name: 'Toog' } }));
    const row = await env.DB.prepare('SELECT prep_station_name FROM order_lines WHERE tab_id = ?').bind(tab.id).first<{ prep_station_name: string }>();
    expect(row!.prep_station_name).toBe('Bar');
  });

  it('copies the station onto a void line too', async () => {
    const org = await seedOrg();
    const keuken = await station(org, 'Keuken');
    const steak = await sellable(org, 'Steak', keuken.id, 1800);
    const tab = await createTab(org, { catalogId: steak.catalogId, lines: [{ variantId: steak.variantId, quantity: 2 }] });
    const res = await api('POST', tabsPath(org.orgId, `/${tab.id}/lines/${tab.lines[0].id}/void`), { user: org.cashier, body: { ...DEVICE, reason: 'test', quantity: 1 } });
    const voidLine = res.body.lines.find((l: any) => l.voidsLineId);
    expect([voidLine.prepStationId, voidLine.prepStationName]).toEqual([keuken.id, 'Keuken']);
  });
});

describe('stations: import/export', () => {
  const importPath = (org: TestOrg) => `/organizations/${org.orgId}/catalogs/import`;
  const rows = (...r: Record<string, unknown>[]) => r.map((x, i) => ({ row: i + 2, ...x }));

  it('creates unknown stations, assigns them per product, and exports them', async () => {
    const org = await seedOrg();
    const res = await api('POST', importPath(org), {
      user: org.admin,
      body: {
        name: 'Restaurant',
        dryRun: false,
        rows: rows(
          { groep: 'Dessert', product: 'Koffie', prijs: 2.5, categorie: 'Drank', station: 'CoffeeCorner' },
          { product: 'Dame blanche', prijs: 8, categorie: 'Dessert', station: 'Keuken' },
          { groep: 'Bonnen', product: 'Bon', prijs: 1 }
        ),
      },
    });
    expect(res.body.ok).toBe(true);
    expect(res.body.summary.newStations).toEqual(['CoffeeCorner', 'Keuken']);
    const exported = (await api('GET', `/organizations/${org.orgId}/catalogs/${res.body.catalog.id}/export`, { user: org.admin })).body.rows;
    expect(exported.map((r: any) => [r.product, r.categorie, r.station])).toEqual([
      ['Koffie', 'Drank', 'CoffeeCorner'],
      ['Dame blanche', 'Dessert', 'Keuken'],
      ['Bon', null, null],
    ]);
  });

  it('matches existing stations by name, leaves them alone when empty, and reports changes', async () => {
    const org = await seedOrg();
    const bar = await station(org, 'Bar');
    const first = await api('POST', importPath(org), {
      user: org.admin,
      body: { name: 'A', dryRun: false, rows: rows({ groep: 'Drank', product: 'Pils', prijs: 2.5, station: 'bar' }, { product: 'Cola', prijs: 2.5 }) },
    });
    expect(first.body.summary.newStations).toEqual([]);
    const list = (await api('GET', products(org), { user: org.admin })).body;
    expect(list.find((p: any) => p.name === 'Pils').prepStationId).toBe(bar.id);

    // A sparse file for another menukaart doesn't touch Pils' station; Cola gets one.
    const second = await api('POST', importPath(org), {
      user: org.admin,
      body: { name: 'B', dryRun: true, rows: rows({ groep: 'Bar', product: 'Pils', prijs: 3 }, { product: 'Cola', prijs: 3, station: 'Bar' }) },
    });
    expect(second.body.summary.updatedProducts).toEqual([{ name: 'Cola', changes: ['station: (geen) → Bar'] }]);
  });

  it('refuses two different stations for one product', async () => {
    const org = await seedOrg();
    const res = await api('POST', importPath(org), {
      user: org.admin,
      body: { name: 'X', dryRun: true, rows: rows({ groep: 'G', product: 'Koffie', variant: 'klein', prijs: 2, station: 'Bar' }, { variant: 'groot', prijs: 3, station: 'CoffeeCorner' }) },
    });
    expect(res.body.ok).toBe(false);
    expect(res.body.errors[0]).toMatchObject({ row: 3 });
    expect(res.body.errors[0].message).toMatch(/Koffie/);
  });
});
