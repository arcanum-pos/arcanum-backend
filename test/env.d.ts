import type { Env as WorkerEnv } from '../src/env';

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      // schema.sql as a JSON array of statements — see vitest.config.ts.
      TEST_SCHEMA: string;
    }
  }
}
