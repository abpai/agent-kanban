/**
 * Combined dev server — launches both the API backend and the Vite UI dev server.
 * Usage: bun scripts/dev.ts
 */

const api = Bun.spawn(['bun', 'run', 'serve'], {
  cwd: import.meta.dir + '/..',
  stdout: 'inherit',
  stderr: 'inherit',
})

const ui = Bun.spawn(['bun', 'run', 'ui:dev'], {
  cwd: import.meta.dir + '/..',
  stdout: 'inherit',
  stderr: 'inherit',
})

let shuttingDown = false

function stopChildren() {
  if (shuttingDown) return
  shuttingDown = true

  try {
    api.kill()
  } catch {
    void 0
  }

  try {
    ui.kill()
  } catch {
    void 0
  }
}

function cleanup(exitCode = 0) {
  stopChildren()
  process.exit(exitCode)
}

process.on('SIGINT', () => cleanup(130))
process.on('SIGTERM', () => cleanup(143))

// Keep the script alive and exit when either child exits
const result = await Promise.race([
  api.exited.then((exitCode) => ({ exitCode })),
  ui.exited.then((exitCode) => ({ exitCode })),
])
cleanup(result.exitCode)
