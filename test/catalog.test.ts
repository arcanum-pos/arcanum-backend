// Catalog API (step 3a, DOMAIN_MODEL.md): categories, products + variants
// (org-level), catalogs with sections + entries (price lives on the entry),
// the default catalog, duplicate, layout, and the compact kassa view.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { api, seedOrg, type TestOrg } from './helpers';

const cat = (orgId: string, suffix = '') => `/organizations/${orgId}/catalog${suffix}`;
const catalogs = (orgId: string, suffix = '') => `/organizations/${orgId}/catalogs${suffix}`;

async function ok<T = any>(p: Promise<{ status: number; body: T }>, expected = 200): Promise<T> {
  const res = await p;
  if (res.status !== expected) throw new Error(`expected ${expected}, got ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
}

async function category(org: TestOrg, name: string) {
  return ok(api('POST', cat(org.orgId, '/categories'), { user: org.admin, body: { name } }), 201);
}

async function product(org: TestOrg, body: Record<string, unknown>) {
  return ok(api('POST', cat(org.orgId, '/products'), { user: org.admin, body }), 201);
}

async function catalog(org: TestOrg, name: string) {
  return ok(api('POST', catalogs(org.orgId), { user: org.admin, body: { name } }), 201);
}

async function section(org: TestOrg, catalogId: string, name: string) {
  return ok(api('POST', catalogs(org.orgId, `/${catalogId}/sections`), { user: org.admin, body: { name } }), 201);
}

async function entry(org: TestOrg, catalogId: string, body: Record<string, unknown>) {
  return ok(api('POST', catalogs(org.orgId, `/${catalogId}/entries`), { user: org.admin, body }), 201);
}

async function getCatalog(org: TestOrg, catalogId: string) {
  return ok(api('GET', catalogs(org.orgId, `/${catalogId}`), { user: org.admin }));
}

// Drinks catalog: a Pils (single variant) and Steak (volwassene/kind) in
// two sections.
async function sampleCatalog(org: TestOrg) {
  const drank = await category(org, 'Drank');
  const eten = await category(org, 'Eten');
  const pils = await product(org, { name: 'Pils', categoryId: drank.id, vatRateBp: 2100, variants: [{ name: '', code: 'pils' }] });
  const steak = await product(org, {
    name: 'Steak',
    categoryId: eten.id,
    vatRateBp: 1200,
    variants: [
      { name: 'volwassene', code: 'steak' },
      { name: 'kind', code: 'steak-kind' },
    ],
  });
  const c = await catalog(org, 'Kaas & wijn 2026');
  const s1 = await section(org, c.id, 'Drank');
  const s2 = await section(org, c.id, 'Eten');
  const ePils = await entry(org, c.id, { sectionId: s1.id, variantId: pils.variants[0].id, priceCents: 250 });
  const eSteak = await entry(org, c.id, { sectionId: s2.id, variantId: steak.variants[0].id, priceCents: 1800 });
  const eKind = await entry(org, c.id, { sectionId: s2.id, variantId: steak.variants[1].id, priceCents: 1200 });
  return { drank, eten, pils, steak, catalog: c, s1, s2, ePils, eSteak, eKind };
}

describe('catalog: auth', () => {
  it('requires identity (401) and membership (403)', async () => {
    const org = await seedOrg();
    const other = await seedOrg();
    expect((await api('GET', catalogs(org.orgId), { user: null })).status).toBe(401);
    expect((await api('GET', catalogs(other.orgId), { user: org.admin })).status).toBe(403);
  });

  it('lets a cashier read but not write', async () => {
    const org = await seedOrg();
    const { catalog: c } = await sampleCatalog(org);
    expect((await api('GET', catalogs(org.orgId), { user: org.cashier })).status).toBe(200);
    expect((await api('GET', catalogs(org.orgId, `/${c.id}/kassa`), { user: org.cashier })).status).toBe(200);
    expect((await api('POST', catalogs(org.orgId), { user: org.cashier, body: { name: 'X' } })).status).toBe(403);
    expect((await api('POST', cat(org.orgId, '/products'), { user: org.cashier, body: { name: 'X' } })).status).toBe(403);
    expect((await api('POST', cat(org.orgId, '/categories'), { user: org.cashier, body: { name: 'X' } })).status).toBe(403);
  });
});

describe('catalog: categories', () => {
  it('creates, lists in position order and renames', async () => {
    const org = await seedOrg();
    const a = await category(org, 'Drank');
    const b = await category(org, 'Eten');
    expect(a.position).toBeLessThan(b.position);
    await ok(api('PATCH', cat(org.orgId, `/categories/${a.id}`), { user: org.admin, body: { name: 'Dranken' } }));
    const list = await ok(api('GET', cat(org.orgId, '/categories'), { user: org.cashier }));
    expect(list.map((c: any) => c.name)).toEqual(['Dranken', 'Eten']);
  });

  it('refuses an empty name (400)', async () => {
    const org = await seedOrg();
    expect((await api('POST', cat(org.orgId, '/categories'), { user: org.admin, body: { name: ' ' } })).status).toBe(400);
  });

  it('only deletes a category no product uses (409 otherwise)', async () => {
    const org = await seedOrg();
    const used = await category(org, 'Drank');
    const unused = await category(org, 'Leeg');
    await product(org, { name: 'Pils', categoryId: used.id });
    expect((await api('DELETE', cat(org.orgId, `/categories/${used.id}`), { user: org.admin })).status).toBe(409);
    expect((await api('DELETE', cat(org.orgId, `/categories/${unused.id}`), { user: org.admin })).status).toBe(200);
  });
});

describe('catalog: products and variants', () => {
  it('gives a product without explicit variants one unnamed default variant', async () => {
    const org = await seedOrg();
    const p = await product(org, { name: 'Pils' });
    expect(p.variants).toHaveLength(1);
    expect(p.variants[0].name).toBe('');
  });

  it('creates a product with several variants, in order', async () => {
    const org = await seedOrg();
    const p = await product(org, { name: 'Fietstocht', variants: [{ name: 'niet-lid', code: 'fietstocht' }, { name: 'lid', code: 'fietstochtMember' }] });
    expect(p.variants.map((v: any) => v.name)).toEqual(['niet-lid', 'lid']);
    expect(p.variants.map((v: any) => v.code)).toEqual(['fietstocht', 'fietstochtMember']);
  });

  it('validates name, VAT and category ownership (400)', async () => {
    const org = await seedOrg();
    const other = await seedOrg();
    const foreign = await category(other, 'Drank');
    const post = (body: any) => api('POST', cat(org.orgId, '/products'), { user: org.admin, body });
    expect((await post({ name: '' })).status).toBe(400);
    expect((await post({ name: 'X', vatRateBp: 21.5 })).status).toBe(400);
    expect((await post({ name: 'X', vatRateBp: -1 })).status).toBe(400);
    expect((await post({ name: 'X', categoryId: foreign.id })).status).toBe(400);
  });

  it('keeps variant codes unique per org among active variants', async () => {
    const org = await seedOrg();
    const other = await seedOrg();
    const p = await product(org, { name: 'Pils', variants: [{ name: '', code: 'pils' }] });
    expect((await api('POST', cat(org.orgId, '/products'), { user: org.admin, body: { name: 'Pils 2', variants: [{ name: '', code: 'pils' }] } })).status).toBe(409);
    // Another org may use the same code.
    await product(other, { name: 'Pils', variants: [{ name: '', code: 'pils' }] });
    // Once archived, the code is free again.
    await ok(api('PATCH', cat(org.orgId, `/products/${p.id}`), { user: org.admin, body: { archived: true } }));
    await product(org, { name: 'Pils nieuw', variants: [{ name: '', code: 'pils' }] });
  });

  it('adds, renames and archives variants, but never the last active one (409)', async () => {
    const org = await seedOrg();
    const p = await product(org, { name: 'Steak', variants: [{ name: 'volwassene' }] });
    const kind = await ok(api('POST', cat(org.orgId, `/products/${p.id}/variants`), { user: org.admin, body: { name: 'kind' } }), 201);
    await ok(api('PATCH', cat(org.orgId, `/variants/${kind.id}`), { user: org.admin, body: { name: 'kinderen' } }));
    await ok(api('PATCH', cat(org.orgId, `/variants/${p.variants[0].id}`), { user: org.admin, body: { archived: true } }));
    expect((await api('PATCH', cat(org.orgId, `/variants/${kind.id}`), { user: org.admin, body: { archived: true } })).status).toBe(409);

    const list = await ok(api('GET', cat(org.orgId, '/products'), { user: org.admin }));
    const steak = list.find((x: any) => x.id === p.id);
    expect(steak.variants.map((v: any) => [v.name, v.archived])).toEqual([
      ['volwassene', true],
      ['kinderen', false],
    ]);
  });

  it('restores only the variants archived together with the product', async () => {
    const org = await seedOrg();
    const p = await product(org, { name: 'Steak', variants: [{ name: 'volwassene', code: 's1' }, { name: 'kind', code: 's2' }] });
    await ok(api('PATCH', cat(org.orgId, `/variants/${p.variants[1].id}`), { user: org.admin, body: { archived: true } }));
    await ok(api('PATCH', cat(org.orgId, `/products/${p.id}`), { user: org.admin, body: { archived: true } }));
    const restored = await ok(api('PATCH', cat(org.orgId, `/products/${p.id}`), { user: org.admin, body: { archived: false } }));
    expect(restored.variants.map((v: any) => [v.name, v.archived])).toEqual([
      ['volwassene', false],
      ['kind', true],
    ]);
  });

  it('refuses to unarchive a product whose code was reused meanwhile (409)', async () => {
    const org = await seedOrg();
    const old = await product(org, { name: 'Pils', variants: [{ name: '', code: 'pils' }] });
    await ok(api('PATCH', cat(org.orgId, `/products/${old.id}`), { user: org.admin, body: { archived: true } }));
    await product(org, { name: 'Pils nieuw', variants: [{ name: '', code: 'pils' }] });
    expect((await api('PATCH', cat(org.orgId, `/products/${old.id}`), { user: org.admin, body: { archived: false } })).status).toBe(409);
  });

  it('hides archived products from the product list unless asked', async () => {
    const org = await seedOrg();
    const p = await product(org, { name: 'Oud' });
    await ok(api('PATCH', cat(org.orgId, `/products/${p.id}`), { user: org.admin, body: { archived: true } }));
    expect((await ok(api('GET', cat(org.orgId, '/products'), { user: org.admin }))).some((x: any) => x.id === p.id)).toBe(false);
    expect((await ok(api('GET', cat(org.orgId, '/products?includeArchived=1'), { user: org.admin }))).some((x: any) => x.id === p.id)).toBe(true);
  });
});

describe('catalogs', () => {
  it("makes an org's first catalog its default, later ones not", async () => {
    const org = await seedOrg();
    const first = await catalog(org, 'Standaard');
    const second = await catalog(org, 'Zomer');
    expect(first.isDefault).toBe(true);
    expect(second.isDefault).toBe(false);
  });

  it('switches the default so there is always exactly one', async () => {
    const org = await seedOrg();
    await catalog(org, 'Standaard');
    const zomer = await catalog(org, 'Zomer');
    await ok(api('POST', catalogs(org.orgId, `/${zomer.id}/default`), { user: org.admin }));
    const list = await ok(api('GET', catalogs(org.orgId), { user: org.admin }));
    expect(list.filter((c: any) => c.isDefault).map((c: any) => c.name)).toEqual(['Zomer']);
  });

  it('refuses to archive the default catalog (409) but archives another', async () => {
    const org = await seedOrg();
    const std = await catalog(org, 'Standaard');
    const oud = await catalog(org, 'Oud');
    expect((await api('POST', catalogs(org.orgId, `/${std.id}/archive`), { user: org.admin })).status).toBe(409);
    await ok(api('POST', catalogs(org.orgId, `/${oud.id}/archive`), { user: org.admin }));
    const list = await ok(api('GET', catalogs(org.orgId), { user: org.admin }));
    expect(list.map((c: any) => c.name)).toEqual(['Standaard']);
  });

  it('returns sections with their entries, prices and display names', async () => {
    const org = await seedOrg();
    const s = await sampleCatalog(org);
    const c = await getCatalog(org, s.catalog.id);
    expect(c.sections.map((x: any) => x.name)).toEqual(['Drank', 'Eten']);
    const eten = c.sections[1];
    expect(eten.entries.map((e: any) => [e.displayName, e.priceCents, e.categoryName])).toEqual([
      ['Steak (volwassene)', 1800, 'Eten'],
      ['Steak (kind)', 1200, 'Eten'],
    ]);
    expect(c.sections[0].entries[0].displayName).toBe('Pils');
  });

  it('prices the same product differently per catalog', async () => {
    const org = await seedOrg();
    const s = await sampleCatalog(org);
    const other = await catalog(org, 'Fuif');
    const sec = await section(org, other.id, 'Bar');
    await entry(org, other.id, { sectionId: sec.id, variantId: s.pils.variants[0].id, priceCents: 300 });
    expect((await getCatalog(org, other.id)).sections[0].entries[0].priceCents).toBe(300);
    expect((await getCatalog(org, s.catalog.id)).sections[0].entries[0].priceCents).toBe(250);
  });

  it('validates entries: price, one entry per variant, same-org variant and section', async () => {
    const org = await seedOrg();
    const other = await seedOrg();
    const s = await sampleCatalog(org);
    const foreign = await product(other, { name: 'Cola' });
    const otherCatalog = await catalog(org, 'Ander');
    const otherSection = await section(org, otherCatalog.id, 'X');
    const post = (body: any) => api('POST', catalogs(org.orgId, `/${s.catalog.id}/entries`), { user: org.admin, body });
    expect((await post({ sectionId: s.s1.id, variantId: s.pils.variants[0].id, priceCents: 100 })).status).toBe(409);
    expect((await post({ sectionId: s.s1.id, variantId: foreign.variants[0].id, priceCents: 100 })).status).toBe(400);
    expect((await post({ sectionId: otherSection.id, variantId: s.steak.variants[0].id, priceCents: 100 })).status).toBe(400);
    const fresh = await product(org, { name: 'Water' });
    expect((await post({ sectionId: s.s1.id, variantId: fresh.variants[0].id, priceCents: -5 })).status).toBe(400);
    expect((await post({ sectionId: s.s1.id, variantId: fresh.variants[0].id, priceCents: 1.5 })).status).toBe(400);
    expect((await post({ sectionId: s.s1.id, variantId: fresh.variants[0].id, priceCents: 100, quickQuantities: [0] })).status).toBe(400);
  });

  it('updates an entry (price, visibility, quick quantities) and deletes one', async () => {
    const org = await seedOrg();
    const s = await sampleCatalog(org);
    const path = catalogs(org.orgId, `/${s.catalog.id}/entries/${s.ePils.id}`);
    await ok(api('PATCH', path, { user: org.admin, body: { priceCents: 275, visible: false, quickQuantities: [6, 12] } }));
    const e = (await getCatalog(org, s.catalog.id)).sections[0].entries[0];
    expect([e.priceCents, e.visible, e.quickQuantities]).toEqual([275, false, [6, 12]]);
    await ok(api('DELETE', path, { user: org.admin }));
    expect((await getCatalog(org, s.catalog.id)).sections[0].entries).toHaveLength(0);
  });

  it('deleting a section removes its entries', async () => {
    const org = await seedOrg();
    const s = await sampleCatalog(org);
    await ok(api('DELETE', catalogs(org.orgId, `/${s.catalog.id}/sections/${s.s2.id}`), { user: org.admin }));
    const c = await getCatalog(org, s.catalog.id);
    expect(c.sections.map((x: any) => x.name)).toEqual(['Drank']);
    const { results } = await env.DB.prepare('SELECT COUNT(*) AS n FROM catalog_entries WHERE section_id = ?').bind(s.s2.id).all<{ n: number }>();
    expect(results[0].n).toBe(0);
  });

  it('duplicates a catalog into an independent copy', async () => {
    const org = await seedOrg();
    const s = await sampleCatalog(org);
    const copy = await ok(api('POST', catalogs(org.orgId, `/${s.catalog.id}/duplicate`), { user: org.admin, body: { name: 'Kaas & wijn 2027' } }), 201);
    expect(copy.isDefault).toBe(false);
    const full = await getCatalog(org, copy.id);
    expect(full.sections.map((x: any) => [x.name, x.entries.length])).toEqual([
      ['Drank', 1],
      ['Eten', 2],
    ]);
    // Editing the copy leaves the original untouched.
    await ok(api('PATCH', catalogs(org.orgId, `/${copy.id}/entries/${full.sections[0].entries[0].id}`), { user: org.admin, body: { priceCents: 300 } }));
    expect((await getCatalog(org, s.catalog.id)).sections[0].entries[0].priceCents).toBe(250);
  });

  it('reorders sections and moves entries between them with one layout call', async () => {
    const org = await seedOrg();
    const s = await sampleCatalog(org);
    await ok(
      api('PUT', catalogs(org.orgId, `/${s.catalog.id}/layout`), {
        user: org.admin,
        body: {
          sections: [
            { id: s.s2.id, entryIds: [s.eKind.id, s.eSteak.id] },
            { id: s.s1.id, entryIds: [s.ePils.id] },
          ],
        },
      })
    );
    const c = await getCatalog(org, s.catalog.id);
    expect(c.sections.map((x: any) => [x.name, x.entries.map((e: any) => e.displayName)])).toEqual([
      ['Eten', ['Steak (kind)', 'Steak (volwassene)']],
      ['Drank', ['Pils']],
    ]);

    // Moving Pils into Eten.
    await ok(
      api('PUT', catalogs(org.orgId, `/${s.catalog.id}/layout`), {
        user: org.admin,
        body: {
          sections: [
            { id: s.s2.id, entryIds: [s.ePils.id, s.eKind.id, s.eSteak.id] },
            { id: s.s1.id, entryIds: [] },
          ],
        },
      })
    );
    expect((await getCatalog(org, s.catalog.id)).sections[0].entries.map((e: any) => e.displayName)).toEqual(['Pils', 'Steak (kind)', 'Steak (volwassene)']);
  });

  it('refuses a layout that leaves out or invents sections/entries (400)', async () => {
    const org = await seedOrg();
    const s = await sampleCatalog(org);
    const put = (sections: any) => api('PUT', catalogs(org.orgId, `/${s.catalog.id}/layout`), { user: org.admin, body: { sections } });
    expect((await put([{ id: s.s1.id, entryIds: [s.ePils.id] }])).status).toBe(400);
    expect(
      (
        await put([
          { id: s.s1.id, entryIds: [s.ePils.id] },
          { id: s.s2.id, entryIds: [s.eSteak.id] },
        ])
      ).status
    ).toBe(400);
    expect(
      (
        await put([
          { id: s.s1.id, entryIds: [s.ePils.id, 'nope'] },
          { id: s.s2.id, entryIds: [s.eSteak.id, s.eKind.id] },
        ])
      ).status
    ).toBe(400);
  });

  it("does not expose another org's catalog (404)", async () => {
    const org = await seedOrg();
    const other = await seedOrg();
    const foreign = await catalog(other, 'X');
    expect((await api('GET', catalogs(org.orgId, `/${foreign.id}`), { user: org.admin })).status).toBe(404);
  });
});

describe('catalog: kassa view', () => {
  it('serves the default catalog with only sellable, visible entries', async () => {
    const org = await seedOrg();
    const s = await sampleCatalog(org);
    // Hidden entry, archived product, and a section left empty by that.
    await ok(api('PATCH', catalogs(org.orgId, `/${s.catalog.id}/entries/${s.eKind.id}`), { user: org.admin, body: { visible: false } }));
    await ok(api('PATCH', cat(org.orgId, `/products/${s.pils.id}`), { user: org.admin, body: { archived: true } }));

    const k = await ok(api('GET', catalogs(org.orgId, '/default/kassa'), { user: org.cashier }));
    expect(k.id).toBe(s.catalog.id);
    expect(k.sections.map((x: any) => x.name)).toEqual(['Eten']);
    expect(k.sections[0].entries).toEqual([
      {
        entryId: s.eSteak.id,
        variantId: s.steak.variants[0].id,
        name: 'Steak (volwassene)',
        priceCents: 1800,
        code: 'steak',
        categoryName: 'Eten',
        quickQuantities: null,
      },
    ]);
  });

  it('also serves a specific (device-chosen) catalog', async () => {
    const org = await seedOrg();
    await sampleCatalog(org);
    const fuif = await catalog(org, 'Fuif');
    const k = await ok(api('GET', catalogs(org.orgId, `/${fuif.id}/kassa`), { user: org.cashier }));
    expect(k.name).toBe('Fuif');
    expect(k.sections).toEqual([]);
  });

  it('404s when the org has no catalog yet, or the catalog is archived', async () => {
    const org = await seedOrg();
    expect((await api('GET', catalogs(org.orgId, '/default/kassa'), { user: org.cashier })).status).toBe(404);
    await catalog(org, 'Standaard');
    const oud = await catalog(org, 'Oud');
    await ok(api('POST', catalogs(org.orgId, `/${oud.id}/archive`), { user: org.admin }));
    expect((await api('GET', catalogs(org.orgId, `/${oud.id}/kassa`), { user: org.cashier })).status).toBe(404);
  });
});
