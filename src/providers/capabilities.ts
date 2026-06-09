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

// Postgres-local shares most local capabilities, but board administration
// (column CRUD, bulk ops) and config editing have no Postgres provider path —
// the CLI implements column/bulk against a raw SQLite Database and blocks them
// under KANBAN_STORAGE=postgres. Advertise that honestly so clients don't offer
// operations the provider can't perform.
export const POSTGRES_LOCAL_CAPABILITIES: ProviderCapabilities = {
  ...LOCAL_CAPABILITIES,
  columnCrud: false,
  bulk: false,
  configEdit: false,
}

export const LINEAR_CAPABILITIES: ProviderCapabilities = capabilities()

export const JIRA_CAPABILITIES: ProviderCapabilities = capabilities()
