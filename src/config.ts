import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { BoardConfig } from './types'

const DEFAULT_CONFIG: BoardConfig = { members: [], projects: [] }

export function getConfigPath(dbPath: string): string {
  return join(dirname(dbPath), 'config.json')
}

export function loadConfig(dbPath: string): BoardConfig {
  const configPath = getConfigPath(dbPath)
  try {
    const raw = readFileSync(configPath, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<BoardConfig>
    return {
      members: Array.isArray(parsed.members) ? parsed.members : [],
      projects: Array.isArray(parsed.projects) ? parsed.projects : [],
    }
  } catch {
    return { ...DEFAULT_CONFIG, members: [], projects: [] }
  }
}

export function saveConfig(configPath: string, config: BoardConfig): void {
  const tmp = configPath + '.tmp'
  writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n')
  renameSync(tmp, configPath)
}
