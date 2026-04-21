import { KanbanError, ErrorCode } from './errors.ts'
import type { BoardConfig, CliOutput, Task } from './types.ts'
import type { CreateTaskInput, UpdateTaskInput, KanbanProvider } from './providers/types.ts'

export type WsEvent =
  | { type: 'task:upsert'; task: Task; columnName: string }
  | { type: 'task:delete'; id: string }

interface MoveTaskBody {
  column?: string
}

interface CommentBody {
  body?: string
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status })
}

function parseOptionalInt(value: string | null): number | undefined {
  return value ? parseInt(value, 10) : undefined
}

function missingArgument(field: string): Response {
  return json(
    { ok: false, error: { code: 'MISSING_ARGUMENT', message: `${field} is required` } },
    400,
  )
}

function statusForCode(code: string): number {
  if (
    code === ErrorCode.TASK_NOT_FOUND ||
    code === ErrorCode.COLUMN_NOT_FOUND ||
    code === ErrorCode.COMMENT_NOT_FOUND
  )
    return 404
  if (code === ErrorCode.PROVIDER_AUTH_FAILED) return 401
  if (code === ErrorCode.PROVIDER_RATE_LIMITED) return 429
  if (code === ErrorCode.CONFLICT) return 409
  if (code === ErrorCode.UNSUPPORTED_OPERATION) return 400
  if (code === ErrorCode.PROVIDER_NOT_CONFIGURED) return 500
  return 400
}

function toResponse(result: CliOutput): Response {
  if (result.ok) return json(result)
  return json(result, statusForCode(result.error.code))
}

async function wrapHandler(fn: () => Promise<CliOutput> | CliOutput): Promise<Response> {
  try {
    return toResponse(await fn())
  } catch (err) {
    if (err instanceof KanbanError) {
      return json(
        { ok: false, error: { code: err.code, message: err.message } },
        statusForCode(err.code),
      )
    }
    const msg = err instanceof Error ? err.message : String(err)
    return json({ ok: false, error: { code: 'INTERNAL_ERROR', message: msg } }, 500)
  }
}

export interface ApiResult {
  response: Response
  mutated: boolean
  event?: WsEvent
}

async function resolveColumnName(
  provider: KanbanProvider,
  columnId: string,
): Promise<string | null> {
  const columns = await provider.listColumns()
  return columns.find((column) => column.id === columnId)?.name ?? null
}

async function upsertEvent(provider: KanbanProvider, task: Task): Promise<WsEvent | undefined> {
  const columnName = await resolveColumnName(provider, task.column_id)
  return columnName ? { type: 'task:upsert', task, columnName } : undefined
}

