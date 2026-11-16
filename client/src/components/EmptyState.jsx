// Empty state: a short message and an optional button, for a screen with nothing to show.

import { Link } from 'react-router'
import './EmptyState.css'

/**
 * Shows a message in a box, with an optional link that looks like a button.
 *
 * @example
 * <EmptyState message="No tickets yet." actionLabel="Get help" actionTo="/get-help" />
 */
function EmptyState({ message, actionLabel, actionTo }) {
  return (
    <div className="empty-state">
      <p className="empty-state__message">{message}</p>
      {actionTo && <Link className="empty-state__action" to={actionTo}>{actionLabel}</Link>}
    </div>
  )
}

export default EmptyState
