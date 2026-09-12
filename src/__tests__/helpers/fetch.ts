export function mockFetch(
  implementation: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>,
): typeof fetch {
  return Object.assign(implementation, { preconnect() {} })
}
