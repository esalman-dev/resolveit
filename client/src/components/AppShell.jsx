// App shell: the frame around every page after login, with the sidebar on the left and the
// header (page title, who is logged in, Log out) on top.
//
// On screens narrower than 768px the sidebar's links fold away behind a ☰ menu button.

import { useState } from 'react'
import { Link, NavLink, Outlet } from 'react-router'
import { isAdminOrOwner, isStaff } from '../lib/roles.js'
import logo from '../assets/resolveit-logo-horizontal.png' // Vite turns this into the file's URL
import './AppShell.css'

/**
 * Draws the sidebar and header, then the current page where <Outlet /> sits.
 *
 * Note: hiding a sidebar link only keeps the sidebar tidy. The server checks every request.
 *
 * @param serverStatus the API health shown in the footer, e.g. "online"
 */
function AppShell({ user, serverStatus, onLogout }) {
  const [title, setTitle] = useState('') // set by each page through usePageTitle
  const [menuOpen, setMenuOpen] = useState(false) // phones only: is the link list showing?

  const staff = isStaff(user.role)
  const admin = isAdminOrOwner(user.role) // owners get everything admins get

  return (
    <div className="app-shell">
      <aside className={menuOpen ? 'app-shell__sidebar app-shell__sidebar--open' : 'app-shell__sidebar'}>
        <div className="app-shell__brand">
          {/* The image is 1200 × 270, shown at 160 × 36, so it stays sharp on high-resolution
              screens. Its alt text is the link's name for screen readers. */}
          <Link className="app-shell__brand-name" to="/">
            <img src={logo} alt="ResolveIT" width="160" height="36" />
          </Link>
          <button
            type="button"
            className="app-shell__menu-button"
            aria-label="Menu"
            aria-expanded={menuOpen}
            aria-controls="app-shell-nav"
            onClick={() => setMenuOpen((open) => !open)}
          >
            ☰
          </button>
        </div>

        {/* Clicking any link closes the phone menu. NavLink marks the current page with
            aria-current="page", which the CSS uses to highlight it. */}
        <nav id="app-shell-nav" className="app-shell__nav" aria-label="Main" onClick={() => setMenuOpen(false)}>
          {/* Grouped by who it's for, so everyone can tell the parts apart. */}
          <p className="app-shell__heading">Help</p>
          <NavLink className="app-shell__link" to="/get-help">Get help</NavLink>
          <NavLink className="app-shell__link" to="/ask">Ask IT</NavLink>
          <NavLink className="app-shell__link" to="/my-tickets">My tickets</NavLink>
          {staff && (
            <>
              <p className="app-shell__heading">Staff</p>
              <NavLink className="app-shell__link" to="/tickets">Tickets</NavLink>
              <NavLink className="app-shell__link" to="/ai-help">AI help</NavLink>
            </>
          )}
          {admin && (
            <>
              <p className="app-shell__heading">Admin</p>
              <NavLink className="app-shell__link" to="/admin/users">Users</NavLink>
              <NavLink className="app-shell__link" to="/admin/categories">Categories</NavLink>
              <NavLink className="app-shell__link" to="/admin/targets">Target times</NavLink>
            </>
          )}
        </nav>
      </aside>

      <div className="app-shell__content">
        {/* The header's background spans the full width; its contents line up with the page's
            centered column below. */}
        <header className="app-shell__header">
          <div className="app-shell__column app-shell__header-row">
            <h1 className="app-shell__title">{title}</h1>
            <div className="app-shell__account">
              <span>
                {user.name} <span className="app-shell__role">({user.role})</span>
              </span>
              <button type="button" onClick={onLogout}>Log out</button>
            </div>
          </div>
        </header>

        <main className="app-shell__column app-shell__main">
          <Outlet context={{ setTitle }} />
        </main>

        <footer className="app-shell__column app-shell__footer">API: {serverStatus}</footer>
      </div>
    </div>
  )
}

export default AppShell
