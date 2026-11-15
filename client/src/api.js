// One place for talking to the Express API.
// Every request goes through apiFetch, so the login token is attached (and renewed) automatically.

// Empty = same site as the page. Requests go to /api/..., which the Vite dev proxy (or Vercel in
// production) forwards to Express. Same site is what lets the refresh cookie work.
const API_URL = import.meta.env.VITE_API_URL || ''

// The ACCESS token (15 min) lives only in this variable, i.e. in memory. Not in localStorage, so
// there's nothing for a malicious script to dig up later, and it disappears when the tab closes.
// Staying logged in is the job of the REFRESH token, an httpOnly cookie JavaScript can't even see.
let accessToken = null
export const setAccessToken = (token) => { accessToken = token }

// Clean up the old version's token, which used to be stored in localStorage
try { localStorage.removeItem('resolveit_token') } catch { /* storage blocked: nothing to clean */ }

// App.jsx registers a function here so we can send the user to the login screen if their session ends
let onSessionLost = () => {}
export const setOnSessionLost = (fn) => { onSessionLost = fn }

// Low-level request: JSON in/out, adds "Authorization: Bearer <token>".
async function request(path, { method = 'GET', body } = {}) {
  const headers = {}
  if (body) headers['Content-Type'] = 'application/json'
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`

  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({})) // some responses (204, errors) have no JSON
  return { res, data }
}

// Ask the server for a new access token using the refresh cookie.
// Returns { user, token } or null if there's no valid session.
let refreshInFlight = null
export function refreshSession() {
  // If several requests notice an expired token at once, they all share ONE refresh
  refreshInFlight ??= withRefreshLock(async () => {
    const { res, data } = await request('/api/auth/refresh', { method: 'POST' })
    if (!res.ok) {
      accessToken = null
      return null
    }
    accessToken = data.token
    return data
  }).finally(() => { refreshInFlight = null })
  return refreshInFlight
}

// Each refresh token works only once (the server swaps it for a new one). If two open tabs
// refreshed at the same moment, the second would send an already-used token, and the server
// would treat that as theft and log everyone out. A Web Lock makes tabs take turns.
function withRefreshLock(fn) {
  return navigator.locks ? navigator.locks.request('resolveit-refresh', fn) : fn()
}

// What components use. Throws an Error with the server's message when a request fails.
// If the access token has expired (401), it refreshes once and retries, so the user never notices.
export async function apiFetch(path, options) {
  let { res, data } = await request(path, options)

  const isAuthRoute = path.startsWith('/api/auth/') && path !== '/api/auth/me'
  if (res.status === 401 && !isAuthRoute) {
    const session = await refreshSession()
    if (!session) {
      onSessionLost()
      throw new Error('Your session has ended, please log in again')
    }
    ;({ res, data } = await request(path, options)) // retry with the new token
  }

  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`)
  }
  return data
}

// Log out: the server revokes the refresh token and deletes the cookie; we forget the access token
export async function logout() {
  await request('/api/auth/logout', { method: 'POST' }).catch(() => {})
  accessToken = null
}
