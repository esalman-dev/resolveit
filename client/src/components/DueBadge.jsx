// Due badge: how an unresolved ticket stands against its target time ("Reply due in 3 h",
// "Overdue 1 d"). Renders nothing for a resolved ticket.

import { dueLabel, nextTarget } from '../lib/sla.js'
import './DueBadge.css'

/**
 * Gray when there's plenty of time, amber when under a quarter is left, red when overdue.
 * The words always say which, so color is never the only signal.
 *
 * @example <DueBadge ticket={ticket} />
 */
function DueBadge({ ticket }) {
  const next = nextTarget(ticket)
  if (!next) return null
  return (
    <span className={`due-badge due-badge--${next.state}`} title={`Due ${next.dueAt.toLocaleString()}`}>
      {dueLabel(next)}
    </span>
  )
}

export default DueBadge
