// migrations/0013_catalog.sql's seed: Scouts Elewijt's "Standaard" catalog
// with today's hardcoded items and live prices. Only runs when that org
// exists, and is safe to re-run.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { generateDataKey, wrapDataKey } from '../src/organizations/crypto';
import { api } from './helpers';

const SCOUTS = '7f855c6b-1574-41c6-9c19-576b84dd2ee4';
const member = { sub: 'scouts-cashier', issuer: 'https://issuer.test/', name: 'Kassa', email: 'kassa@scouts.test' };

async function runMigration() {
  const statements = JSON.parse(env.TEST_MIGRATION_0013) as string[];
  await env.DB.batch(statements.map((sql) => env.DB.prepare(sql)));
}

async function seededRowCount() {
  const row = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM categories WHERE org_id = ?1) + (SELECT COUNT(*) FROM products WHERE org_id = ?1)
          + (SELECT COUNT(*) FROM product_variants WHERE org_id = ?1) + (SELECT COUNT(*) FROM catalogs WHERE org_id = ?1)
          + (SELECT COUNT(*) FROM catalog_sections WHERE org_id = ?1) + (SELECT COUNT(*) FROM catalog_entries WHERE org_id = ?1) AS n`
  )
    .bind(SCOUTS)
    .first<{ n: number }>();
  return row!.n;
}

describe('0013 seed', () => {
  it('is a no-op on a database without Scouts Elewijt', async () => {
    await runMigration();
    expect(await seededRowCount()).toBe(0);
  });

  it("creates Scouts Elewijt's default catalog with the legacy items at live prices, idempotently", async () => {
    const wrapped = await wrapDataKey(generateDataKey(), env.ENCRYPTION_KEY);
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO organizations (id, name, dek_ciphertext, dek_iv, created_at, created_by_sub) VALUES (?, ?, ?, ?, ?, ?)').bind(
        SCOUTS, 'Scouts Elewijt', wrapped.ciphertext, wrapped.iv, now, member.sub
      ),
      env.DB.prepare(
        `INSERT INTO memberships (id, org_id, user_sub, issuer, invited_email, role, status, invited_at, accepted_at)
         VALUES (?, ?, ?, ?, ?, 'cashier', 'active', ?, ?)`
      ).bind(crypto.randomUUID(), SCOUTS, member.sub, member.issuer, member.email, now, now),
    ]);

    await runMigration();
    const count = await seededRowCount();
    await runMigration();
    expect(await seededRowCount()).toBe(count);

    const res = await api('GET', `/organizations/${SCOUTS}/catalogs/default/kassa`, { user: member });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Standaard');
    expect(
      res.body.sections.map((s: any) => [s.name, s.entries.map((e: any) => [e.name, e.priceCents, e.code, e.quickQuantities])])
    ).toEqual([
      ['Bonnen', [['Bon', 100, 'bon', [5, 10, 15, 20, 25, 30, 35, 40]]]],
      [
        'Tochten',
        [
          ['Fietstocht (niet-lid)', 800, 'fietstocht', null],
          ['Fietstocht (lid)', 500, 'fietstochtMember', null],
          ['Wandeltocht (niet-lid)', 600, 'wandeltocht', null],
          ['Wandeltocht (lid)', 300, 'wandeltochtMember', null],
        ],
      ],
    ]);
  });
});
