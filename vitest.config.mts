import { readFileSync } from 'node:fs';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// A .sql file split into single statements (D1 exec/prepare want one at a
// time) — read here, in Node, so any schema.sql change flows straight into
// the tests. `--` comments are stripped first since some contain ';'.
function sqlStatements(file: string): string[] {
  const sql = readFileSync(new URL(file, import.meta.url), 'utf8')
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
  return sql
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Stand-in for arcanum-devicehub / arcanum-mailer: records every call so a
// test can assert on it (GET /__calls), and never reaches a real Worker.
function recordingService(name: string) {
  const calls: { path: string; body: unknown }[] = [];
  return async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path === '/__calls') return Response.json(calls);
    const text = await request.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {}
    calls.push({ path, body });
    return Response.json({ ok: true, stub: name });
  };
}

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          TEST_SCHEMA: JSON.stringify(sqlStatements('./schema.sql')),
          // Its seed is org-specific — test/catalog-seed.test.ts runs it.
          TEST_MIGRATION_0013: JSON.stringify(sqlStatements('./migrations/0013_catalog.sql')),
          // Test-only values — never real secrets. ENCRYPTION_KEY must be
          // base64 of 32 bytes (see CLAUDE.md: hex silently breaks crypto).
          ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
          INTERNAL_API_KEY: 'test-internal-key',
          BFF_INTERNAL_KEY: 'test-bff-key',
          MAILER_INTERNAL_KEY: 'test-mailer-key',
          PUBLIC_BASE_URL: 'https://arcanum.test',
          // A developer's own .dev.vars may point these at local Workers;
          // blank them so tests always go through the stub bindings below.
          DEVICEHUB_LOCAL_URL: '',
          MAILER_LOCAL_URL: '',
        },
        serviceBindings: {
          ARCANUM_DEVICEHUB_SERVICE: recordingService('devicehub'),
          ARCANUM_MAILER_SERVICE: recordingService('mailer'),
        },
      },
    }),
  ],
  test: {
    setupFiles: ['./test/setup.ts'],
  },
});
