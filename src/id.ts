export function generateId(prefix: 't' | 'c' | 'a' | 'ct'): string {
  const bytes = new Uint8Array(5)
  crypto.getRandomValues(bytes)
  let num = 0n
  for (const b of bytes) num = (num << 8n) | BigInt(b)
  const chars = num.toString(36).slice(0, 8).padStart(8, '0')
  return `${prefix}_${chars}`
}
