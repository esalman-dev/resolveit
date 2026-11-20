// Tickets page: the ticket list, in two scopes.
//   scope 'mine' (/my-tickets, everyone): "My tickets", the tickets you opened.
//   scope 'all'  (/tickets, staff only):  "Tickets", every ticket, the work queue.
//
// Search and filters run in the browser on the full list. They're kept in the address
// (e.g. /tickets?status=open), so a refresh keeps them and a filtered view can be shared.
// The staff queue also gets count cards across the top (Open, In progress, Resolved, Assigned
// to me, Unassigned, Overdue) that double as one-click filters, like the AI help screen, a Due
// column (target times), and a Sort choice: newest first, or most urgent.

import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { apiFetch } from '../lib/api.js'
import { PriorityBadge, StatusBadge } from '../components/Badges.jsx'
import CountCards from '../components/CountCards.jsx'
import DueBadge from '../components/DueBadge.jsx'
import EmptyState from '../components/EmptyState.jsx'
import RelativeTime from '../components/RelativeTime.jsx'
import AutoAssignSwitch from '../components/AutoAssignSwitch.jsx'
import { isAdminOrOwner, isStaff } from '../lib/roles.js'
import { byUrgency, nextTarget } from '../lib/sla.js'
import { PRIORITIES, STATUSES, priorityLabel, statusLabel } from '../lib/ticketLabels.js'
import { usePageTitle } from '../lib/usePageTitle.js'
import './TicketsPage.css'

/** The filter names used in the address, e.g. ?q=wifi&status=open&mine=1 */
const FILTERS = ['q', 'status', 'priority', 'category', 'mine', 'unassigned', 'overdue']

/**
 * The ticket list with search and filters.
 *
 * Note: the server already limits users to their own tickets. Hiding the Assignee column and
 * "Assigned to me" from users is only tidiness.
 *
 * @param {'mine' | 'all'} scope 'mine' = tickets you opened; 'all' = the staff queue
 */
