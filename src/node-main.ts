// The self-hosted backend's entry (npm run build:node → dist/node.mjs):
// `node dist/node.mjs` serves; `node dist/node.mjs migrate` brings the
// database up to date and stops — with `--reset-login` it then also clears
// the seeded default login provider, so it re-seeds from the current
// DEFAULT_IDP_* settings (what the installer's login:reset step does on
// Cloudflare; on Kubernetes the init container runs it on every rollout).
import { migrateDatabase, openDatabase, resetDefaultLogin, start } from './node';

if (process.argv[2] === 'migrate') {
  const db = openDatabase(process.env);
  const result = migrateDatabase(process.env, db);
  console.log(result.fresh ? 'Fresh database: schema applied' : result.applied.length ? `Applied: ${result.applied.join(', ')}` : 'Up to date');
  if (process.argv.includes('--reset-login')) {
    console.log(`Default login provider ${resetDefaultLogin(db) ? 'cleared: it re-seeds from the settings' : 'not seeded yet'}`);
  }
} else {
  start();
}
