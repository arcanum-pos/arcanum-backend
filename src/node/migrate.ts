// The backend's database, self-hosted (SELF_HOSTING.md): what the
// installer's `schema:` step does on Cloudflare — a fresh database gets
// schema.sql (which marks every migration as applied); one that already
// records migrations gets only the ones it doesn't have yet, each with its
// record in d1_migrations. Never schema.sql on an existing one.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { NodeD1Database } from './d1';

export interface Migration {
  name: string;
  sql: string;
}

export function readMigrations(dir: string): Migration[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(path.join(dir, name), 'utf8') }));
}

function applied(db: NodeD1Database): Set<string> | null {
  const table = db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations'").get();
  if (!table) return null;
  const rows = db.raw.prepare('SELECT name FROM d1_migrations').all() as { name: string }[];
  return rows.length ? new Set(rows.map((r) => r.name)) : null;
}

// What it did: 'schema' (a fresh database), or the migrations it applied.
export function migrate(db: NodeD1Database, schema: string, migrations: Migration[]): { fresh: boolean; applied: string[] } {
  const done = applied(db);
  if (!done) {
    db.raw.exec('BEGIN');
    try {
      db.raw.exec(schema);
      db.raw.exec('COMMIT');
    } catch (err) {
      db.raw.exec('ROLLBACK');
      throw err;
    }
    return { fresh: true, applied: [] };
  }
  const pending = migrations.filter((m) => !done.has(m.name));
  for (const m of pending) {
    // Each migration with its record, all or nothing — like the installer's
    // one query per migration on D1. Foreign keys off meanwhile: a table
    // rebuild (how SQLite changes a CHECK) drops and renames tables, which
    // they would trip over — SQLite's own advice for such changes.
    db.raw.exec('PRAGMA foreign_keys = OFF');
    db.raw.exec('BEGIN');
    try {
      db.raw.exec(m.sql);
      db.raw.prepare('INSERT OR IGNORE INTO d1_migrations (name) VALUES (?)').run(m.name);
      db.raw.exec('COMMIT');
    } catch (err) {
      db.raw.exec('ROLLBACK');
      throw new Error(`Migration ${m.name} failed: ${(err as Error).message}`);
    } finally {
      db.raw.exec('PRAGMA foreign_keys = ON');
    }
  }
  return { fresh: false, applied: pending.map((m) => m.name) };
}
