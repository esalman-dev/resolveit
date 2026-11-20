// Ticket side panel: the facts beside a ticket. Staff get dropdowns to change them; the person
// who opened the ticket sees plain text and a "Close ticket" button.

import { Link } from 'react-router'
import { PriorityBadge, StatusBadge } from '../../components/Badges.jsx'
import RelativeTime from '../../components/RelativeTime.jsx'
import DueBadge from '../../components/DueBadge.jsx'
import { Stars } from '../../components/Stars.jsx'
import { nextTarget, stepResult } from '../../lib/sla.js'
import { PRIORITIES, STATUSES, priorityLabel, statusLabel } from '../../lib/ticketLabels.js'

/**
 * The right-hand panel of the ticket page.
 *
 * Nothing here saves directly: every change goes to `onChange(fields, label)`, and the ticket
 * page decides whether to ask "Are you sure?" first. The dropdowns always show the saved value,
 * so a cancelled change needs no undo.
 *
 * @param categories active categories (staff only)
 * @param assignees staff who can be assigned (staff only)
 * @param busy disables the controls while a change is saving
 * @param rating the review, shown to admins and owners (null for everyone else)
 * @param article the knowledge base article drafted from this ticket (staff), or null
 * @param openOutages the open outages (staff can link the ticket to one)
 * @param onOutageChange called with an outage id, or null to unlink (saves straight away: it's easy to undo)
 */
