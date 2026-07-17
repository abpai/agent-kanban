import type { ProviderCapabilities } from '../types'

// Closed by default: provider-gated actions stay hidden until /api/bootstrap
// supplies the real capabilities, so remote providers never flash local-only
// affordances. Frozen because the store holds this object by reference.
export const defaultCapabilities: ProviderCapabilities = Object.freeze({
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
  labelReplacement: false,
})
