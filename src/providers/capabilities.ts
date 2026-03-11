import type { ProviderCapabilities } from '../types.ts'

export const LOCAL_CAPABILITIES: ProviderCapabilities = {
  taskCreate: true,
  taskUpdate: true,
  taskMove: true,
  taskDelete: true,
  activity: true,
  metrics: true,
  columnCrud: true,
  bulk: true,
  configEdit: true,
}

export const LINEAR_CAPABILITIES: ProviderCapabilities = {
  taskCreate: true,
  taskUpdate: true,
  taskMove: true,
  taskDelete: false,
  activity: false,
  metrics: false,
  columnCrud: false,
  bulk: false,
  configEdit: false,
}
