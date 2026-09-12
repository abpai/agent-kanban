import type { Sql, TransactionSql } from 'postgres'
import type { JsonObject } from '../json'

// postgres.js's TransactionSql does not extend Sql, so batch helpers accept either.
export type Exec = Sql | TransactionSql

// Bind a row array as a single jsonb parameter for jsonb_to_recordset batch
// statements. Restrict inputs to the JSON records accepted by postgres.js.
export function recordsetJson(sql: Exec, rows: JsonObject[]): ReturnType<Sql['json']> {
  return sql.json(rows)
}
