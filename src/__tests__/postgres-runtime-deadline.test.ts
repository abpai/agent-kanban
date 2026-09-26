import { expect, test } from 'bun:test'
import postgres from 'postgres'
import { openKanbanRuntime } from '../provider-runtime'

const databaseUrl = process.env['KANBAN_PG_TEST_URL'] ?? process.env['DATABASE_URL']
const pgTest = databaseUrl ? test : test.skip

pgTest('runtime bounds statements and preserves URL timeout and schema overrides', async () => {
  if (!databaseUrl) throw new Error('A Postgres test database is required')
  const admin = postgres(databaseUrl, { max: 1, onnotice: () => {} })
  const schema = `deadline_test_${crypto.randomUUID().replaceAll('-', '')}`
  await admin`CREATE SCHEMA ${admin(schema)}`
  const url = new URL(databaseUrl)
  url.searchParams.delete('statement_timeout')
  url.searchParams.set('search_path', schema)
  try {
    const defaults = await openKanbanRuntime({
      storage: { mode: 'postgres', databaseUrl: url.toString() },
      tracker: { provider: 'local' },
    })
    try {
      const settings = await defaults.sql!<{ statement_timeout: string; search_path: string }[]>`
        SELECT current_setting('statement_timeout') AS statement_timeout, current_setting('search_path') AS search_path
      `
      expect(settings[0]).toEqual({ statement_timeout: '1min', search_path: schema })
    } finally {
      await defaults.close()
    }

    // Long enough for runtime schema setup, short enough to cut pg_sleep(10).
    url.searchParams.set('statement_timeout', '1s')
    const runtime = await openKanbanRuntime({
      storage: { mode: 'postgres', databaseUrl: url.toString() },
      tracker: { provider: 'local' },
    })
    const sql = runtime.sql!
    try {
      const settings = await sql<{ statement_timeout: string }[]>`SHOW statement_timeout`
      expect(settings[0]?.statement_timeout).toBe('1s')
      const started = performance.now()
      await expect(
        sql.begin(async (tx) => {
          await tx`CREATE TABLE rollback_probe (id integer)`
          await tx`INSERT INTO rollback_probe VALUES (1)`
          await tx`SELECT pg_sleep(10)`
        }),
      ).rejects.toMatchObject({ code: '57014' })
      expect(performance.now() - started).toBeLessThan(5_000)
      const rolledBack = await sql<
        { table_name: string | null }[]
      >`SELECT to_regclass('rollback_probe')::text AS table_name`
      expect(rolledBack[0]?.table_name).toBeNull()
      const probes = await Promise.all(
        Array.from({ length: 5 }, () => sql<{ value: number }[]>`SELECT 1 AS value`),
      )
      expect(probes.every((rows) => rows[0]?.value === 1)).toBe(true)
    } finally {
      await runtime.close()
    }
  } finally {
    await admin`DROP SCHEMA ${admin(schema)} CASCADE`
    await admin.end({ timeout: 1 })
  }
})
