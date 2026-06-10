import type { Sql, TransactionSql } from 'postgres'

// postgres.js's TransactionSql does not extend Sql, so batch helpers accept either.
export type Exec = Sql | TransactionSql

// Bind a row array as a single jsonb parameter for jsonb_to_recordset batch
// statements. The cast works around sql.json's narrower JSONValue parameter type.
export function recordsetJson(sql: Exec, rows: unknown[]): ReturnType<Sql['json']> {
  return sql.json(rows as never)
}
