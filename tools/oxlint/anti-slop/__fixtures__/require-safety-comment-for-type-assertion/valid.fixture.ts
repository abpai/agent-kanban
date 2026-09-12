declare const value: string | number

// SAFETY: The fixture models a value validated by an external boundary.
export const name = value as string
