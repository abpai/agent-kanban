import { ErrorCode, KanbanError } from '../errors'
import { providerUpstreamError } from './errors'

const DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS = 30_000
// setTimeout fires immediately for delays above a signed 32-bit integer.
export const MAX_TIMER_DELAY_MS = 2_147_483_647

export function resolveProviderRequestTimeoutMs(
  value = DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS,
): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
    throw new KanbanError(
      ErrorCode.INVALID_CONFIG,
      `requestTimeoutMs must be an integer between 1 and ${MAX_TIMER_DELAY_MS}`,
    )
  }
  return value
}

/** One deadline covers both response headers and body consumption. */
export async function providerRequest<T>(
  provider: 'Jira' | 'Linear',
  url: string,
  init: RequestInit,
  read: (response: Response) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    return await read(response)
  } catch (error) {
    if (controller.signal.aborted) {
      providerUpstreamError(`${provider} API request timed out after ${timeoutMs}ms`)
    }
    throw error
  } finally {
    clearTimeout(timeout)
    // An auth/rate-limit response can be rejected without consuming its body.
    controller.abort()
  }
}
