import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { handleRequest } from './api'
import type { ServerWebSocket } from 'bun'
import type { KanbanProvider } from './providers/types'

const wsClients = new Set<ServerWebSocket<unknown>>()
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}
const DEFAULT_BACKGROUND_SYNC_INTERVAL_MS = 30_000

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

function applyCorsHeaders(response: Response): void {
  for (const [header, value] of Object.entries(CORS_HEADERS)) {
    response.headers.set(header, value)
  }
}

function jsonWithCors(body: unknown, status = 200): Response {
  const response = Response.json(body, { status })
  applyCorsHeaders(response)
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
  const syncIntervalMs = opts.syncIntervalMs ?? DEFAULT_BACKGROUND_SYNC_INTERVAL_MS
  const syncCache = provider.syncCache?.bind(provider)
  const getSyncStatus = provider.getSyncStatus?.bind(provider)
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
    void runBackgroundSync('startup').finally(() => {
      scheduleBackgroundSync()
    })
  }

  const server = Bun.serve({
    port,
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
        return new Response(null, { headers: CORS_HEADERS })
      }

      // WebSocket upgrade
      if (pathname === '/ws') {
        const upgraded = server.upgrade(req)
        if (upgraded) return undefined as unknown as Response
        return new Response('WebSocket upgrade failed', { status: 400 })
      }

      if (pathname === '/api/health') {
        return jsonWithCors({
          ok: true,
          data: { status: 'running', wsClients: wsClients.size, provider: provider.type },
        })
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
          ready ? 200 : 503,
        )
      }

      if (pathname === '/api/sync-status') {
        const providerSync = (await getSyncStatus?.()) ?? null
        return jsonWithCors({
          ok: true,
          data: {
            status: 'running',
            provider: provider.type,
            wsClients: wsClients.size,
            backgroundSync,
            providerSync,
          },
        })
      }

      if (pathname.startsWith('/api/')) {
        const forwardedUrl = new URL(req.url)
        forwardedUrl.pathname = pathname
        const forwardedReq = new Request(forwardedUrl.toString(), req)
        const result = await handleRequest(provider, forwardedReq)
        applyCorsHeaders(result.response)
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
