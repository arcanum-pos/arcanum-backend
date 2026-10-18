// arcanum-backend self-hosted (SELF_HOSTING.md): the same Worker code
// (index.ts) on Node — its database as D1 on SQLite (node/d1.ts), the
// payment poller's alarm in this process (node/alarms.ts), its service
// bindings as HTTP (node/fetcher.ts), `cloudflare:workers` from
// node/workers.ts. From the environment (the installer sets them, like the
// Worker's vars and secrets):
//   DEVICEHUB_URL, MAILER_URL     e.g. http://devicehub:8080 (required)
//   BACKEND_DB                    its SQLite file (default /data/backend.db)
//   PORT                          to listen on (default 8080)
//   every var and secret by its own name (ENCRYPTION_KEY, INTERNAL_API_KEY, …)
//
// `node dist/node.mjs migrate` brings the database up to date and stops
// (the installer runs it before rolling out a new version; see node-main.ts).
import { serve } from '@hono/node-server';
import { copyFileSync, existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import worker, { ChargePoller } from './index';
import type { Env } from './env';
import { AlarmNamespace } from './node/alarms';
import { NodeD1Database } from './node/d1';
import { httpFetcher } from './node/fetcher';
import { migrate, readMigrations } from './node/migrate';

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function openDatabase(environment: NodeJS.ProcessEnv): NodeD1Database {
  return new NodeD1Database(databasePath(environment));
}

// Before a new version's migration, its database files (the file, its -wal
// and -shm) copied aside as <file>.before-<version> — so a rollback can put
// them back; rolling back, that copy moved back. Before the database is
// opened. What the installer's init container did with a shell, which the
// distroless image doesn't have (SELF_HOSTING.md). Both are safe to repeat —
// a restart (a recreated pod, compose's backend migrating as it starts) runs
// them again: a copy that's there already is kept (it's from before the
// migration; the database now isn't), and a copy put back is gone, so it's
// never put back twice.
const DB_FILES = ['', '-wal', '-shm'];
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function databasePath(environment: NodeJS.ProcessEnv): string {
  return environment.BACKEND_DB || '/data/backend.db';
}

export function backupDatabase(path: string, version: string): string[] {
  if (!VERSION.test(version)) throw new Error(`Not a version: ${version}`);
  if (existsSync(`${path}.before-${version}`)) return [];
  const copied: string[] = [];
  for (const suffix of DB_FILES) {
    const file = `${path}${suffix}`;
    if (!existsSync(file)) continue;
    copyFileSync(file, `${file}.before-${version}`);
    copied.push(file);
  }
  return copied;
}

// True when there was a copy to put back (else the database stays as it is).
export function restoreDatabase(path: string, version: string): boolean {
  if (!VERSION.test(version)) throw new Error(`Not a version: ${version}`);
  if (!existsSync(`${path}.before-${version}`)) return false;
  for (const suffix of DB_FILES) {
    const file = `${path}${suffix}`;
    rmSync(file, { force: true });
    if (existsSync(`${file}.before-${version}`)) renameSync(`${file}.before-${version}`, file);
  }
  return true;
}

// The database up to date: schema.sql and migrations/ from next to the
// bundle (the image), or from DB_SCHEMA / DB_MIGRATIONS.
export function migrateDatabase(environment: NodeJS.ProcessEnv, db = openDatabase(environment)) {
  const here = (relative: string) => new URL(relative, import.meta.url).pathname;
  const schema = readFileSync(environment.DB_SCHEMA || here('../schema.sql'), 'utf8');
  const migrations = readMigrations(environment.DB_MIGRATIONS || here('../migrations'));
  return migrate(db, schema, migrations);
}

// The seeded default login provider cleared, so it re-seeds from the
// current DEFAULT_IDP_* settings at the next sign-in — what the installer's
// login:reset step does on Cloudflare. True when there was one.
export function resetDefaultLogin(db: NodeD1Database): boolean {
  return Number(db.raw.prepare("DELETE FROM identity_providers WHERE org_id = 'default'").run().changes) > 0;
}

export function nodeEnv(environment: NodeJS.ProcessEnv, db = openDatabase(environment)): { env: Env; poller: AlarmNamespace<ChargePoller> } {
  const strings = Object.fromEntries(Object.entries(environment).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
  let env: Env;
  const poller = new AlarmNamespace((state) => new ChargePoller(state as unknown as DurableObjectState, env));
  env = {
    ...strings,
    DB: db as unknown as D1Database,
    CHARGE_POLLER: poller as unknown as DurableObjectNamespace,
    ARCANUM_DEVICEHUB_SERVICE: httpFetcher(required(environment, 'DEVICEHUB_URL')) as unknown as Fetcher,
    ARCANUM_MAILER_SERVICE: httpFetcher(required(environment, 'MAILER_URL')) as unknown as Fetcher,
    INTERNAL_API_KEY: required(environment, 'INTERNAL_API_KEY'),
    MAILER_INTERNAL_KEY: required(environment, 'MAILER_INTERNAL_KEY'),
    ENCRYPTION_KEY: required(environment, 'ENCRYPTION_KEY'),
    PUBLIC_BASE_URL: required(environment, 'PUBLIC_BASE_URL'),
  } as Env;
  return { env, poller };
}

export function start(environment: NodeJS.ProcessEnv = process.env) {
  const { env } = nodeEnv(environment);
  const port = Number(environment.PORT || 8080);
  return serve({ fetch: (request) => worker.fetch(request, env), port }, () => console.log(`arcanum-backend listening on :${port}`));
}
