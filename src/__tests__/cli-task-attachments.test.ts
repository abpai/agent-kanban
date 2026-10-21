import { mockFetch } from './helpers/fetch'
import { assertKanbanError } from './helpers/errors'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attachmentList } from '../commands/attachment'
import { ErrorCode, type ErrorCodeValue, type KanbanError } from '../errors'
import { run } from '../index'
import { formatOutput, success } from '../output'
import { LINEAR_CAPABILITIES } from '../providers/capabilities'
import {
  initJiraCacheSchema,
  saveJiraSyncMeta,
  saveTeamInfo,
  upsertJiraIssues,
} from '../providers/jira-cache'
import { LinearProvider } from '../providers/linear'
import { initLinearCacheSchema } from '../providers/linear-cache'
import type { TaskAttachment } from '../types'

const ENV_KEYS = [
  'KANBAN_PROVIDER',
  'JIRA_BASE_URL',
  'JIRA_EMAIL',
  'JIRA_API_TOKEN',
  'JIRA_PROJECT_KEY',
  'JIRA_BOARD_ID',
  'JIRA_ISSUE_TYPE',
] as const

const ISSUE_URL = 'https://example.atlassian.net/rest/api/3/issue/ENG-1?fields=attachment'
const contentUrl = (id: string) =>
  `https://example.atlassian.net/rest/api/3/attachment/content/${id}?redirect=false`

const specBytes = new TextEncoder().encode('# spec\n\nread me\n')
const notesBytes = new TextEncoder().encode('notes v2\n')

let jiraAttachments: Array<{ id: string; filename: string; mimeType: string; size: number }>
let contentById: Map<string, Uint8Array>
let requests: string[]
let originalFetch: typeof fetch
let originalCwd: string
let envSnapshot: Record<string, string | undefined>
let dir: string
let dbPath: string

function seedJiraCache(path: string): void {
  const db = new Database(path)
  initJiraCacheSchema(db)
  saveJiraSyncMeta(db, {
    projectKey: 'ENG',
    boardId: null,
    lastSyncAt: new Date().toISOString(),
    lastIssueUpdatedAt: '2026-01-02T00:00:00Z',
  })
  saveTeamInfo(db, { id: '10000', key: 'ENG', name: 'Engineering' })
  upsertJiraIssues(db, [
    {
      id: '10001',
      key: 'ENG-1',
      summary: 'Issue 1',
      descriptionText: '',
      statusId: '10000',
      priorityName: 'High',
      issueTypeName: 'Task',
      assigneeAccountId: null,
      assigneeName: '',
      labels: [],
      commentCount: 0,
      projectKey: 'ENG',
      url: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
    },
  ])
  db.close()
}

function useJira(): void {
  process.env['KANBAN_PROVIDER'] = 'jira'
  process.env['JIRA_BASE_URL'] = 'https://example.atlassian.net'
  process.env['JIRA_EMAIL'] = 'a@example.com'
  process.env['JIRA_API_TOKEN'] = 'tok-test'
  process.env['JIRA_PROJECT_KEY'] = 'ENG'
  seedJiraCache(dbPath)
}

function expectOk<T>(result: Awaited<ReturnType<typeof run>>): T {
  expect(result.exitCode).toBe(0)
  if (!result.output.ok) throw new Error('expected successful CLI output')
  // SAFETY: each test names the documented result type of the command it ran and asserts its fields.
  return result.output.data as T
}

async function expectKanbanError(
  pending: Promise<unknown>,
  code: ErrorCodeValue,
): Promise<KanbanError> {
  const err = await pending.then(
    () => null,
    (cause: unknown) => cause,
  )
  assertKanbanError(err)
  expect(err.code).toBe(code)
  return err
}

beforeEach(() => {
  envSnapshot = {}
  for (const key of ENV_KEYS) {
    envSnapshot[key] = process.env[key]
    delete process.env[key]
  }
  dir = mkdtempSync(join(tmpdir(), 'kanban-attachments-'))
  dbPath = join(dir, 'board.db')
  originalCwd = process.cwd()
  process.chdir(dir)

  jiraAttachments = [
    { id: 'att-1', filename: 'spec.md', mimeType: 'text/markdown', size: specBytes.byteLength },
    { id: 'att-2', filename: 'notes.txt', mimeType: 'text/plain', size: notesBytes.byteLength },
  ]
  contentById = new Map([
    ['att-1', specBytes],
    ['att-2', notesBytes],
  ])
  requests = []
  originalFetch = globalThis.fetch
  globalThis.fetch = mockFetch(async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : input.toString()
    requests.push(url)
    if (url === ISSUE_URL) {
      const issue = { id: '10001', key: 'ENG-1', fields: { attachment: jiraAttachments } }
      return Response.json(issue)
    }
    for (const [id, bytes] of contentById) {
      if (url === contentUrl(id)) return new Response(bytes, { status: 200 })
    }
    throw new Error(`Unexpected Jira request: ${url}`)
  })
})

