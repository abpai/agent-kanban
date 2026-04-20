import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { handleRequest } from './api.ts'
import type { ServerWebSocket } from 'bun'
import type { KanbanProvider } from './providers/types.ts'

const wsClients = new Set<ServerWebSocket<unknown>>()
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
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

export function startServer(provider: KanbanProvider, port: number): void {
  const distDir = join(import.meta.dir, '..', 'ui', 'dist')
  const hasStatic = existsSync(distDir)

  Bun.serve({
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
        const context = await provider.getContext()
        return Response.json({
          ok: true,
          data: { status: 'running', wsClients: wsClients.size, provider: context.provider },
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
}
