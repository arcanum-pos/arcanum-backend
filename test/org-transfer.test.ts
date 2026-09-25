// Org data export / import (self-hosting move): export one org's data as
// readable JSON (secrets decrypted only on request), import it as a new org
// — on another installation, or as a copy on this one — in browser-driven
// steps (start → chunk per table → finish) that stay far below D1's
// per-invocation query limit on the Free plan.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { EXPORT_TABLES } from '../src/org-transfer';
import { getDecryptedPaymentCredential } from '../src/organizations/payment-credentials';
import { api, chargeCash, confirmCharge, createTab, DEVICE, rows, seedOrg, tabsPath, type TestOrg, type TestUser } from './helpers';

const exportOf = (org: TestOrg, query = '', user: TestUser = org.admin) => api('GET', `/organizations/${org.orgId}/export${query}`, { user });

// An org with a bit of everything: a menukaart with a station, members, a
// paid tab with a tip and a void, an open tab, a pending charge, payment
// credentials.
async function richOrg() {
  const org = await seedOrg();
  await api('POST', `/organizations/${org.orgId}/members`, { user: org.admin, body: { email: 'kok@example.test', role: 'cashier' } });
  await api('PUT', `/organizations/${org.orgId}/payment-credentials/sumup`, { user: org.admin, body: { merchantCode: 'M123', apiKey: 'sup3r-secret' } });
  const imported = await api('POST', `/organizations/${org.orgId}/catalogs/import`, {
    user: org.admin,
    body: {
      name: 'Restaurant',
      dryRun: false,
      rows: [
        { row: 2, groep: 'Drank', product: 'Pintje', prijs: 2.5, categorie: 'Drank', station: 'Bar', btw: 21, code: 'pintje' },
        { row: 3, groep: 'Menu', product: 'Steak', variant: 'normaal', prijs: 34, categorie: 'Menu', station: 'Keuken' },
        { row: 4, variant: 'kind', prijs: 26 },
      ],
    },
  });
  const catalogId = imported.body.catalog.id;
  const kassa = (await api('GET', `/organizations/${org.orgId}/catalogs/${catalogId}/kassa`, { user: org.cashier })).body;
  const [pintje, steak] = [kassa.sections[0].entries[0], kassa.sections[1].entries[0]];

  const paid = await createTab(org, { label: 'Tafel 1', catalogId, lines: [{ variantId: pintje.variantId, quantity: 4 }, { variantId: steak.variantId, quantity: 2 }] });
  await api('POST', tabsPath(org.orgId, `/${paid.id}/lines/${paid.lines[1].id}/void`), { user: org.cashier, body: { ...DEVICE, reason: 'test', quantity: 1 } });
  const charge = await chargeCash(org, paid.id, 1000 + 3400 + 200, { tipCents: 200 });
  await confirmCharge(org, charge.body.chargeId);
  const open = await createTab(org, { label: 'Jan', catalogId, lines: [{ variantId: pintje.variantId, quantity: 1 }] });
  const pending = await chargeCash(org, open.id, 250);
  return { org, catalogId, paidTabId: paid.id, openTabId: open.id, pendingChargeId: pending.body.chargeId as string };
}

// Drives an import the way the console does: start, chunks per table, finish.
async function importFile(file: any, user: TestUser, chunkSize = 1000) {
  const start = await api('POST', '/organizations/import/start', { user, body: { manifest: manifestOf(file) } });
  if (start.status !== 201) throw new Error(`start: ${start.status} ${JSON.stringify(start.body)}`);
  const orgId = start.body.orgId as string;
  for (const table of start.body.tables as string[]) {
    const all = file.tables[table] || [];
    for (let i = 0; i < all.length; i += chunkSize) {
      const res = await api('POST', `/organizations/${orgId}/import/chunk`, { user, body: { table, rows: all.slice(i, i + chunkSize) } });
      if (res.status !== 200) throw new Error(`chunk ${table}: ${res.status} ${JSON.stringify(res.body)}`);
    }
  }
  const finish = await api('POST', `/organizations/${orgId}/import/finish`, { user });
  return { orgId, finish };
}

function manifestOf(file: any) {
  return {
    format: file.format,
    version: file.version,
    organization: file.organization,
    counts: Object.fromEntries(Object.entries(file.tables).map(([k, v]) => [k, (v as unknown[]).length])),
  };
}

function importer(): TestUser {
  const sub = `importer-${crypto.randomUUID()}`;
  return { sub, issuer: 'https://new-instance.test/', name: 'Nieuwe beheerder', email: `${sub}@test` };
}

