// The self-hosted backend's entry (npm run build:node → dist/node.mjs):
// `node dist/node.mjs` serves; `node dist/node.mjs migrate` brings the
// database up to date and stops — with `--reset-login` it then also clears
// the seeded default login provider, so it re-seeds from the current
// DEFAULT_IDP_* settings (what the installer's login:reset step does on
// Cloudflare; on Kubernetes the init container runs it on every rollout).
// Before it migrates (the installer passes one of them):
//   --backup-as <version>     the database files copied aside first, for a rollback
//   --restore-from <version>  a rollback: that version's copy put back first
// With compose (the installer's compose mode, SELF_HOSTING.md) there's no
// step before the container starts: TRESJR_MIGRATE=1 makes `node dist/node.mjs`
// do all of it as it starts — TRESJR_VERSION (copied aside before it) or
// TRESJR_RESTORE_FROM, then the migration and --reset-login — and then serve.
import { backupDatabase, databasePath, migrateDatabase, openDatabase, resetDefaultLogin, restoreDatabase, start } from './node';

const option = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};

function migrateNow(restoreFrom: string | undefined, backupAs: string | undefined, resetLogin: boolean) {
  const path = databasePath(process.env);
  if (restoreFrom) console.log(restoreDatabase(path, restoreFrom) ? `Put back: the database from before ${restoreFrom}` : `No copy from before ${restoreFrom}: the database as it is`);
  else if (backupAs) {
    const copied = backupDatabase(path, backupAs);
    console.log(copied.length ? `Copied aside: ${copied.join(', ')} (.before-${backupAs})` : 'No database yet: nothing to copy');
  }
  const db = openDatabase(process.env);
  const result = migrateDatabase(process.env, db);
  console.log(result.fresh ? 'Fresh database: schema applied' : result.applied.length ? `Applied: ${result.applied.join(', ')}` : 'Up to date');
  if (resetLogin) {
    console.log(`Default login provider ${resetDefaultLogin(db) ? 'cleared: it re-seeds from the settings' : 'not seeded yet'}`);
  }
  db.raw.close();
}

if (process.argv[2] === 'migrate') {
  migrateNow(option('--restore-from'), option('--backup-as'), process.argv.includes('--reset-login'));
} else {
  if (process.env.TRESJR_MIGRATE === '1') migrateNow(process.env.TRESJR_RESTORE_FROM || undefined, process.env.TRESJR_VERSION || undefined, true);
  start();
}
