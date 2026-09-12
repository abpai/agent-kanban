/** Values produced by JSON.parse and accepted by JSON-based provider APIs. */
export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[]

export interface JsonObject {
  [key: string]: JsonValue | undefined
}
