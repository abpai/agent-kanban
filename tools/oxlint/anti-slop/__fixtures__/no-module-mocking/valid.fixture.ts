export interface Clock {
  now(): number
}

export const fixedClock: Clock = { now: () => 0 }
