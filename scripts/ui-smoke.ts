#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Database } from 'bun:sqlite'
import { chromium, type Browser, type Page } from 'playwright-core'
import { getTask, initSchema, listTasks, seedDefaultColumns, updateTask } from '../src/db'
import { LocalProvider } from '../src/providers/local'
import { startServer } from '../src/server'
import type { Task } from '../src/types'
import { seedFixtures } from './fixtures'

const screenshotsArg = process.argv.slice(2).find((arg) => arg.startsWith('--screenshots='))
assert(
  process.argv.slice(2).every((arg) => arg.startsWith('--screenshots=')),
  'Usage: bun run test:ui [--screenshots=directory]',
)
const executablePath =
  process.env.CHROME_PATH ??
  Bun.which('google-chrome') ??
  Bun.which('chromium') ??
  Bun.which('chromium-browser') ??
  (existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : undefined)
assert(executablePath, 'Chrome or Chromium is required. Set CHROME_PATH to its executable.')
assert(
  existsSync(join(import.meta.dir, '../ui/dist/index.html')),
  'Build the dashboard first: bun run ui:build',
)

const screenshots = screenshotsArg
  ? resolve(screenshotsArg.slice('--screenshots='.length))
  : mkdtempSync(join(tmpdir(), 'kanban-ui-proof-'))
mkdirSync(screenshots, { recursive: true })
const fixtureDir = mkdtempSync(join(tmpdir(), 'kanban-ui-smoke-'))
const dbPath = join(fixtureDir, 'board.db')
const db = new Database(dbPath)
db.run('PRAGMA foreign_keys = ON')
initSchema(db)
seedDefaultColumns(db)
const { taskCount } = seedFixtures(db)
const authToken = 'hermetic-browser-smoke'
const server = startServer(new LocalProvider(db, dbPath), 0, { authToken })
const origin = `http://127.0.0.1:${server.port}`
let browser: Browser | undefined

async function checkLayout(page: Page): Promise<void> {
  const dimensions = {
    viewport: page.viewportSize()!.width,
    content: await page.locator('html').evaluate((element) => element.scrollWidth),
  }
  assert(
    dimensions.content <= dimensions.viewport,
    `Horizontal viewport overflow: ${dimensions.content}px content in ${dimensions.viewport}px`,
  )
}

async function checkTaskCount(page: Page, count: number): Promise<void> {
  const cards = page.locator('.taskCard')
  await cards.nth(count).waitFor({ state: 'hidden' })
  if (count > 0) await cards.nth(count - 1).waitFor()
  assert.equal(await cards.count(), count)
}

