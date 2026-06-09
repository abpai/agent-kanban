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

/**
 * Webhook authorization. When secret is configured, verifies the HMAC signature
 * and rejects on mismatch. When secret is unset, accepts all payloads (open dev
 * mode — suitable when the provider webhook is not configured with a signing secret).
 */
export function authorizeWebhook(opts: {
  secret: string | undefined
  rawBody: string
  signature: string | undefined | null
  verify: (secret: string, rawBody: string, signature: string | undefined | null) => boolean
}): WebhookResult | null {
  const { secret, rawBody, signature, verify } = opts
  if (!secret) return null
  if (!verify(secret, rawBody, signature)) {
    return { handled: false, unauthorized: true, message: 'Invalid signature' }
  }
  return null
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

export function verifySha256HmacSignatureHeader(
  secret: string,
  rawBody: string,
  providedSignature: string | undefined | null,
): boolean {
  if (!providedSignature) return false
  const eq = providedSignature.indexOf('=')
  if (eq === -1) return false
  const method = providedSignature.slice(0, eq).toLowerCase()
  const signature = providedSignature.slice(eq + 1)
  if (method !== 'sha256') return false
  return verifyHmacSha256(secret, rawBody, signature)
}

export function headerLower(headers: Record<string, string>, name: string): string | undefined {
  const target = name.toLowerCase()
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) return v
  }
  return undefined
}
