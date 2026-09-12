export function isString(value: string | number): value is string {
  return typeof value === 'string'
}
