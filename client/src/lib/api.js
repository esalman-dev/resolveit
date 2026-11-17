// API client: the one place the app talks to the Express API.
//
// Every request goes through apiFetch, so the login token is attached, and renewed when it
// expires, automatically.

// Empty means "the same site as the page": requests go to /api/..., which the Vite dev proxy
// (or Vercel in production) forwards to Express. Staying on the same site is what lets the
// refresh cookie work.
const API_URL = import.meta.env.VITE_API_URL || ''

// Security: the access token (15 minutes) lives only in this variable, in memory. Not in
// localStorage, so there's nothing for a malicious script to dig up later, and it's gone when
// the tab closes. Staying logged in is the refresh token's job: an httpOnly cookie that
// JavaScript can't read at all.
let accessToken = null

/** Stores the access token in memory (after login, Google sign-in, or a refresh). */
export const setAccessToken = (token) => { accessToken = token }

// Clean up the token an older version of the app kept in localStorage.
try { localStorage.removeItem('resolveit_token') } catch { /* storage blocked: nothing to clean */ }

let onSessionLost = () => {}

/** Registers what to do when the session ends mid-use. App.jsx uses it to show the login screen. */
export const setOnSessionLost = (fn) => { onSessionLost = fn }

/**
 * Low-level request: adds "Authorization: Bearer <token>", sends JSON (or a FormData file
 * upload as is), and reads JSON back, or a file (Blob) when `as` is 'blob'.
 */
async function request(path, { method = 'GET', body, as } = {}) {
  const isForm = body instanceof FormData
  const headers = {}
  // Note: a FormData upload must not set Content-Type; the browser adds it, with the boundary
  // that separates the parts.
  if (body && !isForm) headers['Content-Type'] = 'application/json'
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`

  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body && !isForm ? JSON.stringify(body) : body,
  })
  if (as === 'blob' && res.ok) return { res, data: await res.blob() }
  const data = await res.json().catch(() => ({})) // some responses (204, some errors) have no JSON
  return { res, data }
}

let refreshInFlight = null

/**
 * Asks the server for a new access token using the refresh cookie.
 * Returns { user, token }, or null if there's no valid session.
 *
 * If several requests notice an expired token at once, they all share one refresh.
 */
export function refreshSession() {
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

/**
 * Runs fn while holding a lock shared by every open tab.
 *
 * Why: each refresh token works only once. If two tabs refreshed at the same moment, the
 * second would send an already-used token, the server would treat that as theft, and log
 * everyone out. A Web Lock makes the tabs take turns.
 */
function withRefreshLock(fn) {
  return navigator.locks ? navigator.locks.request('resolveit-refresh', fn) : fn()
}

/**
 * Calls the API and returns the response data. This is what components use.
 * Options: { method, body (an object, or FormData for a file), as: 'blob' to get a file back }.
 * Throws an Error with the server's message (and its HTTP status as `err.status`) when a request fails.
 *
 * If the access token has expired (401), it refreshes once and retries, so the user never
 * notices. If the refresh fails too, the session is over and onSessionLost runs.
 */
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
    throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status })
  }
  return data
}

/** Logs out: the server revokes the refresh token and deletes the cookie; we forget the access token. */
export async function logout() {
  await request('/api/auth/logout', { method: 'POST' }).catch(() => {})
  accessToken = null
}
