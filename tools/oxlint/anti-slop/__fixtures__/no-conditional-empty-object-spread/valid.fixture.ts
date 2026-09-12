const enabled = true

interface OptionalName {
  name?: string
}

const value: OptionalName = {}

if (enabled) value.name = 'Bun'

export { value }
