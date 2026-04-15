export function getBasePath() {
  const path = window.location.pathname
  if (path === '/kanban' || path.startsWith('/kanban/')) {
    return '/kanban'
  }
  return ''
}

export function withBasePath(path: string) {
  return `${getBasePath()}${path}`
}
