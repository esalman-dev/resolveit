// Status dot: a small colored dot for someone's online status, always with the word beside it
// (or read out to screen readers), so color is never the only signal.

import { STATUS_LABELS } from '../lib/presence.js'
import './StatusDot.css'

/**
 * @param {'available' | 'busy' | 'away' | 'offline'} status
 * @param showLabel show the word on screen too (otherwise only screen readers get it)
 * @example <StatusDot status="busy" showLabel />
 */
function StatusDot({ status, showLabel = false }) {
  const label = STATUS_LABELS[status] ?? status
  return (
    <span className="status-dot-wrap">
      <span className={`status-dot status-dot--${status}`} aria-hidden="true" />
      {showLabel ? <span className="status-dot__label">{label}</span> : <span className="visually-hidden">{label}</span>}
    </span>
  )
}

export default StatusDot
