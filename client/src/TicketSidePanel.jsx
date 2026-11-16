// Ticket side panel: the facts beside a ticket. Staff get dropdowns to change them; the person
// who opened the ticket sees plain text and a "Close ticket" button.

import { PriorityBadge, StatusBadge } from './Badges.jsx'
import RelativeTime from './RelativeTime.jsx'
import { PRIORITIES, STATUSES, priorityLabel, statusLabel } from './ticketLabels.js'

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
 */
function TicketSidePanel({ ticket, currentUser, staff, categories, assignees, busy, onChange, onClose }) {
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
                {assigneeOptions.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
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

        <Fact label="Opened"><RelativeTime date={ticket.created_at} /></Fact>
        <Fact label="Last updated"><RelativeTime date={ticket.updated_at} /></Fact>
      </dl>

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

export default TicketSidePanel
