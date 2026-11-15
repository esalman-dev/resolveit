import { useEffect, useState } from 'react'
import { apiFetch, getToken, clearToken } from './api.js'
import LoginPage from './LoginPage.jsx'

function App() {
  const [user, setUser] = useState(null)       // the logged-in user, or null
  // True while we check a saved token on page load. If there's no token, there's nothing to check.
  // (Passing a function means it only runs on the first render.)
  const [checking, setChecking] = useState(() => Boolean(getToken()))
  const [serverStatus, setServerStatus] = useState('checking')

  // Runs once on page load
  useEffect(() => {
    // Is the API (and database) alive?
    apiFetch('/api/health')
      .then((data) => setServerStatus(data.database === 'connected' ? 'online' : 'database offline'))
      .catch(() => setServerStatus('offline'))

    // If a token was saved earlier, ask the server who it belongs to.
    // The server re-checks the signature and expiry, so an old or fake token gets rejected.
    if (!getToken()) return
    apiFetch('/api/auth/me')
      .then((data) => setUser(data.user))
      .catch(() => clearToken()) // expired or invalid: forget it and show the login form
      .finally(() => setChecking(false))
  }, [])

  function logout() {
    // With JWTs, "logging out" means the browser throws its token away
    clearToken()
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
            <button type="button" onClick={logout}>Log out</button>
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
