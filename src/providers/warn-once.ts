const warnedKeys = new Set<string>()

// Emit an informational warning at most once per process for a given key, so
// repeated hot paths (e.g. inbound webhooks) don't flood the dev console.
export function warnOnce(key: string, message: string): void {
  if (warnedKeys.has(key)) return
  warnedKeys.add(key)
  console.warn(message)
}
