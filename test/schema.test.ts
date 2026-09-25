// schema.sql must contain everything the latest migration adds — a fresh
// database built from schema.sql and a production database built from the
// migrations have to end up with the same objects. Plus a guard that tests
// really run on the test config's values, not a developer's .dev.vars.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { rows } from './helpers';

describe('schema.sql', () => {
  it('includes the tables and indexes added by migration 0012_tabs', async () => {
    const objects = (await rows<{ name: string }>(`SELECT name FROM sqlite_master WHERE type IN ('table', 'index')`)).map((r) => r.name);
    for (const name of [
      'org_counters',
      'tabs',
      'orders',
      'order_lines',
      'idx_tabs_org_number',
      'idx_tabs_org_receipt',
      'idx_charges_one_pending_per_tab',
      'idx_transactions_tab_id',
    ]) {
      expect(objects).toContain(name);
    }
  });

  it('has tab_id on charges and transactions', async () => {
    for (const table of ['charges', 'transactions']) {
      const columns = (await rows<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`)).map((r) => r.name);
      expect(columns).toContain('tab_id');
    }
  });
});

describe('test configuration', () => {
  it('uses the test bindings from vitest.config.mts, not .dev.vars', () => {
    expect(env.INTERNAL_API_KEY).toBe('test-internal-key');
    expect(env.DEVICEHUB_LOCAL_URL).toBe('');
    expect(env.MAILER_LOCAL_URL).toBe('');
  });
});
