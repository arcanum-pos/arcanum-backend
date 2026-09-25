import type { Env as WorkerEnv } from '../src/env';

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      // schema.sql as a JSON array of statements — see vitest.config.ts.
      TEST_SCHEMA: string;
      // migrations/0013_catalog.sql (tables + Scouts Elewijt seed), same shape.
      TEST_MIGRATION_0013: string;
      // Every migrations/*.sql as { name, sql }, in order.
      TEST_MIGRATIONS: string;
    }
  }
}
