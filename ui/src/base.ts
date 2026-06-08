function getBasePath() {
  const path = window.location.pathname
  if (path === '/kanban' || path.startsWith('/kanban/')) {
    return '/kanban'
  }
  return ''
}

export function withBasePath(path: string) {
  return `${getBasePath()}${path}`
}

const TOKEN_STORAGE_KEY = 'kanban_api_token'

// When the API requires a token (e.g. behind `kanban serve --tunnel`), accept it
// once via `?token=` or `#token=` and persist it, so the static UI can keep
// authenticating without it lingering in the address bar.
function captureTokenFromUrl(): string | null {
  const fromQuery = new URLSearchParams(window.location.search).get('token')
  const fromHash = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('token')
  const token = fromQuery ?? fromHash
  if (token) {
    try {
      window.localStorage.setItem(TOKEN_STORAGE_KEY, token)
    } catch {
      // localStorage may be unavailable (private mode); fall through.
    }
    const url = new URL(window.location.href)
    url.searchParams.delete('token')
    if (url.hash) {
      const hashParams = new URLSearchParams(url.hash.replace(/^#/, ''))
      hashParams.delete('token')
      const rest = hashParams.toString()
      url.hash = rest ? `#${rest}` : ''
    }
    window.history.replaceState({}, '', url.toString())
  }
  return token
}

let cachedToken: string | null | undefined

export function getApiToken(): string | null {
  if (cachedToken !== undefined) return cachedToken
  const captured = captureTokenFromUrl()
  if (captured) {
    cachedToken = captured
    return captured
  }
  try {
    cachedToken = window.localStorage.getItem(TOKEN_STORAGE_KEY)
  } catch {
    cachedToken = null
  }
  return cachedToken
}

export function authHeaders(): Record<string, string> {
  const token = getApiToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

export function withTokenParam(url: string): string {
  const token = getApiToken()
  if (!token) return url
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`
}
