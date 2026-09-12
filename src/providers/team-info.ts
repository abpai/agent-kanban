import type { ProviderTeamInfo } from '../types'

export function parseProviderTeamInfo(raw: string | null): ProviderTeamInfo | null {
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (
      parsed &&
      typeof parsed === 'object' &&
      'id' in parsed &&
      'key' in parsed &&
      'name' in parsed &&
      typeof parsed.id === 'string' &&
      typeof parsed.key === 'string' &&
      typeof parsed.name === 'string'
    ) {
      return { id: parsed.id, key: parsed.key, name: parsed.name }
    }
  } catch {
    // Corrupt persisted provider metadata should not prevent cache bootstrap.
  }
  return null
}
