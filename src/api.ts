import { KanbanError, ErrorCode } from './errors'
import type { BoardConfig, CliOutput, Task } from './types'
import type { CreateTaskInput, UpdateTaskInput, KanbanProvider } from './providers/types'
import { parsePositiveInt } from './transport-input'
import { success } from './output'
import { normalizeCreateTaskInput } from './use-cases'

type WsEvent =
  | { type: 'task:upsert'; task: Task; columnId: string }
  | { type: 'task:delete'; id: string }
  // Fallback when a mutation has no precise event; the UI does a full refresh.
  | { type: 'refresh' }

interface MoveTaskBody {
  column?: string
}

interface CommentBody {
  body?: string
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status })
}

function requireArgument(value: unknown, field: string): void {
  if (!value) {
    throw new KanbanError(ErrorCode.MISSING_ARGUMENT, `${field} is required`)
  }
}

// Parse a JSON request body inside a wrapHandler scope so malformed/empty/
// wrong-content-type bodies surface through the same { ok:false, error }
// envelope as every other validation failure instead of escaping as a raw 500.
async function parseJsonBody<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T
  } catch {
    throw new KanbanError(ErrorCode.INVALID_REQUEST_BODY, 'Request body must be valid JSON')
  }
}

function statusForCode(code: string): number {
  if (
    code === ErrorCode.TASK_NOT_FOUND ||
    code === ErrorCode.COLUMN_NOT_FOUND ||
    code === ErrorCode.COMMENT_NOT_FOUND ||
    code === ErrorCode.NOT_FOUND
  )
    return 404
  if (code === ErrorCode.PROVIDER_AUTH_FAILED) return 401
  if (code === ErrorCode.PROVIDER_RATE_LIMITED) return 429
  if (code === ErrorCode.CONFLICT) return 409
  if (code === ErrorCode.UNSUPPORTED_OPERATION) return 400
  // Server-side / upstream failures must surface as 5xx, not as the default 400.
  // (The MCP layer likewise treats these as `provider_unavailable`.)
  if (code === ErrorCode.PROVIDER_UPSTREAM_ERROR) return 502
  if (code === ErrorCode.PROVIDER_SYNC_REQUIRED) return 503
  if (code === ErrorCode.PROVIDER_NOT_CONFIGURED || code === ErrorCode.INTERNAL_ERROR) return 500
  return 400
}

// decodeURIComponent throws URIError on malformed percent-encoding (e.g. a lone
// `%`). Path params flow straight into it, so a bad URL must surface as a 400
// envelope rather than escaping handleRequest as an unhandled rejection.
function decodePathParam(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    throw new KanbanError(ErrorCode.INVALID_ARGUMENT, 'Malformed percent-encoding in URL path')
  }
}

function toResponse(result: CliOutput): Response {
  if (result.ok) return json(result)
  return json(result, statusForCode(result.error.code))
}

// Map any thrown error to the `{ ok:false, error }` envelope with the right
// status. Shared by wrapHandler (per-handler) and handleRequest's top-level
// guard so the two error paths can never drift apart.
function errorResponse(err: unknown): Response {
  if (err instanceof KanbanError) {
    return json(
      { ok: false, error: { code: err.code, message: err.message } },
      statusForCode(err.code),
    )
  }
  const msg = err instanceof Error ? err.message : String(err)
  return json({ ok: false, error: { code: 'INTERNAL_ERROR', message: msg } }, 500)
}

async function wrapHandler(fn: () => Promise<CliOutput> | CliOutput): Promise<Response> {
  try {
    return toResponse(await fn())
  } catch (err) {
    return errorResponse(err)
  }
}

async function okHandler<T>(fn: () => Promise<T> | T): Promise<Response> {
  return wrapHandler(async () => success(await fn()))
}

export interface ApiResult {
  response: Response
  mutated: boolean
  event?: WsEvent
}

function upsertEvent(task: Task): WsEvent {
  return { type: 'task:upsert', task, columnId: task.column_id }
}

async function readResult<T>(fn: () => Promise<T> | T): Promise<ApiResult> {
  return { response: await okHandler(fn), mutated: false }
}

async function mutationResult<T>(
  fn: () => Promise<T> | T,
  eventFor?: (data: T) => WsEvent | undefined,
): Promise<ApiResult> {
  let data: T | undefined
  const response = await okHandler(async () => {
    data = await fn()
    return data
  })
  return {
    response,
    mutated: response.ok,
    event: response.ok && data !== undefined && eventFor ? eventFor(data) : undefined,
  }
}

// Top-level guard: handleRequest must NEVER throw. The webhook branch returns a
// raw ApiResult (not via wrapHandler), and path-param decoding / body reads can
// throw before any handler runs. Any escape would reach Bun.serve's fetch (which
// has no try/catch) and surface as a bare, non-enveloped 500. This wrapper keeps
// every failure inside the { ok:false, error } contract, never marking mutated.
export async function handleRequest(provider: KanbanProvider, req: Request): Promise<ApiResult> {
  try {
    return await dispatchApiRequest(provider, req)
  } catch (err) {
    return { response: errorResponse(err), mutated: false }
  }
}

