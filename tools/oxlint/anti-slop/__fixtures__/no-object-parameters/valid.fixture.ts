interface Payload {
  readonly name: string
}

export function inspect(value: Payload) {
  return value.name
}
