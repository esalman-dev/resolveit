// Notification bell: the header button with the unread count, and the panel it opens.
//
// The panel lists the newest 30 (see routes/notifications.js on the server). Clicking one marks
// it read and opens its ticket (or, for an outage, the Tickets page or Get help). Escape or a
// click outside closes the panel.

import { useRef, useState } from 'react'
import { Link } from 'react-router'
import { notificationLink, notificationText, useNotifications } from '../lib/notifications.js'
import { useDismiss } from '../lib/useDismiss.js'
import RelativeTime from './RelativeTime.jsx'
import './NotificationBell.css'

/** The bell and its panel, for everyone (users get replies and status changes too). */
function NotificationBell() {
  const { items, unread, refresh, markRead, markAllRead } = useNotifications()
  const [open, setOpen] = useState(false)
  const wrapper = useRef(null)
  const button = useRef(null)

  useDismiss(open, setOpen, wrapper, button) // Escape or a click outside closes the panel

  function toggle() {
    if (!open) refresh() // opening shows the latest, not last minute's
    setOpen((o) => !o)
  }

  const count = unread > 9 ? '9+' : unread
  // The button's name says the number too, so it never relies on the red badge alone.
  const label = unread ? `Notifications, ${unread} unread` : 'Notifications'

  return (
    <div className="bell" ref={wrapper}>
      <button
        ref={button}
        type="button"
        className="bell__button"
        aria-label={label}
        aria-expanded={open}
        aria-controls="bell-panel"
        onClick={toggle}
      >
        <BellIcon />
        {unread > 0 && <span className="bell__count" aria-hidden="true">{count}</span>}
      </button>

      {open && (
        <section id="bell-panel" className="bell__panel" aria-label="Notifications">
          <div className="bell__top">
            <h2 className="bell__heading">Notifications</h2>
            {unread > 0 && (
              <button type="button" className="link" onClick={markAllRead}>Mark all as read</button>
            )}
          </div>
          {items.length === 0 ? (
            <p className="bell__empty">You're all caught up.</p>
          ) : (
            <ul className="bell__list">
              {items.map((n) => (
                <li key={n.id}>
                  <Link
                    to={notificationLink(n)}
                    className={n.read_at ? 'bell__item' : 'bell__item bell__item--unread'}
                    onClick={() => {
                      markRead(n.id)
                      setOpen(false)
                    }}
                  >
                    {!n.read_at && <span className="visually-hidden">Unread: </span>}
                    <span className="bell__text">{notificationText(n)}</span>
                    {n.ticket_title && <span className="bell__title">{n.ticket_title}</span>}
                    <RelativeTime date={n.created_at} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  )
}

/** A plain bell outline, drawn in the text color. */
function BellIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  )
}

export default NotificationBell
