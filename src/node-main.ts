// The self-hosted backend's entry (npm run build:node → dist/node.mjs):
// `node dist/node.mjs` serves; `node dist/node.mjs migrate` brings the
// database up to date and stops.
import { migrateDatabase, start } from './node';

if (process.argv[2] === 'migrate') {
  const result = migrateDatabase(process.env);
  console.log(result.fresh ? 'Fresh database: schema applied' : result.applied.length ? `Applied: ${result.applied.join(', ')}` : 'Up to date');
} else {
  start();
}
