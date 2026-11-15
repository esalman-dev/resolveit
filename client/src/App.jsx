import { useEffect, useState } from 'react'
import { apiFetch, refreshSession, logout, setOnSessionLost } from './api.js'
import LoginPage from './LoginPage.jsx'

function App() {
  const [user, setUser] = useState(null)         // the logged-in user, or null
  const [checking, setChecking] = useState(true) // true while we ask the server about a saved session
  const [serverStatus, setServerStatus] = useState('checking')

  // Runs once on page load
  useEffect(() => {
    // Is the API (and database) alive?
    apiFetch('/api/health')
      .then((data) => setServerStatus(data.database === 'connected' ? 'online' : 'database offline'))
      .catch(() => setServerStatus('offline'))

    // If the session ends mid-use (e.g. logged out elsewhere), go back to the login screen
    setOnSessionLost(() => setUser(null))

    // "Stay logged in": the browser automatically sends the httpOnly refresh cookie (if it has one).
    // The server checks it and hands back the user plus a fresh 15-minute access token.
    refreshSession()
      .then((session) => setUser(session?.user ?? null))
      .catch(() => setUser(null)) // server offline: show the login form
      .finally(() => setChecking(false))
  }, [])

  async function handleLogout() {
    await logout() // server revokes the refresh token and deletes the cookie
    setUser(null)
  }

  return (
    <main>
      <header className="topbar">
        <h1>ResolveIT</h1>
        {user && (
          <div>
            <span>
              {user.name} <span className="badge">{user.role}</span>
            </span>{' '}
            <button type="button" onClick={handleLogout}>Log out</button>
          </div>
        )}
      </header>

      {checking ? (
        <p>Loading…</p>
      ) : user ? (
        <section className="card">
          <h2>Welcome, {user.name}!</h2>
          <p>You're logged in as a <strong>{user.role}</strong>. Tickets are coming next.</p>
        </section>
      ) : (
        <LoginPage onLoggedIn={setUser} />
      )}

      <footer>API: {serverStatus}</footer>
    </main>
  )
}

export default App
