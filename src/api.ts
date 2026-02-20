import { Database } from 'bun:sqlite'
import { KanbanError } from './errors.ts'
import {
  getBoardView,
  listColumns,
  addTask,
  getTask,
  listTasks,
  updateTask,
  deleteTask,
  moveTask,
  getDbPath,
} from './db.ts'
import { listActivity } from './activity.ts'
import { getBoardMetrics } from './metrics.ts'
import { loadConfig, saveConfig, getConfigPath } from './config.ts'
import type { Priority, CliOutput } from './types.ts'

interface CreateTaskBody {
  title?: string
  description?: string
  column?: string
  priority?: Priority
  assignee?: string
  project?: string
  metadata?: string
}

interface UpdateTaskBody {
  title?: string
  description?: string
  priority?: Priority
  assignee?: string
  project?: string
  metadata?: string
}

interface MoveTaskBody {
  column?: string
}

interface PatchConfigBody {
  members?: { name: string; role: 'human' | 'agent' }[]
  projects?: string[]
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

function toResponse(result: CliOutput): Response {
  if (result.ok) return json(result)
  const status = result.error.code.includes('NOT_FOUND') ? 404 : 400
  return json(result, status)
}

function wrapHandler(fn: () => CliOutput): Response {
  try {
    return toResponse(fn())
  } catch (err) {
    if (err instanceof KanbanError) {
      const status = err.code.includes('NOT_FOUND') ? 404 : 400
      return json({ ok: false, error: { code: err.code, message: err.message } }, status)
    }
    const msg = err instanceof Error ? err.message : String(err)
    return json({ ok: false, error: { code: 'INTERNAL_ERROR', message: msg } }, 500)
  }
}

export interface ApiResult {
  response: Response
  mutated: boolean
}

export async function handleRequest(db: Database, req: Request): Promise<ApiResult> {
  const url = new URL(req.url)
  const path = url.pathname
  const method = req.method

  if (path === '/api/board' && method === 'GET') {
    return { response: wrapHandler(() => ({ ok: true, data: getBoardView(db) })), mutated: false }
  }

  if (path === '/api/columns' && method === 'GET') {
    return { response: wrapHandler(() => ({ ok: true, data: listColumns(db) })), mutated: false }
  }

  if (path === '/api/tasks' && method === 'GET') {
    return {
      response: wrapHandler(() => {
        const column = url.searchParams.get('column') ?? undefined
        const priority = url.searchParams.get('priority') ?? undefined
        const assignee = url.searchParams.get('assignee') ?? undefined
        const project = url.searchParams.get('project') ?? undefined
        const sort = url.searchParams.get('sort') ?? undefined
        const limit = parseOptionalInt(url.searchParams.get('limit'))
        return {
          ok: true,
          data: listTasks(db, { column, priority, assignee, project, limit, sort }),
        }
      }),
      mutated: false,
    }
  }

  if (path === '/api/tasks' && method === 'POST') {
    const body = (await req.json()) as CreateTaskBody
    if (!body.title) {
      return {
        response: missingArgument('title'),
        mutated: false,
      }
    }
    const response = wrapHandler(() => ({
      ok: true,
      data: addTask(db, body.title!, {
        description: body.description,
        column: body.column,
        priority: body.priority,
        assignee: body.assignee,
        project: body.project,
        metadata: body.metadata,
      }),
    }))
    return { response, mutated: response.ok }
  }

  const taskMatch = path.match(/^\/api\/tasks\/([^/]+)$/)
  if (taskMatch) {
    const id = taskMatch[1]!

    if (method === 'GET') {
      return { response: wrapHandler(() => ({ ok: true, data: getTask(db, id) })), mutated: false }
    }

    if (method === 'PATCH') {
      const body = (await req.json()) as UpdateTaskBody
      const response = wrapHandler(() => ({ ok: true, data: updateTask(db, id, body) }))
      return { response, mutated: response.ok }
    }

    if (method === 'DELETE') {
      const response = wrapHandler(() => ({ ok: true, data: deleteTask(db, id) }))
      return { response, mutated: response.ok }
    }
  }

  const moveMatch = path.match(/^\/api\/tasks\/([^/]+)\/move$/)
  if (moveMatch && method === 'PATCH') {
    const id = moveMatch[1]!
    const body = (await req.json()) as MoveTaskBody
    if (!body.column) {
      return {
        response: missingArgument('column'),
        mutated: false,
      }
    }
    const response = wrapHandler(() => ({ ok: true, data: moveTask(db, id, body.column!) }))
    return { response, mutated: response.ok }
  }

  if (path === '/api/activity' && method === 'GET') {
    return {
      response: wrapHandler(() => {
        const taskId = url.searchParams.get('taskId') ?? undefined
        const limit = parseOptionalInt(url.searchParams.get('limit'))
        return { ok: true, data: listActivity(db, { taskId, limit }) }
      }),
      mutated: false,
    }
  }

  if (path === '/api/metrics' && method === 'GET') {
    return {
      response: wrapHandler(() => ({ ok: true, data: getBoardMetrics(db) })),
      mutated: false,
    }
  }

  if (path === '/api/config' && method === 'GET') {
    const dbPath = (db.filename as string) || getDbPath()
    return {
      response: wrapHandler(() => {
        const config = loadConfig(dbPath)
        const metrics = getBoardMetrics(db)
        return {
          ok: true,
          data: {
            members: config.members,
            projects: [...new Set([...config.projects, ...metrics.projects])],
            discoveredAssignees: metrics.assignees,
            discoveredProjects: metrics.projects,
          },
        }
      }),
      mutated: false,
    }
  }

  if (path === '/api/config' && method === 'PATCH') {
    const dbPath = (db.filename as string) || getDbPath()
    const body = (await req.json()) as PatchConfigBody
    const response = wrapHandler(() => {
      const config = loadConfig(dbPath)
      if (body.members) config.members = body.members
      if (body.projects) config.projects = body.projects
      saveConfig(getConfigPath(dbPath), config)
      return { ok: true, data: config }
    })
    return { response, mutated: response.ok }
  }

  return {
    response: json(
      {
        ok: false,
        error: { code: 'NOT_FOUND', message: `No route: ${method} ${path}` },
      },
      404,
    ),
    mutated: false,
  }
}
