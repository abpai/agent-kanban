import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import postgres from 'postgres'
import { getCachedTask, initJiraCacheSchema, upsertJiraIssues } from '../providers/jira-cache'
import type { JiraIssueSnapshot, JiraIssueWriteOptions } from '../providers/jira-issue-snapshot'
import type { Task } from '../types'
import { PostgresJiraCache } from '../providers/postgres-jira-cache'

const databaseUrl = process.env['KANBAN_PG_TEST_URL'] ?? process.env['DATABASE_URL']
const snapshot = {
  id: '373891',
  key: 'DXS-266',
  summary: 'Review the existing PR',
  descriptionText: '',
  statusId: '12034',
  projectKey: 'DXS',
  createdAt: '2026-10-24T18:28:00.000Z',
  updatedAt: '2026-10-24T18:29:03.000Z',
}

interface CacheHarness {
  write(issues: JiraIssueSnapshot[], options?: JiraIssueWriteOptions): Promise<string[]>
  read(): Promise<Task | null>
}

async function withCache(
  storage: 'sqlite' | 'postgres',
  check: (cache: CacheHarness) => Promise<void>,
) {
  const db = new Database(':memory:')
  initJiraCacheSchema(db)
  const sql =
    storage === 'postgres' && databaseUrl
      ? postgres(databaseUrl, { max: 1, onnotice: () => {} })
      : null
  const schema = `freshness_${crypto.randomUUID().replaceAll('-', '')}`
  try {
    if (sql) await sql`CREATE SCHEMA ${sql(schema)}`
    if (sql) await sql`SET search_path TO ${sql(schema)}`
    const pg = sql ? new PostgresJiraCache(sql) : null
    if (pg) await pg.ready
    await check({
      write: async (issues, options) =>
        pg ? pg.upsertIssues(issues, options) : upsertJiraIssues(db, issues, options),
      read: async () => (pg ? pg.getCachedTask('DXS-266') : getCachedTask(db, 'DXS-266')),
    })
  } finally {
    db.close()
    if (sql) {
      await sql`DROP SCHEMA ${sql(schema)} CASCADE`
      await sql.end()
    }
  }
}

for (const storage of ['sqlite', 'postgres'] as const) {
  describe(`Jira cache freshness (${storage})`, () => {
    const run = storage === 'postgres' && !databaseUrl ? test.skip : test

    run('a delayed Backlog snapshot cannot undo a confirmed ToDo transition', () =>
      withCache(storage, async ({ write, read }) => {
        const stale = {
          ...snapshot,
          statusId: '12103',
          summary: 'Older title',
          updatedAt: '2026-10-24T18:28:58.000Z',
        }
        await write([snapshot])
        await write([stale])
        expect(await read()).toMatchObject({
          column_id: '12034',
          title: snapshot.summary,
          updated_at: snapshot.updatedAt,
        })
        await write([snapshot, stale])
        expect(await read()).toMatchObject({ column_id: '12034', title: snapshot.summary })
        const humanMove = {
          ...stale,
          summary: 'Human moved it back',
          updatedAt: '2026-10-24T18:30:00.000Z',
        }
        await write([humanMove])
        expect(await read()).toMatchObject({
          column_id: '12103',
          title: humanMove.summary,
          updated_at: humanMove.updatedAt,
        })
      }),
    )

    run('reordered batches choose the newest instant, including offsets and milliseconds', () =>
      withCache(storage, async ({ write, read }) => {
        const newer = { ...snapshot, summary: 'Newest', updatedAt: '2026-10-24T20:29:03.001+0200' }
        await write([newer, snapshot])
        expect(await read()).toMatchObject({ title: 'Newest', updated_at: newer.updatedAt })
        await write([snapshot, newer])
        expect(await read()).toMatchObject({ title: 'Newest' })
        await write([
          { ...snapshot, summary: 'Newer still', updatedAt: '2026-10-24T18:29:03.002Z' },
        ])
        expect(await read()).toMatchObject({ title: 'Newer still' })
      }),
    )

    run(
      'equal-version conflicts require authoritative readback, while exact replay is a no-op',
      () =>
        withCache(storage, async ({ write, read }) => {
          const conflicting = { ...snapshot, statusId: '12103', summary: 'Conflicting snapshot' }
          expect(await write([snapshot])).toEqual([])
          expect(await write([snapshot])).toEqual([])
          expect(await write([conflicting])).toEqual(['DXS-266'])
          expect(await read()).toMatchObject({
            column_id: snapshot.statusId,
            title: snapshot.summary,
          })
          expect(await write([conflicting], { authoritative: true })).toEqual([])
          expect(await read()).toMatchObject({
            column_id: conflicting.statusId,
            title: conflicting.summary,
          })
          expect(await write([snapshot])).toEqual(['DXS-266'])
          expect(await read()).toMatchObject({ column_id: conflicting.statusId })
          await write([{ ...snapshot, updatedAt: '2026-10-24T18:28:00Z' }], { authoritative: true })
          expect(await read()).toMatchObject({ column_id: conflicting.statusId })
        }),
    )

    run('conflicting duplicate versions in a batch are reported for readback', () =>
      withCache(storage, async ({ write, read }) => {
        expect(await write([snapshot, { ...snapshot, statusId: '12103' }])).toEqual(['DXS-266'])
        expect(await read()).toMatchObject({ column_id: snapshot.statusId })
        const newer = { ...snapshot, updatedAt: '2026-10-24T18:30:00Z', summary: 'New version' }
        expect(await write([snapshot, { ...snapshot, statusId: '12103' }, newer])).toEqual([])
        expect(await read()).toMatchObject({ title: 'New version' })
      }),
    )

    run('invalid timestamps reject the batch before any cache write', () =>
      withCache(storage, async ({ write, read }) => {
        await expect(
          write([snapshot, { ...snapshot, id: 'bad', updatedAt: 'not-a-date' }]),
        ).rejects.toMatchObject({ code: 'PROVIDER_UPSTREAM_ERROR' })
        expect(await read()).toBeNull()
      }),
    )
  })
}

const pgTest = databaseUrl ? test : test.skip
pgTest('separate Postgres writers cannot regress the shared task cache', async () => {
  if (!databaseUrl) throw new Error('Expected test database')
  const schema = `freshness_${crypto.randomUUID().replaceAll('-', '')}`
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} })
  const other = postgres(databaseUrl, {
    max: 1,
    connection: { search_path: schema },
    onnotice: () => {},
  })
  try {
    await sql`CREATE SCHEMA ${sql(schema)}`
    await sql`SET search_path TO ${sql(schema)}`
    const cache = new PostgresJiraCache(sql)
    await cache.ready
    const peer = new PostgresJiraCache(other)
    await peer.ready
    const old = { ...snapshot, statusId: '12103', updatedAt: '2026-10-24T18:28:58Z' }
    await Promise.all([
      cache.upsertIssues([snapshot], { authoritative: true }),
      peer.upsertIssues([old]),
    ])
    expect(await peer.getCachedTask(snapshot.key)).toMatchObject({
      column_id: snapshot.statusId,
      updated_at: snapshot.updatedAt,
    })
    await Promise.all([
      peer.upsertIssues([old]),
      cache.upsertIssues([snapshot], { authoritative: true }),
    ])
    expect(await cache.getCachedTask(snapshot.key)).toMatchObject({
      column_id: snapshot.statusId,
      updated_at: snapshot.updatedAt,
    })
  } finally {
    await other.end()
    await sql`DROP SCHEMA ${sql(schema)} CASCADE`
    await sql.end()
  }
})
