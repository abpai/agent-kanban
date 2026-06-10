import type { ProviderCapabilities } from '../types'

export const defaultCapabilities: ProviderCapabilities = {
  taskCreate: false,
  taskUpdate: false,
  taskMove: false,
  taskDelete: false,
  comment: false,
  activity: false,
  metrics: false,
  columnCrud: false,
  bulk: false,
  configEdit: false,
}
