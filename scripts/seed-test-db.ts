#!/usr/bin/env bun
/**
 * Seed the test database with fixture data.
 * Loads .env.test via Bun's --env-file flag (see package.json "seed:test").
 *
 * Usage: bun run seed:test
 */

import { existsSync, unlinkSync } from 'node:fs'
import { openDb, initSchema, seedDefaultColumns, getDbPath, getBoardView } from '../src/db.ts'
import { seedFixtures } from './fixtures.ts'

const dbPath = getDbPath()

// Clean slate — remove existing DB and WAL/SHM files
for (const suffix of ['', '-wal', '-shm']) {
  const file = dbPath + suffix
  if (existsSync(file)) unlinkSync(file)
}

const db = openDb(dbPath)
initSchema(db)
seedDefaultColumns(db)

const { taskCount, movedCount } = seedFixtures(db)

// Print summary
const board = getBoardView(db)
console.info(`Seeded ${dbPath} with ${taskCount} tasks (${movedCount} moved from backlog):`)
for (const col of board.columns) {
  console.info(`  ${col.name}: ${col.tasks.length} task(s)`)
}

const activityCount = (
  db.query('SELECT COUNT(*) as count FROM activity_log').get() as { count: number }
).count
console.info(`Activity log entries: ${activityCount}`)

db.close()
