// App: restores the login when the page opens, then shows the login screen or the app's pages.
//
// Every page has its own address (React Router), so links can be shared, a refresh keeps you on
// the same page, and the browser's Back button works. Pages sit inside AppShell, which draws the
// sidebar and header.

import { useEffect, useState } from 'react'
import { Navigate, Route, Routes, useNavigate } from 'react-router'
import { apiFetch, refreshSession, logout, setOnSessionLost } from './lib/api.js'
import { clearAllDrafts } from './lib/drafts.js'
import AiHelpPage from './pages/AiHelpPage.jsx'
import AskItPage from './pages/AskItPage.jsx'
import AppShell from './components/AppShell.jsx'
import CategoriesPage from './pages/CategoriesPage.jsx'
import SlaTargetsPage from './pages/SlaTargetsPage.jsx'
import NewHireStepsPage from './pages/NewHireStepsPage.jsx'
import NewHirePage from './pages/NewHirePage.jsx'
import ReviewsPage from './pages/ReviewsPage.jsx'
import DashboardPage from './pages/dashboard/DashboardPage.jsx'
import KnowledgeBasePage from './pages/kb/KnowledgeBasePage.jsx'
import ArticlePage from './pages/kb/ArticlePage.jsx'
import EmptyState from './components/EmptyState.jsx'
import GetHelpPage from './pages/GetHelpPage.jsx'
import LoginPage from './pages/LoginPage.jsx'
import TicketPage from './pages/ticket/TicketPage.jsx'
import TicketsPage from './pages/TicketsPage.jsx'
import UsersPage from './pages/UsersPage.jsx'
import { isAdminOrOwner, isStaff } from './lib/roles.js'
import { usePageTitle } from './lib/usePageTitle.js'
import logo from './assets/resolveit-logo.svg' // Vite turns this into the file's URL
import logoDark from './assets/resolveit-logo-dark.svg' // white lettering, for dark mode

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
    clearAllDrafts() // unsent Get help text shouldn't stay on a shared computer
    setUser(null)
    navigate('/') // the next person to log in starts on their own home page
  }

  if (checking) return <p className="login-screen">Loading…</p>

  // Logged out: any address shows the login form. After logging in, the same address opens,
  // so a shared ticket link still works for someone who wasn't logged in yet.
  if (!user) {
    return (
      <main className="login-screen">
        {/* The logo is the page's heading; its alt text gives screen readers the name. */}
        <h1 className="login-screen__logo">
          <img className="logo-light" src={logo} alt="ResolveIT" width="192" height="120" />
          <img className="logo-dark" src={logoDark} alt="ResolveIT" width="192" height="120" />
        </h1>
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
        {/* Logging in at /login (a bookmark, or typed in) would otherwise end on "Page not found". */}
        <Route path="login" element={<Navigate to={home} replace />} />
        <Route path="get-help" element={<GetHelpPage currentUser={user} />} />
        <Route path="ask" element={<AskItPage currentUser={user} />} />
        {/* key: the two lists are separate screens, so switching between them starts fresh. */}
        <Route path="my-tickets" element={<TicketsPage key="mine" scope="mine" currentUser={user} />} />
        <Route
          path="tickets"
          element={isStaff(user.role) ? <TicketsPage key="all" scope="all" currentUser={user} /> : <Navigate to="/my-tickets" replace />}
        />
        <Route path="tickets/new-hire" element={isStaff(user.role) ? <NewHirePage /> : <Navigate to="/" replace />} />
        <Route path="tickets/:id" element={<TicketPage currentUser={user} />} />
        <Route path="ai-help" element={isStaff(user.role) ? <AiHelpPage /> : <Navigate to="/" replace />} />
        <Route path="reviews" element={isStaff(user.role) ? <ReviewsPage currentUser={user} /> : <Navigate to="/" replace />} />
        <Route path="dashboard" element={isStaff(user.role) ? <DashboardPage currentUser={user} /> : <Navigate to="/" replace />} />
        <Route path="kb" element={<KnowledgeBasePage currentUser={user} />} />
        <Route path="kb/:id" element={<ArticlePage currentUser={user} />} />
        <Route path="admin/users" element={admin ? <UsersPage currentUser={user} /> : <Navigate to="/" replace />} />
        <Route path="admin/categories" element={admin ? <CategoriesPage /> : <Navigate to="/" replace />} />
        <Route path="admin/targets" element={admin ? <SlaTargetsPage /> : <Navigate to="/" replace />} />
        <Route path="admin/new-hire-steps" element={admin ? <NewHireStepsPage /> : <Navigate to="/" replace />} />
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
