import { afterEach, expect, test } from 'bun:test'
import { ErrorCode } from '../errors'
import { JiraClient } from '../providers/jira-client'
import { LinearClient } from '../providers/linear-client'
import { mockFetch } from './helpers/fetch'

const nativeFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = nativeFetch
})

for (const provider of ['Jira', 'Linear'] as const) {
  for (const phase of ['headers', 'body'] as const) {
    test(`${provider} aborts stalled ${phase} without retrying a mutation`, async () => {
      let stall = true
      let requests = 0
      let abortedRequests = 0
      const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        async fetch(request) {
          requests += 1
          await request.text()
          if (!stall) return Response.json({ data: { issueUpdate: { success: true } } })
          request.signal.addEventListener(
            'abort',
            () => {
              abortedRequests += 1
            },
            { once: true },
          )
          if (phase === 'headers') {
            return new Promise<Response>((resolve) => {
              request.signal.addEventListener('abort', () => resolve(new Response()), {
                once: true,
              })
            })
          }
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"data":'))
              },
            }),
            { headers: { 'content-type': 'application/json' } },
          )
        },
      })
      // Even a regression that never aborts must release this test's socket.
      const failsafe = setTimeout(() => server.stop(true), 1_500)
      globalThis.fetch = mockFetch((_url, init) => nativeFetch(server.url, init))
      const jira = new JiraClient({
        baseUrl: server.url.toString(),
        email: 'test@example.invalid',
        apiToken: 'fixture',
        requestTimeoutMs: 80,
      })
      const linear = new LinearClient('fixture', { requestTimeoutMs: 80 })
      const update = () =>
        provider === 'Jira'
          ? jira.updateIssue('TEST-1', { fields: { summary: 'test' } })
          : linear.updateIssue('TEST-1', { title: 'test' })
      try {
        const started = performance.now()
        await expect(update()).rejects.toMatchObject({
          code: ErrorCode.PROVIDER_UPSTREAM_ERROR,
          message: `${provider} API request timed out after 80ms`,
        })
        expect(performance.now() - started).toBeLessThan(1_000)
        for (let attempt = 0; abortedRequests === 0 && attempt < 100; attempt += 1) {
          await Bun.sleep(5)
        }
        expect(abortedRequests).toBe(1)
        expect(requests).toBe(1)
        stall = false
        await update()
        expect(requests).toBe(2)
      } finally {
        clearTimeout(failsafe)
        await server.stop(true)
      }
    })
  }
}