try {
  browser = await chromium.launch({ executablePath, headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const externalRequests: string[] = []
  // Keep the proof independent of font CDNs and all non-fixture services.
  await context.route('**/*', async (route) => {
    if (new URL(route.request().url()).origin === origin) {
      await route.continue()
    } else {
      externalRequests.push(route.request().url())
      await route.abort()
    }
  })
  const page = await context.newPage()
  page.setDefaultTimeout(10_000)
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  const requests: string[] = []
  page.on('request', (request) => requests.push(new URL(request.url()).pathname))
  const [socket] = await Promise.all([
    page.waitForEvent('websocket'),
    page.goto(`${origin}/kanban/#token=${authToken}`),
  ])
  await page.getByRole('button', { name: /Add search functionality/ }).waitFor()
  await page.getByText('Live', { exact: true }).waitFor()
  assert.equal(new URL(socket.url()).pathname, '/kanban/ws')
  assert.equal(new URL(socket.url()).searchParams.get('token'), authToken)
  assert.equal(page.url(), `${origin}/kanban/`, 'Token is removed from the address bar')
  await checkTaskCount(page, taskCount)
  await checkLayout(page)
  await page.screenshot({ path: join(screenshots, 'board-desktop.png'), fullPage: true })
  const initialLoad = {
    requests: [...requests],
    domElements: await page.locator('*').count(),
    externalRequests: [...externalRequests],
  }

  await page.setViewportSize({ width: 390, height: 844 })
  await checkLayout(page)
  await page.screenshot({ path: join(screenshots, 'board-mobile.png'), fullPage: true })
  const backlog = page.getByRole('region', { name: 'backlog column', exact: true })
  const collapse = backlog.getByRole('button', { name: /^backlog/ })
  await collapse.click()
  await backlog
    .getByRole('button', { name: /Add search functionality/ })
    .waitFor({ state: 'hidden' })
  assert.equal(await collapse.getAttribute('aria-expanded'), 'false')
  await collapse.click()
  const mobileTask = backlog.getByRole('button', { name: /Add search functionality/ })
  await mobileTask.click()
  await page.getByRole('dialog', { name: 'Add search functionality', exact: true }).waitFor()
  await checkLayout(page)
  await page.keyboard.press('Escape')
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  assert(await mobileTask.evaluate((element) => element.matches(':focus')))
  await page.setViewportSize({ width: 320, height: 740 })
  await checkLayout(page)
  await page.setViewportSize({ width: 1440, height: 1000 })

  const search = page.getByRole('searchbox', { name: 'Search tasks' })
  await search.fill('Full-text')
  await page.getByRole('button', { name: /Write API docs/ }).waitFor({ state: 'hidden' })
  await checkTaskCount(page, 1)
  await search.fill('no-matching-fixture')
  await checkTaskCount(page, 0)
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click()
  await page.getByLabel('Filter by assignee').selectOption('BuildBot')
  await checkTaskCount(page, 4)
  await page.getByLabel('Filter by project').selectOption('Platform')
  await checkTaskCount(page, 2)
  await page.getByLabel('Filter by activity').selectOption('1')
  await checkTaskCount(page, 2)
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click()
  await checkTaskCount(page, taskCount)

  const newTask = page.getByRole('button', { name: '+ New task', exact: true })
  await newTask.click()
  let dialog = page.getByRole('dialog', { name: 'New task', exact: true })
  await dialog.waitFor()
  assert(
    await dialog
      .getByLabel('Title', { exact: true })
      .evaluate((element) => element.matches(':focus')),
  )
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })
  assert(await newTask.evaluate((element) => element.matches(':focus')))

  await newTask.click()
  await dialog.getByLabel('Title', { exact: true }).fill('Browser smoke task')
  await dialog.getByRole('button', { name: 'Create task', exact: true }).focus()
  // Native dialogs may visit browser chrome at the boundary; background page
  // controls must stay inert and the next Tab must return to the dialog.
  for (let press = 0; press < 2; press++) {
    await page.keyboard.press('Tab')
    assert(
      await page
        .locator(':focus')
        .evaluateAll((elements) => elements.every((element) => element.closest('dialog[open]'))),
      'Tab never focuses the background page',
    )
  }
  await dialog.locator(':focus').waitFor()
  await dialog.getByLabel('Description', { exact: true }).fill('Created through the dashboard')
  await dialog.getByLabel('Column', { exact: true }).selectOption('in-progress')
  await dialog.getByLabel('Priority', { exact: true }).selectOption('high')
  await dialog.getByLabel('Assignee', { exact: true }).selectOption('Alex')
  await dialog.getByLabel('Project', { exact: true }).selectOption('Platform')
  await dialog.getByLabel('Labels', { exact: true }).fill('smoke, browser')
  const [createdResponse] = await Promise.all([
    page.waitForResponse(
      (response) => response.url().endsWith('/api/tasks') && response.request().method() === 'POST',
    ),
    dialog.getByRole('button', { name: 'Create task', exact: true }).click(),
  ])
  assert(createdResponse.ok())
  const createdBody: { data: Task } = await createdResponse.json()
  const created = createdBody.data
  await dialog.waitFor({ state: 'hidden' })
  assert.equal(
    await page.locator('.boardSummary strong').first().innerText(),
    String(taskCount + 1),
    'Board-wide task count updates immediately after create',
  )
  assert.equal(getTask(db, created.id).column_name, 'in-progress')
  assert.deepEqual(getTask(db, created.id).labels, ['smoke', 'browser'])
  assert.equal(getTask(db, created.id).assignee, 'Alex')

  await page.getByRole('button', { name: /Browser smoke task/ }).click()
  dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: 'Edit title', exact: true }).click()
  await dialog.getByRole('textbox').fill('Browser smoke edited')
  const [updatedResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/tasks/${created.id}`) &&
        response.request().method() === 'PATCH',
    ),
    dialog.getByRole('button', { name: 'Save', exact: true }).click(),
  ])
  assert(updatedResponse.ok())
  await page.getByRole('dialog', { name: 'Browser smoke edited', exact: true }).waitFor()
  assert.equal(getTask(db, created.id).title, 'Browser smoke edited')

  // Change storage without broadcasting to reproduce a real stale-version conflict.
  await dialog.getByRole('button', { name: 'Edit description', exact: true }).click()
  await dialog.getByRole('textbox').fill('My description survives a failed conflict retry')
  updateTask(db, created.id, { description: 'A concurrent edit' })
  let failConflictRetry = true
  const taskRoute = `**/api/tasks/${created.id}`
  await page.route(taskRoute, async (route) => {
    const request = route.request()
    const data: { expectedVersion?: string } | null =
      request.method() === 'PATCH' ? request.postDataJSON() : null
    if (data && !data.expectedVersion && failConflictRetry) {
      failConflictRetry = false
      await route.fulfill({
        status: 503,
        json: { ok: false, error: { code: 'UNAVAILABLE', message: 'Temporary smoke failure' } },
      })
    } else {
      await route.continue()
    }
  })
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  const conflict = page.getByRole('dialog', { name: 'Conflicting update', exact: true })
  await conflict.waitFor()
  await conflict.getByRole('button', { name: 'Keep my changes', exact: true }).click()
  await conflict.getByRole('alert').filter({ hasText: 'Temporary smoke failure' }).waitFor()
  assert.equal(getTask(db, created.id).description, 'A concurrent edit')
  await conflict.getByRole('button', { name: 'Keep my changes', exact: true }).click()
  await conflict.waitFor({ state: 'hidden' })
  assert.equal(
    getTask(db, created.id).description,
    'My description survives a failed conflict retry',
  )
  await page.unroute(taskRoute)
  dialog = page.getByRole('dialog', { name: 'Browser smoke edited', exact: true })
  const [movedResponse] = await Promise.all([
    page.waitForResponse((response) => response.url().endsWith(`/api/tasks/${created.id}/move`)),
    dialog.getByLabel('Move task to column').selectOption('review'),
  ])
  assert(movedResponse.ok())
  assert.equal(getTask(db, created.id).column_name, 'review')
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click()
  assert.equal(
    getTask(db, created.id).title,
    'Browser smoke edited',
    'Delete requires confirmation',
  )
  await page.route(
    taskRoute,
    (route) =>
      route.fulfill({
        status: 503,
        json: { ok: false, error: { code: 'UNAVAILABLE', message: 'Temporary delete failure' } },
      }),
    { times: 1 },
  )
  await dialog.getByRole('button', { name: 'Confirm delete', exact: true }).click()
  await dialog.getByRole('alert').filter({ hasText: 'Temporary delete failure' }).waitFor()
  assert.equal(
    getTask(db, created.id).title,
    'Browser smoke edited',
    'Failed deletion preserves the task',
  )
  await dialog.waitFor()
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click()
  const [deletedResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/tasks/${created.id}`) &&
        response.request().method() === 'DELETE',
    ),
    dialog.getByRole('button', { name: 'Confirm delete', exact: true }).click(),
  ])
  assert(deletedResponse.ok())
  await dialog.waitFor({ state: 'hidden' })
  assert.equal(listTasks(db).length, taskCount)
  assert.equal(
    await page.locator('.boardSummary strong').first().innerText(),
    String(taskCount),
    'Board-wide task count updates immediately after delete',
  )

  // Block polling after initial coverage so only the live event can reveal this task.
  await page.route('**/api/bootstrap', (route) => route.abort())
  const liveFrame = socket.waitForEvent('framereceived', {
    predicate: ({ payload }) => String(payload).includes('WebSocket smoke task'),
  })
  const liveResponse = await fetch(`${origin}/kanban/api/tasks`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'WebSocket smoke task' }),
  })
  assert(liveResponse.ok)
  await liveFrame
  await page.getByRole('button', { name: /WebSocket smoke task/ }).waitFor()
  assert.equal(
    await page.locator('.boardSummary strong').first().innerText(),
    String(taskCount + 1),
    'Board-wide task count updates immediately after a WebSocket create',
  )
  await checkLayout(page)
  assert.deepEqual(pageErrors, [], 'No browser runtime errors')
  assert.deepEqual(externalRequests, [], 'Dashboard loads without external requests')
  console.info(
    JSON.stringify(
      {
        smoke: 'ok',
        checks: [
          'desktop/mobile layout',
          'search and combined filters',
          'create/edit/move/delete persisted in SQLite',
          'live board metrics after local and WebSocket mutations',
          'dialog Escape, Tab containment and focus restoration',
          'real version conflict and failed retry recovery',
          'failed delete feedback and retry',
          'WebSocket update without polling',
          'authenticated /kanban/ hosting',
        ],
        initialLoad,
        screenshots,
      },
      null,
      2,
    ),
  )
} finally {
  try {
    await browser?.close()
  } finally {
    server.stop()
    db.close()
    rmSync(fixtureDir, { recursive: true, force: true })
  }
}
