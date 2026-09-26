import { providerUpstreamError } from './errors'

/** One deadline covers both response headers and body consumption. */
export async function providerRequest<T>(
  provider: 'Jira' | 'Linear',
  url: string,
  init: RequestInit,
  read: (response: Response) => Promise<T>,
  timeoutMs = 30_000,
): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new RangeError('Provider request timeout must be a positive timer duration')
  }
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
