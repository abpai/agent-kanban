const warnedKeys = new Set<string>()

// Emit an informational warning at most once per process for a given key, so
// repeated hot paths (e.g. inbound webhooks) don't flood the dev console.
export function warnOnce(key: string, message: string): void {
  if (warnedKeys.has(key)) return
  warnedKeys.add(key)
  console.warn(message)
}

// Test-only: clear the process-wide dedup set so tests can assert warnings
// independently of which test ran first.
export function resetWarnOnce(): void {
  warnedKeys.clear()
}
