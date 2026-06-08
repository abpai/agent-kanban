import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Buffer } from 'node:buffer'
import { timingSafeEqual } from 'node:crypto'
import { handleRequest } from './api'
import type { ServerWebSocket } from 'bun'
import type { KanbanProvider } from './providers/types'
import { DEFAULT_POLLING_SYNC_INTERVAL_MS } from './sync-config'

const wsClients = new Set<ServerWebSocket<unknown>>()

// CORS is origin hygiene for cross-origin browser clients, never an auth control.
// When no allowed origin is configured we emit no CORS headers (same-origin only),
// which covers the bundled UI (served from this server) and the vite dev proxy.
function buildCorsHeaders(allowedOrigin?: string): Record<string, string> {
  if (!allowedOrigin) return {}
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    Vary: 'Origin',
  }
}

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a)
  const bBuf = Buffer.from(b)
  if (aBuf.length !== bBuf.length) return false
  return timingSafeEqual(aBuf, bBuf)
}
interface BackgroundSyncState {
  enabled: boolean
  inFlight: boolean
  warm: boolean
  lastAttemptAt: string | null
  lastSuccessAt: string | null
  lastError: string | null
}

export interface StartServerOptions {
  syncIntervalMs?: number
  /**
   * When set, all `/api/*` routes (reads and mutations) and the `/ws` upgrade
   * require `Authorization: Bearer <token>` (or `?token=` for the WebSocket,
   * which cannot send headers). `/api/health` and `/api/webhooks/*` are exempt:
   * health is a liveness probe and webhooks authenticate with the provider
   * webhook secret instead. When unset, the API is open (localhost default).
   */
  authToken?: string
  /** Allowed CORS origin; when unset, no CORS headers are emitted (same-origin). */
  allowedOrigin?: string
}

export interface StartedServer {
  port: number
  stop(closeActiveConnections?: boolean): void
}

function broadcast(data: unknown): void {
  const msg = JSON.stringify(data)
  for (const ws of wsClients) {
    ws.send(msg)
  }
}

function applyCorsHeaders(response: Response, corsHeaders: Record<string, string>): void {
  for (const [header, value] of Object.entries(corsHeaders)) {
    response.headers.set(header, value)
  }
}