describe('export', () => {
  it('is admin-only', async () => {
    const org = await seedOrg();
    expect((await exportOf(org, '', org.cashier)).status).toBe(403);
    expect((await api('GET', `/organizations/${org.orgId}/export`, { user: null })).status).toBe(401);
  });

  it("exports the org's own data as readable JSON, and nothing of another org", async () => {
    const { org } = await richOrg();
    const other = await richOrg();
    const { status, body } = await exportOf(org);
    expect(status).toBe(200);
    expect(body).toMatchObject({ format: 'arcanum-org-export', version: 1, includesSecrets: false, organization: { name: 'Test org' } });
    expect(body.tables.products.map((p: any) => p.name).sort()).toEqual(['Pintje', 'Steak']);
    expect(body.tables.tabs).toHaveLength(2);
    for (const rowsOfTable of Object.values(body.tables) as any[][]) {
      for (const r of rowsOfTable) if ('org_id' in r) expect(r.org_id).toBe(org.orgId);
    }
    expect(JSON.stringify(body)).not.toContain(other.org.orgId);
  });

  it('never exports the org key, custom domain or identity provider', async () => {
    const { org } = await richOrg();
    const { body } = await exportOf(org, '?secrets=1');
    const text = JSON.stringify(body);
    for (const forbidden of ['dek_ciphertext', 'dek_iv', 'custom_domain', 'client_secret']) expect(text).not.toContain(forbidden);
    expect(body.tables.identity_providers).toBeUndefined();
  });

  it('leaves secrets out by default and includes them decrypted only on request', async () => {
    const { org } = await richOrg();
    expect((await exportOf(org)).body.tables.payment_provider_credentials).toBeUndefined();
    const withSecrets = (await exportOf(org, '?secrets=1')).body;
    expect(withSecrets.includesSecrets).toBe(true);
    expect(withSecrets.tables.payment_provider_credentials).toEqual([
      expect.objectContaining({ provider: 'sumup', config: { merchantCode: 'M123', apiKey: 'sup3r-secret' } }),
    ]);
  });

  it('exports every column of every table, except the ones deliberately left out', async () => {
    // Guards against a future migration adding a column the export forgets.
    for (const spec of EXPORT_TABLES) {
      const { results } = await env.DB.prepare(`SELECT name FROM pragma_table_info('${spec.table}')`).all<{ name: string }>();
      const handled = new Set([...spec.columns, ...Object.keys(spec.excluded)]);
      expect(results.map((r) => r.name).filter((c) => !handled.has(c)), spec.table).toEqual([]);
    }
  });
});

