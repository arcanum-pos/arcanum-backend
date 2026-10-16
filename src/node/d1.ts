// D1, as the Workers use it (prepare → bind → first / all / run / raw, and
// batch), on a SQLite file — for running self-hosted (SELF_HOSTING.md).
// Node's own SQLite (node:sqlite): nothing native to build. Same SQL, same
// answers, same errors (SQLite's own texts, as D1 passes them on), so the
// Worker's queries don't change. A batch is one transaction, as in D1;
// foreign keys are enforced, as in D1.
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';

type Value = string | number | bigint | boolean | null | ArrayBuffer | Uint8Array;

function toSqlite(value: Value | undefined, index: number): SQLInputValue {
  if (value === undefined) throw new Error(`D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined' (parameter ${index + 1})`);
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return value as SQLInputValue;
}

interface Meta {
  changes: number;
  last_row_id: number;
  duration: number;
  rows_read: number;
  rows_written: number;
  changed_db: boolean;
  size_after: number;
}

export interface D1ResultLike<T = Record<string, unknown>> {
  results: T[];
  success: true;
  meta: Meta;
}

const meta = (changes = 0, lastRowId = 0): Meta => ({ changes, last_row_id: lastRowId, duration: 0, rows_read: 0, rows_written: changes, changed_db: changes > 0, size_after: 0 });

// Plain objects (node:sqlite's rows have no prototype).
const plain = <T>(row: unknown): T => ({ ...(row as object) }) as T;

export class NodeD1PreparedStatement {
  constructor(
    private readonly db: NodeD1Database,
    readonly sql: string,
    readonly params: SQLInputValue[] = []
  ) {}

  bind(...values: Value[]): NodeD1PreparedStatement {
    return new NodeD1PreparedStatement(this.db, this.sql, values.map(toSqlite));
  }

  private statement(): StatementSync {
    return this.db.raw.prepare(this.sql);
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const row = this.statement().get(...this.params);
    if (!row) return null;
    return (column ? ((row as Record<string, unknown>)[column] ?? null) : plain<T>(row)) as T | null;
  }

  async all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>> {
    return this.execute<T>();
  }

  async run<T = Record<string, unknown>>(): Promise<D1ResultLike<T>> {
    return this.execute<T>();
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    const rows = this.statement().all(...this.params);
    return rows.map((r) => Object.values(r as object)) as T[];
  }

  // A statement that returns rows (a SELECT, or RETURNING) gives them;
  // otherwise what it changed — like D1's all() and run().
  execute<T>(): D1ResultLike<T> {
    const statement = this.statement();
    if (statement.columns().length > 0) {
      const rows = statement.all(...this.params).map((r) => plain<T>(r));
      return { results: rows, success: true, meta: meta(Number(this.db.raw.prepare('SELECT changes() AS n').get()?.n ?? 0)) };
    }
    const result = statement.run(...this.params);
    return { results: [], success: true, meta: meta(Number(result.changes), Number(result.lastInsertRowid)) };
  }
}

export class NodeD1Database {
  readonly raw: DatabaseSync;

  constructor(file: string) {
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA journal_mode = WAL');
    this.raw.exec('PRAGMA foreign_keys = ON');
    this.raw.exec('PRAGMA busy_timeout = 5000');
  }

  prepare(sql: string): NodeD1PreparedStatement {
    return new NodeD1PreparedStatement(this, sql);
  }

  // All or nothing, in order — like D1's batch.
  async batch<T = Record<string, unknown>>(statements: NodeD1PreparedStatement[]): Promise<D1ResultLike<T>[]> {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map((s) => s.execute<T>());
      this.raw.exec('COMMIT');
      return results;
    } catch (err) {
      this.raw.exec('ROLLBACK');
      throw err;
    }
  }

  async exec(sql: string): Promise<{ count: number; duration: number }> {
    this.raw.exec(sql);
    return { count: sql.split(';').filter((s) => s.trim()).length, duration: 0 };
  }
}
