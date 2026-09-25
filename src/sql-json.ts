// Writing many rows in ONE D1 statement: the rows travel as a single JSON
// parameter and SQLite's json_each unpacks them. On the Workers Free plan D1
// allows 50 queries per invocation and every statement of a batch counts
// (see query-budget.ts), so anything that writes "one row per item" must go
// through here instead of one prepared statement per row.
//
// A bound parameter can be up to 2 MB — far more than any menukaart or
// order; org-transfer.ts chunks the one place that could get bigger.

export interface JsonRowsOptions {
  // INSERT OR IGNORE: skip rows whose key already exists (idempotent imports).
  orIgnore?: boolean;
  // Upsert: on a conflict on `conflict`, update only these columns.
  upsert?: { conflict: string; update: string[] };
  // Only insert when this condition holds (e.g. "the order row exists").
  where?: { sql: string; params: unknown[] };
}

export function jsonRowsStatement(
  db: D1Database,
  table: string,
  columns: string[],
  rows: Record<string, unknown>[],
  options: JsonRowsOptions = {}
): D1PreparedStatement | null {
  if (rows.length === 0) return null;
  const select = columns.map((c) => `json_extract(value, '$.${c}')`).join(', ');
  // A WHERE is also required by SQLite's parser before ON CONFLICT in an INSERT … SELECT.
  const where = options.where ? ` WHERE ${options.where.sql}` : options.upsert ? ' WHERE true' : '';
  const conflict = options.upsert
    ? ` ON CONFLICT(${options.upsert.conflict}) DO UPDATE SET ${options.upsert.update.map((c) => `${c} = excluded.${c}`).join(', ')}`
    : '';
  const sql = `INSERT${options.orIgnore ? ' OR IGNORE' : ''} INTO ${table} (${columns.join(', ')}) SELECT ${select} FROM json_each(?)${where}${conflict}`;
  const payload = JSON.stringify(rows.map((r) => Object.fromEntries(columns.map((c) => [c, r[c] ?? null]))));
  return db.prepare(sql).bind(payload, ...(options.where?.params ?? []));
}

// For batches: drops the nulls jsonRowsStatement returns for empty row lists.
export function present(statements: (D1PreparedStatement | null)[]): D1PreparedStatement[] {
  return statements.filter((s): s is D1PreparedStatement => s !== null);
}
