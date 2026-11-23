// App shell: the frame around every page after login, with the sidebar on the left and the
// header (page title, the bell, and the account menu with Theme and Log out) on top.
//
// On screens narrower than 768px the sidebar's links fold away behind a ☰ menu button.
// The sidebar's foot shows how many staff are online; staff also set their own status in the
// header (see lib/presence.js). The header's bell shows notifications (NotificationBell.jsx), and
// a confirmed outage shows as a banner under the header (OutageBanner.jsx).

import { useState } from 'react'
import { Link, NavLink, Outlet, useNavigate } from 'react-router'
import { isAdminOrOwner, isStaff } from '../lib/roles.js'
import { Shortcuts } from '../lib/shortcuts.js'
import ShortcutsHelp from './ShortcutsHelp.jsx'
import { STATUS_LABELS, usePresence } from '../lib/presence.js'
import StatusDot from './StatusDot.jsx'
import NotificationBell from './NotificationBell.jsx'
import OutageBanner from './OutageBanner.jsx'
import AccountMenu from './AccountMenu.jsx'
import { useOutages } from '../lib/outages.js'
import logo from '../assets/resolveit-logo-horizontal.svg' // Vite turns this into the file's URL
import logoDark from '../assets/resolveit-logo-horizontal-dark.svg' // white lettering
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
  const [helpOpen, setHelpOpen] = useState(false) // the Keyboard shortcuts panel (staff)
  const navigate = useNavigate()

  const staff = isStaff(user.role)
  const admin = isAdminOrOwner(user.role) // owners get everything admins get
  const presence = usePresence(staff)
  const outages = useOutages()

  return (
    <div className="app-shell">
      <aside className={menuOpen ? 'app-shell__sidebar app-shell__sidebar--open' : 'app-shell__sidebar'}>
        <div className="app-shell__brand">
          {/* Two colorings of the logo; CSS shows the one for the current theme (index.css).
              The hidden one is skipped by screen readers too, so the link has one name.
              It leads to the home page ("/"); the page's button comes back into the app. */}
          <Link className="app-shell__brand-name" to="/">
            <img className="logo-light" src={logo} alt="ResolveIT" width="166" height="36" />
            <img className="logo-dark" src={logoDark} alt="ResolveIT" width="166" height="36" />
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
          <NavLink className="app-shell__link" to="/kb">Knowledge base</NavLink>
          <NavLink className="app-shell__link" to="/my-tickets">My tickets</NavLink>
          {staff && (
            <>
              <p className="app-shell__heading">Staff</p>
              <NavLink className="app-shell__link" to="/dashboard">Dashboard</NavLink>
              <NavLink className="app-shell__link" to="/tickets">Tickets</NavLink>
              <NavLink className="app-shell__link" to="/ai-help">AI help</NavLink>
              <NavLink className="app-shell__link" to="/reviews">Reviews</NavLink>
            </>
          )}
          {admin && (
            <>
              <p className="app-shell__heading">Admin</p>
              <NavLink className="app-shell__link" to="/admin/users">Users</NavLink>
              <NavLink className="app-shell__link" to="/admin/categories">Categories</NavLink>
              <NavLink className="app-shell__link" to="/admin/targets">Target times</NavLink>
              <NavLink className="app-shell__link" to="/admin/new-hire-steps">New-hire steps</NavLink>
            </>
          )}
        </nav>

        {presence.online !== null && (
          <p className="app-shell__online" aria-live="polite">
            {/* Decoration only: the sentence beside it already says it. */}
            <span className={`status-dot status-dot--${presence.online > 0 ? 'available' : 'offline'}`} aria-hidden="true" />
            {presence.online === 0
              ? 'No technicians online right now'
              : `${presence.online} ${presence.online === 1 ? 'technician' : 'technicians'} online`}
          </p>
        )}
      </aside>

      <div className="app-shell__content">
        {/* The header's background spans the full width; its contents line up with the page's
            centered column below. */}
        <header className="app-shell__header">
          <div className="app-shell__column app-shell__header-row">
            <h1 className="app-shell__title">{title}</h1>
            <div className="app-shell__account">
              <NotificationBell />
              {staff && presence.me && (
                // Your status: the dot shows what others see (e.g. Away after 15 idle minutes);
                // the menu is your own choice.
                <label className="app-shell__status">
                  <StatusDot status={presence.me.status} />
                  <span className="visually-hidden">Your status</span>
                  <select
                    value={presence.me.availability}
                    onChange={(e) => presence.setAvailability(e.target.value).catch(() => {})}
                    title={`Others see you as ${STATUS_LABELS[presence.me.status]}`}
                  >
                    <option value="available">Available</option>
                    <option value="busy">Busy</option>
                    <option value="away">Away</option>
                  </select>
                </label>
              )}
              <AccountMenu user={user} onLogout={onLogout} />
            </div>
          </div>
        </header>
        <OutageBanner outages={outages.list} />

        <main className="app-shell__column app-shell__main">
          {/* Pages get the title setter, who's online (Get help shows the team) and the open
              outages (Get help, the staff Tickets page and the ticket page use them). */}
          <Outlet context={{ setTitle, presence, outages }} />
        </main>

        <footer className="app-shell__column app-shell__footer">
          <span>API: {serverStatus}</span>
          {staff && (
            <button type="button" className="link app-shell__shortcuts" onClick={() => setHelpOpen(true)}>
              Keyboard shortcuts (?)
            </button>
          )}
        </footer>
      </div>

      {staff && (
        <>
          {/* The app-wide shortcuts; each page adds its own (lib/shortcuts.js). */}
          <Shortcuts
            keys={{
              '?': () => setHelpOpen(true),
              'g t': () => navigate('/tickets'),
              'g d': () => navigate('/dashboard'),
              'g k': () => navigate('/kb'),
            }}
          />
          <ShortcutsHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
        </>
      )}
    </div>
  )
}

export default AppShell
