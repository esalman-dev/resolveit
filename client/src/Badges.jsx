// Badges: the small colored labels for a ticket's status and priority.
//
// Every badge shows its word as well as its color, so it still works for colorblind people.

import { priorityLabel, statusLabel } from './ticketLabels.js'
import './Badges.css'

/**
 * A ticket's status as a colored label.
 * @example <StatusBadge status="in_progress" /> // amber "In progress"
 */
export function StatusBadge({ status }) {
  return <span className={`badge-pill badge-pill--status-${status}`}>{statusLabel(status)}</span>
}

/**
 * A ticket's priority as a colored label, with a dot in front so it doesn't look like a status.
 * @example <PriorityBadge priority="high" /> // orange "High"
 */
export function PriorityBadge({ priority }) {
  return (
    <span className={`badge-pill badge-pill--priority badge-pill--priority-${priority}`}>
      {priorityLabel(priority)}
    </span>
  )
}
