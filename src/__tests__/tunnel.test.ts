import { describe, expect, test } from 'bun:test'
import { startCloudflareTunnel } from '../tunnel'

// The tunnel is exercised with an injected `command` so no real `cloudflared`
// binary is needed; stdout/stderr from a tiny shell script drive URL detection,
// and the injected log/warn/onUrl sinks let us assert behaviour deterministically.

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('startCloudflareTunnel (F42/F51/F52/F53)', () => {
  test('F51: detects the trycloudflare URL from stdout and announces once', async () => {
    const url = 'https://random-words-1234.trycloudflare.com'
    const got = deferred<string>()
    const logs: string[] = []
    const handle = startCloudflareTunnel(3000, {
      command: ['bash', '-c', `echo "INF | ${url} |"; sleep 1`],
      onUrl: (u) => got.resolve(u),
      log: (m) => logs.push(m),
      warn: () => {},
    })
    expect(await got.promise).toBe(url)
    expect(logs.some((l) => l.includes(url))).toBe(true)
    handle.stop()
  })

  test('F51: detects the URL from stderr too', async () => {
    const url = 'https://stderr-side-9999.trycloudflare.com'
    const got = deferred<string>()
    const handle = startCloudflareTunnel(3000, {
      command: ['bash', '-c', `echo "${url}" 1>&2; sleep 1`],
      onUrl: (u) => got.resolve(u),
      log: () => {},
      warn: () => {},
    })
    expect(await got.promise).toBe(url)
    handle.stop()
  })

  test('F51: announces exactly once even when the URL is printed repeatedly', async () => {
    const url = 'https://dup-5678.trycloudflare.com'
    const urls: string[] = []
    const handle = startCloudflareTunnel(3000, {
      command: ['bash', '-c', `for i in 1 2 3 4; do echo ${url}; done; sleep 1`],
      onUrl: (u) => urls.push(u),
      log: () => {},
      warn: () => {},
    })
    // Give the scanner time to read all four lines before asserting.
    await new Promise((r) => setTimeout(r, 250))
    handle.stop()
    expect(urls).toEqual([url])
  })

  test('F52: warns with an actionable message and rethrows when the binary is missing', () => {
    let warned = ''
    expect(() =>
      startCloudflareTunnel(3000, {
        command: ['cloudflared-does-not-exist-xyz-123'],
        warn: (m) => {
          warned = m
        },
        log: () => {},
      }),
    ).toThrow()
    expect(warned).toContain('Failed to start cloudflared')
  })

  test('F53: warns when the process exits before a URL is established', async () => {
    const warned = deferred<string>()
    const handle = startCloudflareTunnel(3000, {
      command: ['bash', '-c', 'exit 1'],
      warn: (m) => warned.resolve(m),
      log: () => {},
    })
    expect(await warned.promise).toContain('before a public URL was established')
    handle.stop()
  })

  test('F53: stop() is best-effort and does not throw even if called twice', async () => {
    const handle = startCloudflareTunnel(3000, {
      command: ['bash', '-c', 'sleep 2'],
      log: () => {},
      warn: () => {},
    })
    expect(() => {
      handle.stop()
      handle.stop()
    }).not.toThrow()
  })
})
