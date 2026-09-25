// Free-plan D1 limit: 50 queries per Worker invocation, every statement in a
// batch counting. The whole suite runs with that limit enforced (see
// src/query-budget.ts); these tests push the endpoints that scale with data
// to realistic sizes.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { QueryBudgetExceeded, withQueryBudget } from '../src/query-budget';
import { api, createTab, DEVICE, seedOrg, tabsPath, type TestOrg } from './helpers';

describe('query budget', () => {
  it('is enforced in this suite (counts single queries and every batch statement)', async () => {
    const budgeted = withQueryBudget(env as any);
    expect(budgeted.DB).not.toBe(env.DB);
    for (let i = 0; i < 45; i++) await budgeted.DB.prepare('SELECT 1').first();
    await budgeted.DB.batch([budgeted.DB.prepare('SELECT 1'), budgeted.DB.prepare('SELECT 2').bind()]);
    await expect(budgeted.DB.batch([1, 2, 3, 4].map(() => budgeted.DB.prepare('SELECT 1')))).rejects.toBeInstanceOf(QueryBudgetExceeded);
  });
});

// A menukaart the size of a real restaurant/bar: `products` products with
// `variantsEach` variants, spread over 8 groups, 4 categories, 3 stations.
function bigSheet(products: number, variantsEach: number) {
  const rows: Record<string, unknown>[] = [];
  let row = 2;
  for (let p = 0; p < products; p++) {
    for (let v = 0; v < variantsEach; v++) {
      rows.push({
        row: row++,
        groep: `Groep ${p % 8}`,
        product: `Product ${p}`,
        variant: variantsEach > 1 ? `v${v}` : '',
        prijs: 2 + p / 10,
        categorie: `Categorie ${p % 4}`,
        station: `Station ${p % 3}`,
        btw: 21,
        code: `c${p}-${v}`,
        snelknoppen: p === 0 ? '5, 10' : null,
      });
    }
  }
  return rows;
}

const importMenu = (org: TestOrg, body: Record<string, unknown>) => api('POST', `/organizations/${org.orgId}/catalogs/import`, { user: org.admin, body });

describe('scales within the Free-plan query limit', () => {
  it('menukaart import: 250 rows into an empty org, then a full replace', async () => {
    const org = await seedOrg();
    const rows = bigSheet(125, 2);
    const first = await importMenu(org, { name: 'Groot', rows, dryRun: false });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.summary.added).toHaveLength(250);

    // Every price changes, half the products get a new category, new variants appear.
    const changed = bigSheet(125, 3).map((r: any) => ({ ...r, prijs: (r.prijs as number) + 1, categorie: r.product.endsWith('0') ? 'Nieuw' : r.categorie }));
    const replace = await importMenu(org, { catalogId: first.body.catalog.id, rows: changed, dryRun: false });
    expect(replace.status, JSON.stringify(replace.body)).toBe(200);
    expect(replace.body.summary.newVariants).toHaveLength(125);

    const kassa = (await api('GET', `/organizations/${org.orgId}/catalogs/${first.body.catalog.id}/kassa`, { user: org.cashier })).body;
    expect(kassa.sections.flatMap((s: any) => s.entries)).toHaveLength(375);
  });

  it('menukaart: duplicate and full re-layout of a 200-line menukaart', async () => {
    const org = await seedOrg();
    const created = await importMenu(org, { name: 'Groot', rows: bigSheet(100, 2), dryRun: false });
    const id = created.body.catalog.id;
    const copy = await api('POST', `/organizations/${org.orgId}/catalogs/${id}/duplicate`, { user: org.admin, body: { name: 'Kopie' } });
    expect(copy.status, JSON.stringify(copy.body)).toBe(201);
    expect(copy.body.entryCount).toBe(200);

    const detail = (await api('GET', `/organizations/${org.orgId}/catalogs/${id}`, { user: org.admin })).body;
    const reversed = [...detail.sections].reverse().map((s: any) => ({ id: s.id, entryIds: s.entries.map((e: any) => e.id).reverse() }));
    const layout = await api('PUT', `/organizations/${org.orgId}/catalogs/${id}/layout`, { user: org.admin, body: { sections: reversed } });
    expect(layout.status, JSON.stringify(layout.body)).toBe(200);
    expect(layout.body.sections[0].id).toBe(reversed[0].id);
    expect(layout.body.sections[0].entries[0].id).toBe(reversed[0].entryIds[0]);
  });

  it('tabs: an order with 100 lines, voiding, paying', async () => {
    const org = await seedOrg();
    const created = await importMenu(org, { name: 'Groot', rows: bigSheet(100, 1), dryRun: false });
    const kassa = (await api('GET', `/organizations/${org.orgId}/catalogs/${created.body.catalog.id}/kassa`, { user: org.cashier })).body;
    const lines = kassa.sections.flatMap((s: any) => s.entries).map((e: any) => ({ variantId: e.variantId, quantity: 2 }));
    expect(lines).toHaveLength(100);

    const tab = await createTab(org, { catalogId: created.body.catalog.id, lines });
    expect(tab.lines).toHaveLength(100);
    const more = await api('POST', tabsPath(org.orgId, `/${tab.id}/orders`), { user: org.cashier, body: { ...DEVICE, catalogId: created.body.catalog.id, lines } });
    expect(more.status, JSON.stringify(more.body)).toBe(201);
    const pay = await api('POST', '/sumup/charge', { user: org.cashier, body: { orgId: org.orgId, method: 'cash', tabId: tab.id, amount: more.body.outstandingCents, ...DEVICE } });
    expect(pay.status, JSON.stringify(pay.body)).toBe(201);
  });
});

describe('charge poller sweep (runs as its own invocation)', () => {
  it('works off a backlog of stale charges within the limit, a few per run', async () => {
    const { sweepCharges } = await import('../src/payments/poller');
    const org = await seedOrg();
    const old = new Date(Date.now() - 60 * 60_000).toISOString();
    for (let i = 0; i < 15; i++) {
      await env.DB.prepare(
        `INSERT INTO charges (id, org_id, method, status, amount_cents, created_at, provider_data, tip_cents) VALUES (?, ?, 'cash', 'pending', 100, ?, '{}', 0)`
      )
        .bind(crypto.randomUUID().replace(/-/g, ''), org.orgId, old)
        .run();
    }
    let runs = 0;
    let result;
    do {
      // Every run gets its own budget, like a real alarm invocation.
      result = await sweepCharges(withQueryBudget(env as any));
      expect(result.expired).toBeLessThanOrEqual(4);
      runs++;
    } while (result.backlog && runs < 20);
    const left = await env.DB.prepare(`SELECT COUNT(*) AS n FROM charges WHERE org_id = ? AND status = 'pending'`).bind(org.orgId).first<{ n: number }>();
    expect(left!.n).toBe(0);
    expect(runs).toBeGreaterThan(1);
  });
});
