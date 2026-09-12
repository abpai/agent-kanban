declare const input: unknown

// SAFETY: The comment satisfies the safety rule so only the chained assertion reports.
const value = input as unknown as string

export { value }
