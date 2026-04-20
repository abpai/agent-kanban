import { Buffer } from 'node:buffer'
import { createHmac, timingSafeEqual } from 'node:crypto'

export interface WebhookRequest {
  headers: Record<string, string>
  rawBody: string
}

export interface WebhookResult {
  handled: boolean
  unauthorized?: boolean
  message?: string
}

export function verifyHmacSha256(
  secret: string,
  rawBody: string,
  providedSignature: string | undefined | null,
  encoding: 'hex' | 'base64' = 'hex',
): boolean {
  if (!providedSignature) return false
  const mac = createHmac('sha256', secret).update(rawBody).digest(encoding)
  const expected = providedSignature.replace(/^sha256=/, '')
  const macBuf = Buffer.from(mac)
  const expBuf = Buffer.from(expected)
  if (macBuf.length !== expBuf.length) return false
  return timingSafeEqual(macBuf, expBuf)
}

export function headerLower(headers: Record<string, string>, name: string): string | undefined {
  const target = name.toLowerCase()
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) return v
  }
  return undefined
}