afterEach(() => {
  globalThis.fetch = originalFetch
  process.chdir(originalCwd)
  rmSync(dir, { recursive: true, force: true })
  for (const key of ENV_KEYS) {
    const prev = envSnapshot[key]
    if (prev === undefined) delete process.env[key]
    else process.env[key] = prev
  }
})

describe('kanban task attachments (Jira)', () => {
  test('lists attachment metadata in the standard envelope', async () => {
    useJira()

    const attachments = expectOk<TaskAttachment[]>(
      await run(['--db', dbPath, 'task', 'attachments', 'ENG-1']),
    )

    expect(attachments.map((a) => [a.id, a.filename, a.byte_size])).toEqual([
      ['att-1', 'spec.md', specBytes.byteLength],
      ['att-2', 'notes.txt', notesBytes.byteLength],
    ])
    expect(requests).toEqual([ISSUE_URL])
  })

  test('requires a task id', async () => {
    useJira()
    await expectKanbanError(
      run(['--db', dbPath, 'task', 'attachments']),
      ErrorCode.MISSING_ARGUMENT,
    )
  })
})

describe('kanban task attachment get (Jira)', () => {
  test('writes the bytes to the attachment filename in the current directory by default', async () => {
    useJira()

    const result = await run(['--db', dbPath, 'task', 'attachment', 'get', 'ENG-1', 'spec.md'])
    const data = expectOk<{ attachment: TaskAttachment; path: string }>(result)

    expect(result.stdout).toBeUndefined()
    expect(data.attachment.id).toBe('att-1')
    expect(data.path).toBe(join(process.cwd(), 'spec.md'))
    expect(readFileSync(data.path)).toEqual(Buffer.from(specBytes))
  })

  test('resolves an attachment id and writes to an explicit -o path, replacing it', async () => {
    useJira()
    const target = join(dir, 'out.txt')
    writeFileSync(target, 'stale')

    const data = expectOk<{ attachment: TaskAttachment; path: string }>(
      await run(['--db', dbPath, 'task', 'attachment', 'get', 'ENG-1', 'att-2', '-o', target]),
    )

    expect(data).toMatchObject({ attachment: { id: 'att-2', filename: 'notes.txt' }, path: target })
    expect(readFileSync(target, 'utf8')).toBe('notes v2\n')
  })

  test('refuses to replace an existing file at the default path', async () => {
    useJira()
    writeFileSync(join(dir, 'spec.md'), 'keep me')

    const err = await expectKanbanError(
      run(['--db', dbPath, 'task', 'attachment', 'get', 'ENG-1', 'spec.md']),
      ErrorCode.CONFLICT,
    )

    expect(err.message).toContain('-o <path>')
    expect(readFileSync(join(dir, 'spec.md'), 'utf8')).toBe('keep me')
  })

  test('-o - hands the bytes to stdout and writes no file', async () => {
    useJira()

    const result = await run([
      '--db',
      dbPath,
      'task',
      'attachment',
      'get',
      'ENG-1',
      'spec.md',
      '-o',
      '-',
    ])
    const data = expectOk<{ attachment: TaskAttachment; path: string }>(result)

    expect(data.path).toBe('-')
    expect(result.stdout).toEqual(specBytes)
    expect(existsSync(join(dir, 'spec.md'))).toBe(false)
  })

  test('the spawned CLI prints only the bytes on stdout and the envelope on stderr', async () => {
    useJira()
    // The child process cannot see the fetch mock, so it talks to a local fake Jira.
    const fakeJira = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === '/rest/api/3/issue/ENG-1') {
          return Response.json({
            id: '10001',
            key: 'ENG-1',
            fields: { attachment: jiraAttachments },
          })
        }
        if (url.pathname === '/rest/api/3/attachment/content/att-1') return new Response(specBytes)
        return new Response('unexpected', { status: 500 })
      },
    })
    try {
      const child = Bun.spawn({
        cmd: [
          process.execPath,
          join(originalCwd, 'src/index.ts'),
          '--db',
          dbPath,
          'task',
          'attachment',
          'get',
          'ENG-1',
          'spec.md',
          '-o',
          '-',
        ],
        cwd: dir,
        env: { ...process.env, JIRA_BASE_URL: `http://127.0.0.1:${fakeJira.port}`, NO_COLOR: '1' },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).arrayBuffer(),
        new Response(child.stderr).text(),
        child.exited,
      ])

      expect({ exitCode, stderr }).toMatchObject({ exitCode: 0 })
      expect(new Uint8Array(stdout)).toEqual(specBytes)
      expect(JSON.parse(stderr)).toMatchObject({
        ok: true,
        data: { attachment: { id: 'att-1' }, path: '-' },
      })
    } finally {
      await fakeJira.stop(true)
    }
  })

  test('--help lists both attachment commands', async () => {
    const help = expectOk<{ message: string }>(await run(['--help']))
    expect(help.message).toContain('task attachments <id>')
    expect(help.message).toContain('task attachment get <id> <name-or-attachment-id>')
  })

  test('only the last segment of a remote filename is used, and dotfiles are refused', async () => {
    useJira()
    jiraAttachments = [
      {
        id: 'att-1',
        filename: '../../escape.md',
        mimeType: 'text/markdown',
        size: specBytes.byteLength,
      },
      { id: 'att-2', filename: '.npmrc', mimeType: 'text/plain', size: notesBytes.byteLength },
    ]

    const data = expectOk<{ path: string }>(
      await run(['--db', dbPath, 'task', 'attachment', 'get', 'ENG-1', 'att-1']),
    )
    expect(data.path).toBe(join(process.cwd(), 'escape.md'))

    const err = await expectKanbanError(
      run(['--db', dbPath, 'task', 'attachment', 'get', 'ENG-1', 'att-2']),
      ErrorCode.INVALID_ARGUMENT,
    )
    expect(err.message).toContain('pass -o <path>')
    expect(existsSync(join(dir, '.npmrc'))).toBe(false)
  })

  test('an unknown name or id is NOT_FOUND and downloads nothing', async () => {
    useJira()

    await expectKanbanError(
      run(['--db', dbPath, 'task', 'attachment', 'get', 'ENG-1', 'missing.pdf']),
      ErrorCode.NOT_FOUND,
    )
    expect(requests).toEqual([ISSUE_URL])
  })

  test('a filename shared by two attachments is refused with both ids', async () => {
    useJira()
    jiraAttachments = [
      { id: 'att-1', filename: 'spec.md', mimeType: 'text/markdown', size: specBytes.byteLength },
      { id: 'att-2', filename: 'spec.md', mimeType: 'text/markdown', size: notesBytes.byteLength },
    ]

    const err = await expectKanbanError(
      run(['--db', dbPath, 'task', 'attachment', 'get', 'ENG-1', 'spec.md']),
      ErrorCode.INVALID_ARGUMENT,
    )
    expect(err.message).toContain('att-1, att-2')
  })

  test('--max-bytes below the declared size is ATTACHMENT_REFUSED before any download', async () => {
    useJira()

    await expectKanbanError(
      run(['--db', dbPath, 'task', 'attachment', 'get', 'ENG-1', 'spec.md', '--max-bytes', '4']),
      ErrorCode.ATTACHMENT_REFUSED,
    )
    expect(requests.some((url) => url.includes('/attachment/content/'))).toBe(false)
    await expectKanbanError(
      run(['--db', dbPath, 'task', 'attachment', 'get', 'ENG-1', 'spec.md', '--max-bytes', '0']),
      ErrorCode.INVALID_ARGUMENT,
    )
  })

  test('usage errors are structured', async () => {
    useJira()

    await expectKanbanError(
      run(['--db', dbPath, 'task', 'attachment', 'get', 'ENG-1']),
      ErrorCode.MISSING_ARGUMENT,
    )
    await expectKanbanError(
      run(['--db', dbPath, 'task', 'attachment', 'list', 'ENG-1']),
      ErrorCode.UNKNOWN_COMMAND,
    )
  })
})