function TicketSidePanel({ ticket, currentUser, staff, categories, assignees, busy, onChange, onClose, rating = null, article = null, openOutages = [], onOutageChange }) {
  const isCreator = ticket.created_by === currentUser.id

  // An archived category or a disabled staff member can still be the current value, but isn't
  // in the lists above. Add them so the dropdown can show it.
  const categoryOptions =
    ticket.category_id && !categories.some((c) => c.id === ticket.category_id)
      ? [...categories, { id: ticket.category_id, name: `${ticket.category_name} (archived)` }]
      : categories
  const assigneeOptions =
    ticket.assigned_to && !assignees.some((a) => a.id === ticket.assigned_to)
      ? [...assignees, { id: ticket.assigned_to, name: ticket.assigned_to_name }]
      : assignees

  return (
    <aside className="ticket-page__side" aria-label="Ticket details">
      <dl>
        <Fact label="Status" id="ticket-status">
          {staff ? (
            <select
              aria-labelledby="ticket-status"
              value={ticket.status}
              disabled={busy}
              onChange={(e) => onChange({ status: e.target.value })}
            >
              {STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
            </select>
          ) : (
            <StatusBadge status={ticket.status} />
          )}
        </Fact>

        <Fact label="Priority" id="ticket-priority">
          {staff ? (
            <select
              aria-labelledby="ticket-priority"
              value={ticket.priority}
              disabled={busy}
              onChange={(e) => onChange({ priority: e.target.value })}
            >
              {PRIORITIES.map((p) => <option key={p} value={p}>{priorityLabel(p)}</option>)}
            </select>
          ) : (
            <PriorityBadge priority={ticket.priority} />
          )}
        </Fact>

        <Fact label="Category" id="ticket-category">
          {staff ? (
            <select
              aria-labelledby="ticket-category"
              value={ticket.category_id ?? ''}
              disabled={busy}
              onChange={(e) => onChange({ category_id: e.target.value ? Number(e.target.value) : null })}
            >
              <option value="">Not set</option>
              {categoryOptions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          ) : (
            ticket.category_name ?? <span className="ticket-page__none">Not set</span>
          )}
        </Fact>

        <Fact label="Assignee" id="ticket-assignee">
          {staff ? (
            <>
              <select
                aria-labelledby="ticket-assignee"
                value={ticket.assigned_to ?? ''}
                disabled={busy}
                onChange={(e) => onChange({ assigned_to: e.target.value ? Number(e.target.value) : null })}
              >
                <option value="">Nobody</option>
                {/* A dropdown can't show a colored dot, so the status is in words: "Sam Rivera (busy)". */}
                {assigneeOptions.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}{a.status ? ` (${a.status})` : ''}
                  </option>
                ))}
              </select>
              {/* The most common staff action, one click away. */}
              {!ticket.assigned_to && (
                <button
                  type="button"
                  className="link ticket-page__take"
                  disabled={busy}
                  onClick={() => onChange({ assigned_to: currentUser.id })}
                >
                  Assign to me
                </button>
              )}
            </>
          ) : (
            ticket.assigned_to_name ?? <span className="ticket-page__none">Nobody yet</span>
          )}
        </Fact>

        {/* Staff: link to an open outage by hand. Everyone: a note while it's a confirmed one. */}
        {staff && (openOutages.length > 0 || ticket.outage_id) && (
          <Fact label="Outage" id="ticket-outage">
            <select
              aria-labelledby="ticket-outage"
              value={ticket.outage_id ?? ''}
              disabled={busy}
              onChange={(e) => onOutageChange(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">None</option>
              {outageOptions(ticket, openOutages).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </Fact>
        )}
        {!staff && ticket.outage_status === 'confirmed' && (
          <Fact label="Known issue">{ticket.outage_message}</Fact>
        )}

        <Fact label="Opened"><RelativeTime date={ticket.created_at} /></Fact>
        <Fact label="Last updated"><RelativeTime date={ticket.updated_at} /></Fact>
        <TargetFact ticket={ticket} step="reply" label="First reply" />
        <TargetFact ticket={ticket} step="fix" label="Fixed" />
        {article && (
          <Fact label="Knowledge base">
            <Link className="button-link" to={`/kb/${article.id}`}>
              {article.status === 'draft' ? 'Review the draft' : article.status === 'published' ? 'View the article' : 'Archived article'}
            </Link>
          </Fact>
        )}
        {rating && (
          <Fact label="Review">
            <Stars stars={rating.stars} />
            {rating.comment && <span className="ticket-page__review-comment">“{rating.comment}”</span>}
          </Fact>
        )}
      </dl>

      <StepsTried steps={ticket.steps_tried ?? []} />

      {/* Closing marks the ticket resolved. Staff do that with the Status dropdown instead. */}
      {!staff && isCreator && ticket.status !== 'resolved' && (
        <button type="button" className="danger-outline ticket-page__close" disabled={busy} onClick={onClose}>
          Close ticket
        </button>
      )}
    </aside>
  )
}

/**
 * The Outage dropdown's choices: each open outage ("Network: Wi-Fi down…", or "Network
 * (possible)" before it's confirmed), plus the ticket's own outage if it has closed since.
 */
function outageOptions(ticket, openOutages) {
  const options = openOutages.map((o) => ({
    id: o.id,
    label: o.status === 'confirmed' ? `${o.category_name}: ${o.message}` : `${o.category_name} (possible)`,
  }))
  if (ticket.outage_id && !openOutages.some((o) => o.id === ticket.outage_id)) {
    options.push({ id: ticket.outage_id, label: ticket.outage_message ?? `Closed outage (${ticket.outage_status})` })
  }
  return options
}

/**
 * One label and value in the panel. `id` names the label, so a dropdown can point at it
 * (aria-labelledby) and screen readers read "Status, Open".
 */
function Fact({ label, id, children }) {
  return (
    <div className="ticket-page__fact">
      <dt id={id}>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

/**
 * One target time: when it's due (with the due badge while it's the next one), or once met,
 * how long it took and whether it was on time.
 * @param {'reply' | 'fix'} step
 */
function TargetFact({ ticket, step, label }) {
  if (!ticket.resolve_due_at) return null // no target for this priority
  const result = stepResult(ticket, step)
  const dueAt = step === 'reply' ? ticket.response_due_at : ticket.resolve_due_at
  const isNext = nextTarget(ticket)?.target === step
  return (
    <Fact label={label}>
      {result ? (
        <span className={result.late ? 'ticket-page__target--late' : 'ticket-page__target--met'}>
          {result.text} · {result.late ? `${result.lateBy} late` : 'on time'}
        </span>
      ) : (
        <span className="ticket-page__target">
          <span>by {formatDue(dueAt)}</span>
          {isNext && <DueBadge ticket={ticket} />}
        </span>
      )}
    </Fact>
  )
}

/** "today 3:40 PM", "tomorrow 9:00 AM", or "Nov 21, 9:00 AM". */
function formatDue(value) {
  const date = new Date(value)
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  // Whole days between the due date and today, counted from midnight.
  const days = Math.round((new Date(date).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400000)
  if (days === 0) return `today ${time}`
  if (days === 1) return `tomorrow ${time}`
  if (days === -1) return `yesterday ${time}`
  return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`
}

/**
 * The AI's suggested steps, each marked tried or not, on tickets opened through Get help.
 * Why: the technician sees what the user already did, so they don't ask them to do it again.
 * Nothing shows for other tickets, or when the problem went straight to a technician.
 */
function StepsTried({ steps }) {
  if (steps.length === 0) return null
  return (
    <section className="ticket-page__steps" aria-labelledby="ticket-steps-tried">
      <h3 id="ticket-steps-tried" className="ticket-page__steps-heading">Steps tried</h3>
      <ol>
        {steps.map((step, index) => (
          <li key={index} className={step.tried ? 'ticket-page__step--tried' : 'ticket-page__step--skipped'}>
            <span className="ticket-page__step-title">{step.title}</span>
            <span className="ticket-page__step-mark">{step.tried ? '✓ Tried' : 'Not tried'}</span>
          </li>
        ))}
      </ol>
    </section>
  )
}

export default TicketSidePanel
