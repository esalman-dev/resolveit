// Ticket page: one ticket's details, at /tickets/:id.
//
// Two columns: the ticket and its activity on the left, and a panel of facts (status,
// priority, category, assignee, dates) on the right. On phones the panel sits between the
// description and the activity.
//
// For now it's read-only. Staff controls and comments come next.

import { useEffect, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router'
import { apiFetch } from './api.js'
import { PriorityBadge, StatusBadge } from './Badges.jsx'
import { priorityLabel, statusLabel } from './ticketLabels.js'
import EmptyState from './EmptyState.jsx'
import RelativeTime from './RelativeTime.jsx'
import { usePageTitle } from './usePageTitle.js'
import './TicketPage.css'

/** Shows one ticket, plus a "Ticket created" message when arriving from the Get help form. */
function TicketPage() {
  const { id } = useParams() // the 12 in /tickets/12
  const location = useLocation()
  const navigate = useNavigate()
  const [ticket, setTicket] = useState(null)
  const [history, setHistory] = useState([])
  const [error, setError] = useState('')
  // Read once: the Get help form sends { created: true } along with the address.
  const [justCreated] = useState(Boolean(location.state?.created))

  usePageTitle(ticket ? `#${ticket.id} ${ticket.title}` : 'Ticket')

  // Why: the browser keeps that state through a refresh, which would show "Ticket created"
  // again. Replacing it with nothing means the message shows only the first time.
  useEffect(() => {
    if (location.state?.created) navigate(location.pathname, { replace: true, state: null })
  }, [location, navigate])

  useEffect(() => {
    apiFetch(`/api/tickets/${id}`)
      .then((data) => {
        setTicket(data.ticket)
        setHistory(data.history)
      })
      .catch((err) => setError(err.message))
  }, [id])

  // Security: someone else's ticket answers 404, the same as one that doesn't exist, so
  // nobody can find out which ticket numbers are in use.
  if (error) return <EmptyState message={error} actionLabel="Back to tickets" actionTo="/tickets" />
  if (!ticket) return <p className="hint">Loading ticket…</p>

  return (
    <div className="ticket-page">
      {justCreated && (
        <p className="ticket-page__created" role="status">
          Ticket created. A technician will take a look; you'll see updates here.
        </p>
      )}

      <div className="ticket-page__layout">
        <article className="ticket-page__post">
          <header className="ticket-page__post-header">
            <strong>{ticket.created_by_name}</strong> opened this ticket <RelativeTime date={ticket.created_at} />
          </header>
          <p className="ticket-page__description">{ticket.description}</p>
        </article>

        <aside className="ticket-page__side" aria-label="Ticket details">
          <dl>
            <Fact label="Status"><StatusBadge status={ticket.status} /></Fact>
            <Fact label="Priority"><PriorityBadge priority={ticket.priority} /></Fact>
            <Fact label="Category">{ticket.category_name ?? <span className="ticket-page__none">Not set</span>}</Fact>
            <Fact label="Assignee">{ticket.assigned_to_name ?? <span className="ticket-page__none">Nobody yet</span>}</Fact>
            <Fact label="Opened"><RelativeTime date={ticket.created_at} /></Fact>
            <Fact label="Last updated"><RelativeTime date={ticket.updated_at} /></Fact>
          </dl>
        </aside>

        <section className="ticket-page__activity" aria-labelledby="ticket-activity">
          <h2 id="ticket-activity" className="ticket-page__heading">Activity</h2>
          <ol className="ticket-page__timeline">
            {history.map((event) => (
              <li key={event.id} className="ticket-page__event">
                <strong>{event.actor_name}</strong> {describeEvent(event)} · <RelativeTime date={event.created_at} />
              </li>
            ))}
          </ol>
        </section>
      </div>
    </div>
  )
}

/** One label and value in the side panel. */
function Fact({ label, children }) {
  return (
    <div className="ticket-page__fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

/**
 * One history entry in words, after the person's name.
 * @example describeEvent({ action: 'changed', field: 'status', old_value: 'open', new_value: 'resolved' })
 * // "changed the status from Open to Resolved"
 */
function describeEvent({ action, field, old_value: from, new_value: to }) {
  if (action === 'created') return 'opened this ticket'
  switch (field) {
    case 'status':
      return `changed the status from ${statusLabel(from)} to ${statusLabel(to)}`
    case 'priority':
      return `changed the priority from ${priorityLabel(from)} to ${priorityLabel(to)}`
    case 'category':
      if (!from) return `set the category to ${to}`
      if (!to) return `removed the category ${from}`
      return `changed the category from ${from} to ${to}`
    case 'assignee':
      if (!from) return `assigned this to ${to}`
      if (!to) return `unassigned ${from}`
      return `reassigned this from ${from} to ${to}`
    case 'title':
      return `changed the title from "${from}" to "${to}"`
    case 'description':
      return 'edited the description' // the full old text would be too long for one line
    default:
      return `changed the ${field}`
  }
}

export default TicketPage