describe('providers without attachments', () => {
  test('local refuses both commands with UNSUPPORTED_OPERATION and writes nothing', async () => {
    process.env['KANBAN_PROVIDER'] = 'local'
    const task = expectOk<{ id: string }>(await run(['--db', dbPath, 'task', 'add', 'No files']))

    const listErr = await expectKanbanError(
      run(['--db', dbPath, 'task', 'attachments', task.id]),
      ErrorCode.UNSUPPORTED_OPERATION,
    )
    expect(listErr.message).toBe('Task attachments are not supported by the local provider')
    await expectKanbanError(
      run(['--db', dbPath, 'task', 'attachment', 'get', task.id, 'spec.md']),
      ErrorCode.UNSUPPORTED_OPERATION,
    )
    expect(existsSync(join(dir, 'spec.md'))).toBe(false)
    expect(requests).toEqual([])
  })

  test('Linear refuses from its capability flag without a network call', async () => {
    const db = new Database(':memory:')
    initLinearCacheSchema(db)
    const provider = new LinearProvider(db, 'team-1', 'lin_api_test')

    const err = await expectKanbanError(
      attachmentList(provider, LINEAR_CAPABILITIES, { id: 'ENG-1' }),
      ErrorCode.UNSUPPORTED_OPERATION,
    )
    expect(err.message).toBe('Task attachments are not supported by the linear provider')
    expect(requests).toEqual([])
  })
})

describe('--pretty attachment output', () => {
  const attachment: TaskAttachment = {
    id: 'att-1',
    task_id: 'jira:10001',
    filename: 'spec.md',
    media_type: 'text/markdown',
    byte_size: 17,
    author: 'Jira User',
    created_at: '2026-01-03T00:00:00Z',
  }

  test('lists attachments as attachments, not comments', () => {
    expect(formatOutput(success([attachment]), true)).toBe(
      '  att-1  spec.md  17 bytes  text/markdown @Jira User',
    )
  })

  test('summarizes a written attachment', () => {
    expect(formatOutput(success({ attachment, path: '/tmp/spec.md' }), true)).toBe(
      'Wrote spec.md (17 bytes) to /tmp/spec.md',
    )
    expect(formatOutput(success({ attachment, path: '-' }), true)).toBe(
      'Wrote spec.md (17 bytes) to stdout',
    )
  })
})