export async function handleRequest(provider: KanbanProvider, req: Request): Promise<ApiResult> {
  const url = new URL(req.url)
  const path = url.pathname
  const method = req.method

  if (path === '/api/bootstrap' && method === 'GET') {
    return {
      response: await wrapHandler(async () => ({ ok: true, data: await provider.getBootstrap() })),
      mutated: false,
    }
  }

  if (path === '/api/provider' && method === 'GET') {
    return {
      response: await wrapHandler(async () => ({ ok: true, data: await provider.getContext() })),
      mutated: false,
    }
  }

  if (path === '/api/board' && method === 'GET') {
    return {
      response: await wrapHandler(async () => ({ ok: true, data: await provider.getBoard() })),
      mutated: false,
    }
  }

  if (path === '/api/columns' && method === 'GET') {
    return {
      response: await wrapHandler(async () => ({ ok: true, data: await provider.listColumns() })),
      mutated: false,
    }
  }

  if (path === '/api/tasks' && method === 'GET') {
    return {
      response: await wrapHandler(async () => {
        const column = url.searchParams.get('column') ?? undefined
        const priority = url.searchParams.get('priority') ?? undefined
        const assignee = url.searchParams.get('assignee') ?? undefined
        const project = url.searchParams.get('project') ?? undefined
        const sort = url.searchParams.get('sort') ?? undefined
        const limit = parseOptionalInt(url.searchParams.get('limit'))
        return {
          ok: true,
          data: await provider.listTasks({ column, priority, assignee, project, sort, limit }),
        }
      }),
      mutated: false,
    }
  }

  if (path === '/api/tasks' && method === 'POST') {
    const body = (await req.json()) as Partial<CreateTaskInput>
    if (!body.title) return { response: missingArgument('title'), mutated: false }
    let created: Task | null = null
    const response = await wrapHandler(async () => {
      created = await provider.createTask({
        title: body.title!,
        description: body.description,
        column: body.column,
        priority: body.priority,
        assignee: body.assignee,
        project: body.project,
        metadata: body.metadata,
      })
      return { ok: true, data: created }
    })
    const event = response.ok && created ? await upsertEvent(provider, created) : undefined
    return { response, mutated: response.ok, event }
  }

  const taskMatch = path.match(/^\/api\/tasks\/([^/]+)$/)
  if (taskMatch) {
    const id = decodeURIComponent(taskMatch[1]!)

    if (method === 'GET') {
      return {
        response: await wrapHandler(async () => ({ ok: true, data: await provider.getTask(id) })),
        mutated: false,
      }
    }

    if (method === 'PATCH') {
      const body = (await req.json()) as UpdateTaskInput
      let updated: Task | null = null
      const response = await wrapHandler(async () => {
        updated = await provider.updateTask(id, body)
        return { ok: true, data: updated }
      })
      const event = response.ok && updated ? await upsertEvent(provider, updated) : undefined
      return { response, mutated: response.ok, event }
    }

    if (method === 'DELETE') {
      const response = await wrapHandler(async () => ({
        ok: true,
        data: await provider.deleteTask(id),
      }))
      const event: WsEvent | undefined = response.ok ? { type: 'task:delete', id } : undefined
      return { response, mutated: response.ok, event }
    }
  }

  const moveMatch = path.match(/^\/api\/tasks\/([^/]+)\/move$/)
  if (moveMatch && method === 'PATCH') {
    const id = decodeURIComponent(moveMatch[1]!)
    const body = (await req.json()) as MoveTaskBody
    if (!body.column) return { response: missingArgument('column'), mutated: false }
    let moved: Task | null = null
    const response = await wrapHandler(async () => {
      moved = await provider.moveTask(id, body.column!)
      return { ok: true, data: moved }
    })
    const event = response.ok && moved ? await upsertEvent(provider, moved) : undefined
    return { response, mutated: response.ok, event }
  }

  const commentsMatch = path.match(/^\/api\/tasks\/([^/]+)\/comments$/)
  if (commentsMatch) {
    const id = decodeURIComponent(commentsMatch[1]!)
    if (method === 'GET') {
      return {
        response: await wrapHandler(async () => ({
          ok: true,
          data: await provider.listComments(id),
        })),
        mutated: false,
      }
    }

    if (method === 'POST') {
      const body = (await req.json()) as CommentBody
      if (!body.body) return { response: missingArgument('body'), mutated: false }
      const response = await wrapHandler(async () => ({
        ok: true,
        data: await provider.comment(id, body.body!),
      }))
      return { response, mutated: response.ok }
    }
  }

  const commentMatch = path.match(/^\/api\/tasks\/([^/]+)\/comments\/([^/]+)$/)
  if (commentMatch) {
    const id = decodeURIComponent(commentMatch[1]!)
    const commentId = decodeURIComponent(commentMatch[2]!)

    if (method === 'PATCH') {
      const body = (await req.json()) as CommentBody
      if (!body.body) return { response: missingArgument('body'), mutated: false }
      const response = await wrapHandler(async () => ({
        ok: true,
        data: await provider.updateComment(id, commentId, body.body!),
      }))
      return { response, mutated: response.ok }
    }
  }

  if (path === '/api/activity' && method === 'GET') {
    return {
      response: await wrapHandler(async () => {
        const taskId = url.searchParams.get('taskId') ?? undefined
        const limit = parseOptionalInt(url.searchParams.get('limit'))
        return { ok: true, data: await provider.getActivity(limit, taskId) }
      }),
      mutated: false,
    }
  }

  if (path === '/api/metrics' && method === 'GET') {
    return {
      response: await wrapHandler(async () => ({ ok: true, data: await provider.getMetrics() })),
      mutated: false,
    }
  }

  if (path === '/api/config' && method === 'GET') {
    return {
      response: await wrapHandler(async () => ({ ok: true, data: await provider.getConfig() })),
      mutated: false,
    }
  }

  if (path === '/api/config' && method === 'PATCH') {
    const body = (await req.json()) as Partial<BoardConfig>
    const response = await wrapHandler(async () => ({
      ok: true,
      data: await provider.patchConfig(body),
    }))
    return { response, mutated: response.ok }
  }

  const webhookMatch = path.match(/^\/api\/webhooks\/([^/]+)$/)
  if (webhookMatch && method === 'POST') {
    const target = decodeURIComponent(webhookMatch[1]!)
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
      { ok: false, error: { code: 'NOT_FOUND', message: `No route: ${method} ${path}` } },
      404,
    ),
    mutated: false,
  }
}
