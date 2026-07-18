import type { Database } from 'bun:sqlite'

import { getDbPath } from '../db'
import { LocalProviderCore } from './local-core'
import { SqliteLocalStore } from './sqlite-local-store'

export class LocalProvider extends LocalProviderCore {
  constructor(db: Database, dbPath = getDbPath(), defaultTaskColumn?: string) {
    super(new SqliteLocalStore(db, dbPath, defaultTaskColumn))
  }
}
