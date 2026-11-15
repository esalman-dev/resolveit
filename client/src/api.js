// One place for talking to the Express API.
// Every request goes through apiFetch, so the login token is attached automatically.

// In development this is localhost; in production (Vercel) set VITE_API_URL to the Render URL
export const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000'

const TOKEN_KEY = 'resolveit_token'

// The token lives in localStorage so you stay logged in after a page refresh.
// Tradeoff: any script running on the page can read localStorage, so we must never
// render untrusted HTML (React escapes text by default, which protects us).
export const getToken = () => localStorage.getItem(TOKEN_KEY)
export const saveToken = (token) => localStorage.setItem(TOKEN_KEY, token)
export const clearToken = () => localStorage.removeItem(TOKEN_KEY)

// Like fetch(), but: sends/receives JSON, adds "Authorization: Bearer <token>",
// and throws an Error with the server's message when the request fails.
export async function apiFetch(path, { method = 'GET', body } = {}) {
  const headers = {}
  if (body) headers['Content-Type'] = 'application/json'

  const token = getToken()
  if (token) headers.Authorization = `Bearer ${token}`

  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })

  const data = await res.json().catch(() => ({})) // some error responses may not be JSON
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`)
  }
  return data
}