function TicketsPage({ currentUser, scope }) {
  const staff = isStaff(currentUser.role)
  const queue = staff && scope === 'all' // the staff work queue: count cards and "Assigned to me"
  usePageTitle(queue ? 'Tickets' : 'My tickets')
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const [tickets, setTickets] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const fetchTickets = useCallback(() => {
    apiFetch('/api/tickets')
      // Staff get every ticket from the server; My tickets keeps only the ones you opened.
      .then((data) => setTickets(queue ? data.tickets : data.tickets.filter((t) => t.created_by === currentUser.id)))
      .catch(() => setError("Couldn't load tickets."))
      .finally(() => setLoading(false))
  }, [queue, currentUser.id])

  useEffect(() => {
    fetchTickets()
  }, [fetchTickets])

  /** The "Try again" button: back to the loading state, then fetch again. */
  function retry() {
    setLoading(true)
    setError('')
    fetchTickets()
  }

  // The current filters, read from the address.
  const q = params.get('q') ?? ''
  const status = params.get('status') ?? ''
  const priority = params.get('priority') ?? ''
  const category = params.get('category') ?? ''
  const mine = params.get('mine') === '1'
  const unassigned = params.get('unassigned') === '1'
  const overdue = params.get('overdue') === '1'
  const sort = params.get('sort') === 'urgent' ? 'urgent' : 'newest' // not a filter: Clear filters keeps it
  const filtering = FILTERS.some((name) => params.has(name))

  /**
   * Changes one filter in the address. An empty value removes it, so the address stays short.
   * Why `replace`: typing in the search box would otherwise add a Back-button step per letter.
   */
  function setFilter(name, value) {
    setParams(
      (current) => {
        const next = new URLSearchParams(current)
        if (value) next.set(name, value)
        else next.delete(name)
        return next
      },
      { replace: true }
    )
  }

  // The Category dropdown lists the categories that appear in the tickets, archived ones
  // included, so old tickets can still be found.
  const categories = [...new Set(tickets.map((t) => t.category_name).filter(Boolean))].sort()

  const shown = tickets.filter(
    (t) =>
      matchesSearch(t, q) &&
      (!status || t.status === status) &&
      (!priority || t.priority === priority) &&
      (!category || (category === 'none' ? !t.category_name : t.category_name === category)) &&
      (!mine || t.assigned_to === currentUser.id) &&
      (!unassigned || isUnassigned(t)) &&
      (!overdue || isOverdue(t))
  )
  // The server sends newest first; "Most urgent" puts overdue tickets first, then the soonest due.
  if (sort === 'urgent') shown.sort((a, b) => byUrgency(a, b))

  // --- Staff count cards ---
  // Each card is a one-click filter. Choosing one replaces the other card filters (status,
  // "Assigned to me", "Unassigned"); search, priority and category stay as they are.
  const statusCount = (value) => tickets.filter((t) => t.status === value).length
  const cards = [
    { value: 'open', label: statusLabel('open'), count: statusCount('open'), tone: 'blue' },
    { value: 'in_progress', label: statusLabel('in_progress'), count: statusCount('in_progress'), tone: 'amber' },
    { value: 'resolved', label: statusLabel('resolved'), count: statusCount('resolved'), tone: 'green' },
    { value: 'mine', label: 'Assigned to me', count: tickets.filter((t) => t.assigned_to === currentUser.id).length, tone: 'indigo' },
    { value: 'unassigned', label: 'Unassigned', count: tickets.filter(isUnassigned).length, tone: 'gray' },
    { value: 'overdue', label: 'Overdue', count: tickets.filter(isOverdue).length, tone: 'red' },
  ]
  const onlyOne = [status, mine, unassigned, overdue].filter(Boolean).length === 1
  const selectedCard = !onlyOne ? '' : status || (mine ? 'mine' : unassigned ? 'unassigned' : 'overdue')

  function selectCard(value) {
    setParams(
      (current) => {
        const next = new URLSearchParams(current)
        for (const name of ['status', 'mine', 'unassigned', 'overdue']) next.delete(name)
        if (value === 'mine' || value === 'unassigned' || value === 'overdue') next.set(value, '1')
        else if (value) next.set('status', value)
        return next
      },
      { replace: true }
    )
  }

  if (loading) return <p className="hint">Loading tickets…</p>
  if (error) {
    return (
      <p className="error" role="alert">
        {error} <button type="button" onClick={retry}>Try again</button>
      </p>
    )
  }
  if (tickets.length === 0) {
    return <EmptyState message="No tickets yet." actionLabel="Get help" actionTo="/get-help" />
  }

  return (
    <div className="tickets-page">
      {queue && <AutoAssignSwitch canChange={isAdminOrOwner(currentUser.role)} />}
      {queue && <CountCards label="Filter tickets" cards={cards} selected={selectedCard} onSelect={selectCard} />}

      <div className="tickets-page__toolbar" role="search">
        <label className="tickets-page__search">
          Search
          <input
            type="search"
            value={q}
            onChange={(e) => setFilter('q', e.target.value)}
            placeholder="Title or #number"
          />
        </label>
        <FilterSelect label="Status" value={status} onChange={(v) => setFilter('status', v)}>
          {STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
        </FilterSelect>
        <FilterSelect label="Priority" value={priority} onChange={(v) => setFilter('priority', v)}>
          {PRIORITIES.map((p) => <option key={p} value={p}>{priorityLabel(p)}</option>)}
        </FilterSelect>
        <FilterSelect label="Category" value={category} onChange={(v) => setFilter('category', v)}>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          <option value="none">Not set</option>
        </FilterSelect>
        {queue && (
          <label className="tickets-page__check">
            <input type="checkbox" checked={mine} onChange={(e) => setFilter('mine', e.target.checked ? '1' : '')} />
            Assigned to me
          </label>
        )}
        {queue && (
          <label>
            Sort
            <select value={sort} onChange={(e) => setFilter('sort', e.target.value === 'urgent' ? 'urgent' : '')}>
              <option value="newest">Newest first</option>
              <option value="urgent">Most urgent</option>
            </select>
          </label>
        )}
        {filtering && (
          <button
            type="button"
            className="link tickets-page__clear"
            onClick={() => setParams(sort === 'urgent' ? { sort } : {}, { replace: true })}
          >
            Clear filters
          </button>
        )}
      </div>

      {/* aria-live: screen readers announce the new count as filters change. */}
      <p className="hint tickets-page__count" aria-live="polite">
        {filtering ? `Showing ${shown.length} of ` : ''}
        {tickets.length} {tickets.length === 1 ? 'ticket' : 'tickets'}
      </p>

      {shown.length === 0 ? (
        <EmptyState message="No tickets match these filters." />
      ) : (
        <div className="table-wrap tickets-page__table">
          <table>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Title</th>
                <th scope="col">Status</th>
                <th scope="col">Priority</th>
                {queue && <th scope="col">Due</th>}
                {staff && <th scope="col">Assignee</th>}
                <th scope="col">Opened</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((t) => (
                // The whole row opens the ticket for mouse users. Keyboard and screen reader
                // users get the real link in the Title cell.
                <tr key={t.id} onClick={() => navigate(`/tickets/${t.id}`)}>
                  <td className="tickets-page__id">{t.id}</td>
                  <td className="tickets-page__title-cell">
                    <Link className="tickets-page__title" to={`/tickets/${t.id}`}>{t.title}</Link>
                    {t.category_name && <span className="tickets-page__category">{t.category_name}</span>}
                  </td>
                  <td><StatusBadge status={t.status} /></td>
                  <td><PriorityBadge priority={t.priority} /></td>
                  {queue && <td className="tickets-page__due"><DueBadge ticket={t} /></td>}
                  {staff && <td className="tickets-page__assignee">{t.assigned_to_name ?? <span className="tickets-page__none">Nobody</span>}</td>}
                  <td className="tickets-page__opened"><RelativeTime date={t.created_at} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/** A labeled dropdown whose first option, "All", means no filter. */
function FilterSelect({ label, value, onChange, children }) {
  return (
    <label>
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">All</option>
        {children}
      </select>
    </label>
  )
}

/** Nobody assigned, and still needs doing (a resolved ticket with nobody on it isn't work to pick up). */
const isUnassigned = (ticket) => !ticket.assigned_to && ticket.status !== 'resolved'

/** Past its reply or fix target, and not resolved yet. */
const isOverdue = (ticket) => nextTarget(ticket)?.state === 'overdue'

/** True if the search text is in the title, or is the ticket's number ("12" or "#12"). */
function matchesSearch(ticket, q) {
  const text = q.trim().toLowerCase()
  if (!text) return true
  if (text.replace(/^#/, '') === String(ticket.id)) return true
  return ticket.title.toLowerCase().includes(text)
}

export default TicketsPage