function jsonWithCors(body: unknown, corsHeaders: Record<string, string>, status = 200): Response {
  const response = Response.json(body, { status })
  applyCorsHeaders(response, corsHeaders)
  return response
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function nowIso(): string {
  return new Date().toISOString()
}

export function startServer(
  provider: KanbanProvider,
  port: number,
  opts: StartServerOptions = {},
): StartedServer {
  const distDir = join(import.meta.dir, '..', 'ui', 'dist')
  const hasStatic = existsSync(distDir)
  const syncIntervalMs = opts.syncIntervalMs ?? DEFAULT_POLLING_SYNC_INTERVAL_MS
  const syncCache = provider.syncCache?.bind(provider)
  const getSyncStatus = provider.getSyncStatus?.bind(provider)
  const corsHeaders = buildCorsHeaders(opts.allowedOrigin)
  const authToken = opts.authToken

  const isAuthorized = (req: Request, url: URL, allowQueryToken: boolean): boolean => {
    if (!authToken) return true
    const header = req.headers.get('authorization')
    // The `?token=` fallback exists only for the WebSocket handshake, which can't
    // carry an Authorization header. HTTP API routes require the header so tokens
    // don't end up in URLs, logs, or referrers.
    const provided = header?.startsWith('Bearer ')
      ? header.slice('Bearer '.length)
      : allowQueryToken
        ? url.searchParams.get('token')
        : null
    return provided ? safeEqual(provided, authToken) : false
  }

  // Health is a public liveness probe; webhooks authenticate with the provider
  // webhook secret, not this token. Everything else under /api plus /ws is gated.
  const pathRequiresAuth = (pathname: string): boolean => {
    if (!authToken) return false
    if (pathname === '/ws') return true
    if (pathname === '/api/health') return false
    if (pathname.startsWith('/api/webhooks/')) return false
    return pathname.startsWith('/api/')
  }

  const backgroundSync: BackgroundSyncState = {
    enabled: typeof syncCache === 'function',
    inFlight: false,
    warm: typeof syncCache !== 'function',
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
  }
  let closed = false
  let syncTimer: ReturnType<typeof setTimeout> | null = null

  const runBackgroundSync = async (reason: 'startup' | 'interval'): Promise<void> => {
    if (!syncCache || backgroundSync.inFlight || closed) return
    backgroundSync.inFlight = true
    backgroundSync.lastAttemptAt = nowIso()
    try {
      await syncCache()
      backgroundSync.warm = true
      backgroundSync.lastSuccessAt = nowIso()
      backgroundSync.lastError = null
    } catch (err) {
      backgroundSync.lastError = errorMessage(err)
      console.warn(`[server] background ${reason} sync failed:`, err)
    } finally {
      backgroundSync.inFlight = false
    }
  }

  const scheduleBackgroundSync = (): void => {
    if (!syncCache || closed) return
    syncTimer = setTimeout(async () => {
      await runBackgroundSync('interval')
      scheduleBackgroundSync()
    }, syncIntervalMs)
  }

  if (syncCache) {
    // The background warmer owns cache refresh; let the provider serve reads from
    // the warm cache instead of blocking each request on a provider network sync.
    provider.setBackgroundManaged?.(true)
    void runBackgroundSync('startup').finally(() => {
      scheduleBackgroundSync()
    })
  }

  const server = Bun.serve({
    port,
    // Default is 10s; a cold-start provider sync (e.g. a Jira full reconcile) can
    // exceed that and Bun would otherwise close the connection mid-flight, surfacing
    // as ERR_EMPTY_RESPONSE. Steady-state reads are served from the warm cache and
    // return well under this ceiling; this is just a safety net for slow cold starts.
    idleTimeout: 255,
    websocket: {
      open(ws) {
        wsClients.add(ws)
      },
      close(ws) {
        wsClients.delete(ws)
      },
      message() {
        /* server-push only */
      },
    },
    async fetch(req, server) {
      const url = new URL(req.url)
      const rawPath = url.pathname
      const basePath = rawPath === '/kanban' || rawPath.startsWith('/kanban/') ? '/kanban' : ''
      const pathname = basePath ? rawPath.slice(basePath.length) || '/' : rawPath

      // Handle OPTIONS preflight first (before /api routing)
      if (req.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders })
      }

      // Auth gate: protect all /api/* and /ws except the public health probe and
      // webhook routes (which authenticate with the provider webhook secret).
      if (pathRequiresAuth(pathname) && !isAuthorized(req, url, pathname === '/ws')) {
        return jsonWithCors(
          { ok: false, error: { code: 'UNAUTHORIZED', message: 'Missing or invalid API token' } },
          corsHeaders,
          401,
        )
      }

      // WebSocket upgrade
      if (pathname === '/ws') {
        const upgraded = server.upgrade(req)
        if (upgraded) return undefined as unknown as Response
        return new Response('WebSocket upgrade failed', { status: 400 })
      }

      if (pathname === '/api/health') {
        return jsonWithCors(
          {
            ok: true,
            data: { status: 'running', wsClients: wsClients.size, provider: provider.type },
          },
          corsHeaders,
        )
      }

      if (pathname === '/api/ready') {
        const ready = backgroundSync.warm
        return jsonWithCors(
          {
            ok: ready,
            data: {
              ready,
              provider: provider.type,
              backgroundSync,
            },
          },
          corsHeaders,
          ready ? 200 : 503,
        )
      }

      if (pathname === '/api/sync-status') {
        const providerSync = (await getSyncStatus?.()) ?? null
        return jsonWithCors(
          {
            ok: true,
            data: {
              status: 'running',
              provider: provider.type,
              wsClients: wsClients.size,
              backgroundSync,
              providerSync,
            },
          },
          corsHeaders,
        )
      }

      if (pathname.startsWith('/api/')) {
        const forwardedUrl = new URL(req.url)
        forwardedUrl.pathname = pathname
        const forwardedReq = new Request(forwardedUrl.toString(), req)
        const result = await handleRequest(provider, forwardedReq)
        applyCorsHeaders(result.response, corsHeaders)
        if (result.mutated && result.response.ok) {
          broadcast(result.event ?? { type: 'refresh' })
        }
        return result.response
      }

      if (hasStatic) {
        const assetPath = pathname === '/' ? '/index.html' : pathname
        const filePath = join(distDir, assetPath.replace(/^\//, ''))
        const file = Bun.file(filePath)
        if (await file.exists()) return new Response(file)
        return new Response(Bun.file(join(distDir, 'index.html')))
      }

      return new Response('Dashboard not built. Run: cd ui && bun run build', {
        status: 503,
        headers: { 'Content-Type': 'text/plain' },
      })
    },
  })

  console.info(`Dashboard running at http://localhost:${port}`)

  return {
    port: server.port ?? port,
    stop(closeActiveConnections = true) {
      closed = true
      if (syncTimer) {
        clearTimeout(syncTimer)
        syncTimer = null
      }
      server.stop(closeActiveConnections)
    },
  }
}
