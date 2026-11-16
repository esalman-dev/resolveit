// App: restores the login when the page opens, then picks which screen to show.

import { useEffect, useState } from 'react'
import { apiFetch, refreshSession, logout, setOnSessionLost } from './api.js'
import LoginPage from './LoginPage.jsx'
import UsersPage from './UsersPage.jsx'
import { isAdminOrOwner } from './roles.js'

/** The whole app: top bar, admin tabs, the current screen, and the API status footer. */
function App() {
  const [user, setUser] = useState(null) // the logged-in user, or null
  const [checking, setChecking] = useState(true) // true while we ask the server about a saved session
  const [serverStatus, setServerStatus] = useState('checking')
  const [page, setPage] = useState('home') // 'home' or 'users' (replaced by React Router next)

  // Runs once, when the page opens.
  useEffect(() => {
    // Is the API (and its database) up?
    apiFetch('/api/health')
      .then((data) => setServerStatus(data.database === 'connected' ? 'online' : 'database offline'))
      .catch(() => setServerStatus('offline'))

    // If the session ends mid-use (e.g. logged out in another tab), go back to the login screen.
    setOnSessionLost(() => setUser(null))

    // Staying logged in: the browser sends the httpOnly refresh cookie automatically, if it has
    // one, and the server answers with the user and a fresh 15-minute access token.
    refreshSession()
      .then((session) => setUser(session?.user ?? null))
      .catch(() => setUser(null)) // server offline: show the login form
      .finally(() => setChecking(false))
  }, [])

  async function handleLogout() {
    await logout() // the server revokes the refresh token and deletes the cookie
    setUser(null)
    setPage('home')
  }

  // Note: hiding admin screens is only for tidiness. The server checks every request.
  const isAdmin = isAdminOrOwner(user?.role) // owners get everything admins get

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

      {isAdmin && (
        <nav className="tabs">
          <button type="button" className={page === 'home' ? 'active' : ''} onClick={() => setPage('home')}>
            Home
          </button>
          <button type="button" className={page === 'users' ? 'active' : ''} onClick={() => setPage('users')}>
            Manage users
          </button>
        </nav>
      )}

      {checking ? (
        <p>Loading…</p>
      ) : isAdmin && page === 'users' ? (
        <UsersPage currentUser={user} />
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
