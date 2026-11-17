// Target times (SLA): where a ticket stands against its reply and fix targets.
//
// The server sends each ticket's response_due_at and resolve_due_at (from the target times for
// its priority) and first_response_at; these helpers turn them into "Due in 3 h" or "Overdue".

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * A length of time in short words, at most two units.
 * @example formatDuration(95 * 60 * 1000) // '1 h 35 min'
 */
export function formatDuration(ms) {
  const abs = Math.abs(ms)
  if (abs < HOUR) return `${Math.max(1, Math.round(abs / MINUTE))} min`
  if (abs < DAY) {
    const hours = Math.floor(abs / HOUR)
    const minutes = Math.round((abs % HOUR) / MINUTE)
    return minutes && hours < 10 ? `${hours} h ${minutes} min` : `${Math.round(abs / HOUR)} h`
  }
  const days = Math.floor(abs / DAY)
  const hours = Math.round((abs % DAY) / HOUR)
  return hours ? `${days} d ${hours} h` : `${days} d`
}

/**
 * The next target an unresolved ticket has to meet, and how it's doing.
 * Returns null for a resolved ticket.
 *
 * state: 'ok' (plenty of time), 'soon' (under a quarter of the target left), 'overdue'.
 * @returns {{ target: 'reply' | 'fix', state: string, dueAt: Date, left: number } | null}
 *   left: milliseconds until due (negative once overdue)
 */
export function nextTarget(ticket, now = Date.now()) {
  if (ticket.status === 'resolved' || !ticket.resolve_due_at) return null
  const target = ticket.first_response_at ? 'fix' : 'reply'
  const dueAt = new Date(target === 'reply' ? ticket.response_due_at : ticket.resolve_due_at)
  const length = dueAt - new Date(ticket.created_at) // the whole target, to judge "soon"
  const left = dueAt - now
  const state = left < 0 ? 'overdue' : left < length / 4 ? 'soon' : 'ok'
  return { target, state, dueAt, left }
}

/** The badge words, e.g. "Reply due in 3 h", "Overdue 1 d". */
export function dueLabel({ target, state, left }) {
  const what = target === 'reply' ? 'Reply' : ''
  if (state === 'overdue') return `${what ? 'Reply overdue' : 'Overdue'} ${formatDuration(left)}`
  return `${what ? 'Reply due' : 'Due'} in ${formatDuration(left)}`
}

/**
 * How a finished step went: "Replied in 2 h · on time", "Fixed in 3 d 4 h · 4 h late".
 * @param {'reply' | 'fix'} step
 * Returns null when that step hasn't happened yet.
 */
export function stepResult(ticket, step) {
  const doneAt = step === 'reply' ? ticket.first_response_at : ticket.resolved_at
  if (!doneAt || !ticket.resolve_due_at) return null
  const dueAt = new Date(step === 'reply' ? ticket.response_due_at : ticket.resolve_due_at)
  const took = new Date(doneAt) - new Date(ticket.created_at)
  const late = new Date(doneAt) - dueAt
  const verb = step === 'reply' ? 'Replied' : 'Fixed'
  return { text: `${verb} in ${formatDuration(took)}`, late: late > 0, lateBy: late > 0 ? formatDuration(late) : null }
}

/**
 * Sort order for "Most urgent": overdue first (most overdue at the top), then the soonest
 * due, and resolved tickets last.
 */
export function byUrgency(a, b, now = Date.now()) {
  const due = (t) => nextTarget(t, now)?.dueAt.getTime() ?? Infinity
  return due(a) - due(b)
}
