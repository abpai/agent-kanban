const greet = (name: string) => `Hello, ${name}`

export const greeting = Reflect.apply(greet, null, ['Bun'])
