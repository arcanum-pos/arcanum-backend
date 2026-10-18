// The self-hosted backend's entry (npm run build:node → dist/node.mjs):
// `node dist/node.mjs` serves; `node dist/node.mjs migrate` brings the
// database up to date and stops — with `--reset-login` it then also clears
// the seeded default login provider, so it re-seeds from the current
// DEFAULT_IDP_* settings (what the installer's login:reset step does on
// Cloudflare; on Kubernetes the init container runs it on every rollout).
// Before it migrates (the installer passes one of them):
//   --backup-as <version>     the database files copied aside first, for a rollback
//   --restore-from <version>  a rollback: that version's copy put back first
import { backupDatabase, databasePath, migrateDatabase, openDatabase, resetDefaultLogin, restoreDatabase, start } from './node';

const option = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};

if (process.argv[2] === 'migrate') {
  const path = databasePath(process.env);
  const restoreFrom = option('--restore-from');
  const backupAs = option('--backup-as');
  if (restoreFrom) console.log(restoreDatabase(path, restoreFrom) ? `Put back: the database from before ${restoreFrom}` : `No copy from before ${restoreFrom}: the database as it is`);
  else if (backupAs) {
    const copied = backupDatabase(path, backupAs);
    console.log(copied.length ? `Copied aside: ${copied.join(', ')} (.before-${backupAs})` : 'No database yet: nothing to copy');
  }
  const db = openDatabase(process.env);
  const result = migrateDatabase(process.env, db);
  console.log(result.fresh ? 'Fresh database: schema applied' : result.applied.length ? `Applied: ${result.applied.join(', ')}` : 'Up to date');
  if (process.argv.includes('--reset-login')) {
    console.log(`Default login provider ${resetDefaultLogin(db) ? 'cleared: it re-seeds from the settings' : 'not seeded yet'}`);
  }
} else {
  start();
}