async function dispatchApiRequest(provider: KanbanProvider, req: Request): Promise<ApiResult> {
  const url = new URL(req.url)
  const path = url.pathname
  const method = req.method

  if (path === '/api/bootstrap' && method === 'GET') {
    return readResult(() => provider.getBootstrap())
  }

  if (path === '/api/provider' && method === 'GET') {
    return readResult(() => provider.getContext())
  }

  if (path === '/api/board' && method === 'GET') {
    return readResult(() => provider.getBoard())
  }

  if (path === '/api/columns' && method === 'GET') {
    return readResult(() => provider.listColumns())
  }

  if (path === '/api/tasks' && method === 'GET') {
    return readResult(() => {
      const column = url.searchParams.get('column') ?? undefined
      const priority = url.searchParams.get('priority') ?? undefined
      const assignee = url.searchParams.get('assignee') ?? undefined
      const project = url.searchParams.get('project') ?? undefined
      const sort = url.searchParams.get('sort') ?? undefined
      const limit = parsePositiveInt(url.searchParams.get('limit'))
      return provider.listTasks({ column, priority, assignee, project, sort, limit })
    })
  }

  if (path === '/api/tasks' && method === 'POST') {
    return mutationResult(async () => {
      const body = await parseJsonBody<Partial<CreateTaskInput>>(req)
      requireArgument(body.title, 'title')
      return provider.createTask(
        normalizeCreateTaskInput({
          title: body.title!,
          description: body.description,
          column: body.column,
          priority: body.priority,
          assignee: body.assignee,
          project: body.project,
          labels: body.labels,
          metadata: body.metadata,
        }),
      )
    }, upsertEvent)
  }

  const taskMatch = path.match(/^\/api\/tasks\/([^/]+)$/)
  if (taskMatch) {
    const id = decodePathParam(taskMatch[1]!)

    if (method === 'GET') {
      return readResult(() => provider.getTask(id))
    }

    if (method === 'PATCH') {
      return mutationResult(async () => {
        const body = await parseJsonBody<UpdateTaskInput>(req)
        return provider.updateTask(id, body)
      }, upsertEvent)
    }

    if (method === 'DELETE') {
      return mutationResult(
        () => provider.deleteTask(id),
        () => ({ type: 'task:delete', id }),
      )
    }
  }

  const moveMatch = path.match(/^\/api\/tasks\/([^/]+)\/move$/)
  if (moveMatch && method === 'PATCH') {
    const id = decodePathParam(moveMatch[1]!)
    return mutationResult(async () => {
      const body = await parseJsonBody<MoveTaskBody>(req)
      requireArgument(body.column, 'column')
      return provider.moveTask(id, body.column!)
    }, upsertEvent)
  }

  const commentsMatch = path.match(/^\/api\/tasks\/([^/]+)\/comments$/)
  if (commentsMatch) {
    const id = decodePathParam(commentsMatch[1]!)
    if (method === 'GET') {
      return readResult(() => provider.listComments(id))
    }

    if (method === 'POST') {
      return mutationResult(async () => {
        const body = await parseJsonBody<CommentBody>(req)
        requireArgument(body.body, 'body')
        return provider.comment(id, body.body!)
      })
    }
  }

  const commentMatch = path.match(/^\/api\/tasks\/([^/]+)\/comments\/([^/]+)$/)
  if (commentMatch) {
    const id = decodePathParam(commentMatch[1]!)
    const commentId = decodePathParam(commentMatch[2]!)

    if (method === 'PATCH') {
      return mutationResult(async () => {
        const body = await parseJsonBody<CommentBody>(req)
        requireArgument(body.body, 'body')
        return provider.updateComment(id, commentId, body.body!)
      })
    }
  }

  if (path === '/api/activity' && method === 'GET') {
    return readResult(() => {
      const taskId = url.searchParams.get('taskId') ?? undefined
      const limit = parsePositiveInt(url.searchParams.get('limit'))
      return provider.getActivity(limit, taskId)
    })
  }

  if (path === '/api/metrics' && method === 'GET') {
    return readResult(() => provider.getMetrics())
  }

  if (path === '/api/config' && method === 'GET') {
    return readResult(() => provider.getConfig())
  }

  if (path === '/api/config' && method === 'PATCH') {
    return mutationResult(async () => {
      const body = await parseJsonBody<Partial<BoardConfig>>(req)
      return provider.patchConfig(body)
    })
  }

  const webhookMatch = path.match(/^\/api\/webhooks\/([^/]+)$/)
  if (webhookMatch && method === 'POST') {
    const target = decodePathParam(webhookMatch[1]!)
    if (target !== provider.type) {
      return {
        response: json(
          {
            ok: false,
            error: {
              code: 'UNSUPPORTED_OPERATION',
              message: `Webhook target '${target}' does not match active provider '${provider.type}'`,
            },
          },
          400,
        ),
        mutated: false,
      }
    }
    if (!provider.handleWebhook) {
      return {
        response: json(
          {
            ok: false,
            error: {
              code: 'UNSUPPORTED_OPERATION',
              message: `Provider '${provider.type}' does not accept webhooks`,
            },
          },
          400,
        ),
        mutated: false,
      }
    }
    const rawBody = await req.text()
    const headers: Record<string, string> = {}
    req.headers.forEach((value, key) => {
      headers[key] = value
    })
    // A throwing provider.handleWebhook is contained by the top-level guard in
    // handleRequest, which envelopes it as a 500 (or KanbanError status) and
    // leaves mutated:false.
    const result = await provider.handleWebhook({ headers, rawBody })
    if (result.unauthorized) {
      return {
        response: json(
          {
            ok: false,
            error: { code: 'PROVIDER_AUTH_FAILED', message: result.message ?? 'Unauthorized' },
          },
          401,
        ),
        mutated: false,
      }
    }
    return {
      response: json({
        ok: true,
        data: { handled: result.handled, message: result.message ?? null },
      }),
      mutated: result.handled,
    }
  }

  return {
    response: json(
      { ok: false, error: { code: ErrorCode.NOT_FOUND, message: `No route: ${method} ${path}` } },
      404,
    ),
    mutated: false,
  }
}