describe('import', () => {
  it('recreates the org as a new org with new ids, for the importing user as admin', async () => {
    const source = await richOrg();
    const file = (await exportOf(source.org, '?secrets=1')).body;
    const user = importer();
    const { orgId, finish } = await importFile(file, user);

    expect(finish.status).toBe(200);
    expect(finish.body.ok).toBe(true);
    expect(orgId).not.toBe(source.org.orgId);
    const org = (await api('GET', `/organizations/${orgId}`, { user })).body;
    expect(org).toMatchObject({ name: 'Test org', importStatus: null });

    // Same content, all-new ids.
    const copy = (await api('GET', `/organizations/${orgId}/export?secrets=1`, { user })).body;
    // Same row counts everywhere; memberships gain the importing admin.
    for (const table of Object.keys(file.tables)) expect(copy.tables[table]?.length ?? 0, table).toBe(file.tables[table].length + (table === 'memberships' ? 1 : 0));
    const sourceIds = new Set(Object.values(file.tables).flatMap((t: any) => t.map((r: any) => r.id).filter(Boolean)));
    for (const t of Object.values(copy.tables) as any[][]) for (const r of t) if (r.id) expect(sourceIds.has(r.id)).toBe(false);
  });

  it('keeps menukaart, prices, stations, tab numbers, receipts and the sales report identical', async () => {
    const source = await richOrg();
    const file = (await exportOf(source.org, '?secrets=1')).body;
    const user = importer();
    const { orgId } = await importFile(file, user);

    const kassaOf = async (id: string, u: TestUser, catalog = 'default') => (await api('GET', `/organizations/${id}/catalogs/${catalog}/kassa`, { user: u })).body;
    const strip = (k: any) => k.sections.map((s: any) => [s.name, s.entries.map((e: any) => [e.name, e.priceCents, e.code])]);
    expect(strip(await kassaOf(orgId, user))).toEqual(strip(await kassaOf(source.org.orgId, source.org.cashier)));

    const range = `from=2000-01-01T00:00:00.000Z&to=2100-01-01T00:00:00.000Z`;
    const reportOf = async (id: string, u: TestUser) => (await api('GET', `/organizations/${id}/reports/sales?${range}`, { user: u })).body;
    const [a, b] = [await reportOf(source.org.orgId, source.org.admin), await reportOf(orgId, user)];
    expect(b.sales).toEqual(a.sales);
    expect(b.payments).toEqual(a.payments);
    expect(b.openTabs).toEqual(a.openTabs);

    const tabsOf = async (id: string) =>
      (await rows<{ number: number; label: string; status: string; receipt_number: number | null }>('SELECT number, label, status, receipt_number FROM tabs WHERE org_id = ? ORDER BY number', id));
    expect(await tabsOf(orgId)).toEqual(await tabsOf(source.org.orgId));

    const stationNames = await rows<{ prep_station_name: string | null }>('SELECT prep_station_name FROM order_lines WHERE org_id = ? ORDER BY created_at, rowid', orgId);
    expect(stationNames.map((r) => r.prep_station_name)).toContain('Keuken');
  });

  it('never references anything outside the new org (every id column is remapped)', async () => {
    // A same-installation import would still "work" if a reference kept
    // pointing at the source org's rows — on a new installation it would
    // not. So: every reference must resolve inside the imported org.
    const REFERS_TO: Record<string, string> = {
      category_id: 'categories',
      prep_station_id: 'prep_stations',
      product_id: 'products',
      catalog_id: 'catalogs',
      section_id: 'catalog_sections',
      variant_id: 'product_variants',
      tab_id: 'tabs',
      order_id: 'orders',
      event_id: 'events',
      voids_line_id: 'order_lines',
    };
    const source = await richOrg();
    const user = importer();
    const { orgId } = await importFile((await exportOf(source.org, '?secrets=1')).body, user);
    let checked = 0;
    for (const spec of EXPORT_TABLES) {
      // Every reference column the table has — not just the ones listed in
      // spec.remap, or forgetting one there would also skip checking it.
      for (const column of spec.columns.filter((c) => c.endsWith('_id') && !['device_id', 'opened_device_id', 'slot_id'].includes(c))) {
        const target = REFERS_TO[column];
        expect(target, `${spec.table}.${column} needs a REFERS_TO entry`).toBeDefined();
        const dangling = await rows(
          `SELECT ${column} AS ref FROM ${spec.table} WHERE org_id = ? AND ${column} IS NOT NULL
             AND ${column} NOT IN (SELECT id FROM ${target} WHERE org_id = ?)`,
          orgId,
          orgId
        );
        expect(dangling, `${spec.table}.${column}`).toEqual([]);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(10);
  });

  it('continues tab numbering after the imported tabs', async () => {
    const source = await richOrg();
    const user = importer();
    const { orgId } = await importFile((await exportOf(source.org)).body, user);
    const next = await api('POST', tabsPath(orgId), { user, body: { ...DEVICE, label: 'Nieuw' } });
    expect(next.body.number).toBe(3);
  });

  it('turns members into pending invites (the importer is the active admin)', async () => {
    const source = await richOrg();
    const user = importer();
    const { orgId } = await importFile((await exportOf(source.org)).body, user);
    const members = await rows<{ invited_email: string; role: string; status: string; user_sub: string | null }>(
      'SELECT invited_email, role, status, user_sub FROM memberships WHERE org_id = ? ORDER BY invited_email',
      orgId
    );
    const mine = members.find((m) => m.invited_email === user.email)!;
    expect(mine).toMatchObject({ role: 'admin', status: 'active', user_sub: user.sub });
    const others = members.filter((m) => m.invited_email !== user.email);
    expect(others.length).toBe(3); // admin, cashier, kok
    for (const m of others) expect(m).toMatchObject({ status: 'pending', user_sub: null });
    expect(others.find((m) => m.invited_email === 'kok@example.test')!.role).toBe('cashier');
  });

  it('re-encrypts imported secrets with the new org key', async () => {
    const source = await richOrg();
    const user = importer();
    const { orgId } = await importFile((await exportOf(source.org, '?secrets=1')).body, user);
    expect(await getDecryptedPaymentCredential(env, orgId, 'sumup')).toEqual({ merchantCode: 'M123', apiKey: 'sup3r-secret' });
  });

  it('imports a charge that was still pending as failed, without provider data', async () => {
    const source = await richOrg();
    const user = importer();
    const { orgId } = await importFile((await exportOf(source.org)).body, user);
    const charges = await rows<{ status: string; provider_data: string | null; pos_terminal_id: string | null }>(
      'SELECT status, provider_data, pos_terminal_id FROM charges WHERE org_id = ? ORDER BY created_at',
      orgId
    );
    expect(charges.map((c) => c.status)).toEqual(['succeeded', 'failed']);
    for (const c of charges) expect([c.provider_data, c.pos_terminal_id]).toEqual(['{}', null]);
  });

  it('is safe to retry a chunk (nothing imported twice)', async () => {
    const source = await richOrg();
    const file = (await exportOf(source.org)).body;
    const user = importer();
    const start = await api('POST', '/organizations/import/start', { user, body: { manifest: manifestOf(file) } });
    const orgId = start.body.orgId;
    for (const table of start.body.tables) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await api('POST', `/organizations/${orgId}/import/chunk`, { user, body: { table, rows: file.tables[table] || [] } });
        expect(res.status, table).toBe(200);
      }
    }
    const finish = await api('POST', `/organizations/${orgId}/import/finish`, { user });
    expect(finish.body.ok).toBe(true);
    expect((await rows('SELECT id FROM order_lines WHERE org_id = ?', orgId)).length).toBe(file.tables.order_lines.length);
  });

  it('works in small chunks too', async () => {
    const source = await richOrg();
    const user = importer();
    const { finish } = await importFile((await exportOf(source.org)).body, user, 1);
    expect(finish.body.ok).toBe(true);
  });

  it('reports missing rows at finish and keeps the org in import mode', async () => {
    const source = await richOrg();
    const file = (await exportOf(source.org)).body;
    const user = importer();
    const start = await api('POST', '/organizations/import/start', { user, body: { manifest: manifestOf(file) } });
    const finish = await api('POST', `/organizations/${start.body.orgId}/import/finish`, { user });
    expect(finish.status).toBe(409);
    expect(finish.body.ok).toBe(false);
    expect(finish.body.tables.products).toEqual({ expected: 2, imported: 0 });
    expect((await api('GET', `/organizations/${start.body.orgId}`, { user })).body.importStatus).toBe('importing');
  });

  it('can abort an unfinished import, removing everything', async () => {
    const source = await richOrg();
    const file = (await exportOf(source.org)).body;
    const user = importer();
    const start = await api('POST', '/organizations/import/start', { user, body: { manifest: manifestOf(file) } });
    const orgId = start.body.orgId;
    await api('POST', `/organizations/${orgId}/import/chunk`, { user, body: { table: 'categories', rows: file.tables.categories } });
    expect((await api('POST', `/organizations/${orgId}/import/abort`, { user })).status).toBe(200);
    for (const table of ['organizations', 'memberships', 'categories']) {
      const col = table === 'organizations' ? 'id' : 'org_id';
      expect((await rows(`SELECT 1 FROM ${table} WHERE ${col} = ?`, orgId)).length, table).toBe(0);
    }
  });

  it('refuses bad input and out-of-order calls', async () => {
    const source = await richOrg();
    const file = (await exportOf(source.org)).body;
    const user = importer();
    expect((await api('POST', '/organizations/import/start', { user: null, body: { manifest: manifestOf(file) } })).status).toBe(401);
    expect((await api('POST', '/organizations/import/start', { user, body: { manifest: { ...manifestOf(file), format: 'iets anders' } } })).status).toBe(400);
    expect((await api('POST', '/organizations/import/start', { user, body: { manifest: { ...manifestOf(file), version: 99 } } })).status).toBe(400);

    const { orgId } = await importFile(file, user);
    // Finished: no more chunks, no abort.
    expect((await api('POST', `/organizations/${orgId}/import/chunk`, { user, body: { table: 'categories', rows: [] } })).status).toBe(409);
    expect((await api('POST', `/organizations/${orgId}/import/abort`, { user })).status).toBe(409);

    const start = await api('POST', '/organizations/import/start', { user, body: { manifest: manifestOf(file) } });
    const other = importer();
    expect((await api('POST', `/organizations/${start.body.orgId}/import/chunk`, { user: other, body: { table: 'categories', rows: [] } })).status).toBe(403);
    expect((await api('POST', `/organizations/${start.body.orgId}/import/chunk`, { user, body: { table: 'organizations', rows: [] } })).status).toBe(400);
    expect((await api('POST', `/organizations/${start.body.orgId}/import/chunk`, { user, body: { table: 'categories', rows: 'x' } })).status).toBe(400);
  });

  it('can import into the same installation while the source org still exists', async () => {
    const source = await richOrg();
    const user = importer();
    const { finish } = await importFile((await exportOf(source.org)).body, user);
    expect(finish.body.ok).toBe(true);
    // The source is untouched.
    expect((await rows('SELECT 1 FROM tabs WHERE org_id = ?', source.org.orgId)).length).toBe(2);
  });
});
