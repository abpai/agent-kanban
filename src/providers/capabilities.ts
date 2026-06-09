import type { ProviderCapabilities } from '../types'

function capabilities(overrides: Partial<ProviderCapabilities> = {}): ProviderCapabilities {
  return {
    taskCreate: true,
    taskUpdate: true,
    taskMove: true,
    taskDelete: false,
    comment: true,
    activity: false,
    metrics: false,
    columnCrud: false,
    bulk: false,
    configEdit: false,
    ...overrides,
  }
}

export const LOCAL_CAPABILITIES: ProviderCapabilities = capabilities({
  taskDelete: true,
  activity: true,
  metrics: true,
  columnCrud: true,
  bulk: true,
  configEdit: true,
})

// Postgres-local shares most local capabilities, but has no persistent config
// repository, so config edits are unsupported until persistence exists.
export const POSTGRES_LOCAL_CAPABILITIES: ProviderCapabilities = {
  ...LOCAL_CAPABILITIES,
  configEdit: false,
}

export const LINEAR_CAPABILITIES: ProviderCapabilities = capabilities()

export const JIRA_CAPABILITIES: ProviderCapabilities = capabilities()
