import type { Subprocess } from 'bun'

const TRYCLOUDFLARE_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i

export interface TunnelHandle {
  process: Subprocess
  stop: () => void
}

export interface TunnelOptions {
  command?: string[]
  onUrl?: (url: string) => void
  log?: (message: string) => void
  warn?: (message: string) => void
}

export function startCloudflareTunnel(port: number, opts: TunnelOptions = {}): TunnelHandle {
  const command = opts.command ?? [
    'bunx',
    'cloudflared',
    'tunnel',
    '--url',
    `http://localhost:${port}`,
  ]
  const log = opts.log ?? ((m: string) => console.info(m))
  const warn = opts.warn ?? ((m: string) => console.warn(m))

  let child: Subprocess
  try {
    child = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe' })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    warn(
      `Failed to start cloudflared: ${msg}. Install it with 'brew install cloudflared' or see docs/providers/linear.md for setup.`,
    )
    throw err
  }

  const stop = (): void => {
    try {
      child.kill()
    } catch {
      // best-effort teardown
    }
  }

  let announced = false
  const announce = (url: string): void => {
    if (announced) return
    announced = true
    log(`Public tunnel URL: ${url}`)
    opts.onUrl?.(url)
  }

  const scanForUrl = async (
    stream: ReadableStream<Uint8Array> | null | undefined,
  ): Promise<void> => {
    if (!stream) return
    const decoder = new TextDecoder()
    // Accumulate across chunks: cloudflared may split the URL across read
    // boundaries, so matching each chunk in isolation can miss it.
    let buffer = ''
    for await (const chunk of stream) {
      // Once announced, keep draining the pipe (so the child doesn't block on a
      // full stdout buffer) but stop scanning.
      if (announced) continue
      buffer += decoder.decode(chunk as Uint8Array, { stream: true })
      const match = buffer.match(TRYCLOUDFLARE_URL)
      if (match) {
        announce(match[0])
      } else if (buffer.length > 4096) {
        // Bound memory while keeping a tail long enough to span a split URL.
        buffer = buffer.slice(-256)
      }
    }
  }

  void scanForUrl(child.stdout as ReadableStream<Uint8Array>)
  void scanForUrl(child.stderr as ReadableStream<Uint8Array>)

  void child.exited.then((code) => {
    if (!announced) {
      warn(
        `cloudflared exited (code ${code}) before a public URL was established. Is cloudflared installed? Try 'brew install cloudflared' or 'npm i -g cloudflared'.`,
      )
    }
  })

  return { process: child, stop }
}
