// App: restores the login when the page opens, then shows the login screen or the app's pages.
//
// Every page has its own address (React Router), so links can be shared, a refresh keeps you on
// the same page, and the browser's Back button works. Pages sit inside AppShell, which draws the
// sidebar and header.

import { useEffect, useState } from 'react'
import { Navigate, Route, Routes, useNavigate } from 'react-router'
import { apiFetch, refreshSession, logout, setOnSessionLost } from './api.js'
import AppShell from './AppShell.jsx'
import CategoriesPage from './CategoriesPage.jsx'
import EmptyState from './EmptyState.jsx'
import GetHelpPage from './GetHelpPage.jsx'
import LoginPage from './LoginPage.jsx'
import TicketPage from './TicketPage.jsx'
import TicketsPage from './TicketsPage.jsx'
import UsersPage from './UsersPage.jsx'
import { isAdminOrOwner, isStaff } from './roles.js'
import { usePageTitle } from './usePageTitle.js'

/** The whole app: the login screen, or the pages inside the app shell. */
function App() {
  const [user, setUser] = useState(null) // the logged-in user, or null
  const [checking, setChecking] = useState(true) // true while we ask the server about a saved session
  const [serverStatus, setServerStatus] = useState('checking')
  const navigate = useNavigate()

  // Runs once, when the page opens.
  useEffect(() => {
    // Is the API (and its database) up?
    apiFetch('/api/health')
      .then((data) => setServerStatus(data.database === 'connected' ? 'online' : 'database offline'))
      .catch(() => setServerStatus('offline'))

    // If the session ends mid-use (e.g. logged out in another tab), go back to the login screen.
    // The address stays the same, so logging in again returns to the same page.
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
    navigate('/') // the next person to log in starts on their own home page
  }

  if (checking) return <p className="login-screen">Loading…</p>

  // Logged out: any address shows the login form. After logging in, the same address opens,
  // so a shared ticket link still works for someone who wasn't logged in yet.
  if (!user) {
    return (
      <main className="login-screen">
        <h1>ResolveIT</h1>
        <LoginPage onLoggedIn={setUser} />
        <footer>API: {serverStatus}</footer>
      </main>
    )
  }

  // Note: blocking admin pages here only keeps the interface tidy. The server checks every request.
  const admin = isAdminOrOwner(user.role)
  const home = isStaff(user.role) ? '/tickets' : '/get-help'

  return (
    <Routes>
      <Route element={<AppShell user={user} serverStatus={serverStatus} onLogout={handleLogout} />}>
        <Route index element={<Navigate to={home} replace />} />
        <Route path="get-help" element={<GetHelpPage />} />
        <Route path="tickets" element={<TicketsPage currentUser={user} />} />
        <Route path="tickets/:id" element={<TicketPage currentUser={user} />} />
        <Route path="admin/users" element={admin ? <UsersPage currentUser={user} /> : <Navigate to="/" replace />} />
        <Route path="admin/categories" element={admin ? <CategoriesPage /> : <Navigate to="/" replace />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  )
}

// --- Not found ---

/** Any address that doesn't match a page. */
function NotFoundPage() {
  usePageTitle('Page not found')
  return <EmptyState message="That page doesn't exist." actionLabel="Go to your home page" actionTo="/" />
}

export default App
