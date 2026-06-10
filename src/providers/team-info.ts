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
      typeof (parsed as { id: unknown }).id === 'string' &&
      typeof (parsed as { key: unknown }).key === 'string' &&
      typeof (parsed as { name: unknown }).name === 'string'
    ) {
      const team = parsed as { id: string; key: string; name: string }
      return { id: team.id, key: team.key, name: team.name }
    }
  } catch {
    // Corrupt persisted provider metadata should not prevent cache bootstrap.
  }
  return null
}
