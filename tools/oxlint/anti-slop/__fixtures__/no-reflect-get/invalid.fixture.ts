const payload = { name: 'Bun' }

export const name = Reflect.get(payload, 'name')
