declare const raw: string

const value: unknown = raw

// SAFETY: The comment satisfies the safety rule so only the widen-then-assert reports.
const name = value as string

export { name }
