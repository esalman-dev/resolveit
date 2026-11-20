// Known issues: on Get help, above the form, the confirmed outages with "This is my problem".
// Pressing it adds you to the outage without opening a ticket; the bell tells you when it's fixed.

import { useState } from 'react'
import './KnownIssues.css'

/** @param outages the shared outages object from useOutages (lib/outages.js) */
function KnownIssues({ outages }) {
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState(null)
  const confirmed = outages.list.filter((o) => o.status === 'confirmed')
  if (confirmed.length === 0) return null

  async function report(id) {
    setBusyId(id)
    setError('')
    try {
      await outages.act(id, 'report')
    } catch (err) {
      setError(err.message)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <section className="known-issues" aria-labelledby="known-issues-heading">
      <h2 id="known-issues-heading" className="known-issues__heading">Known issues right now</h2>
      <ul className="known-issues__list">
        {confirmed.map((o) => (
          <li key={o.id} className="known-issues__item">
            <span>{o.message}</span>
            {o.reported_by_me ? (
              <span className="known-issues__done" role="status">
                You're on the list. We'll let you know here when it's fixed.
              </span>
            ) : (
              <button type="button" className="link" disabled={busyId === o.id} onClick={() => report(o.id)}>
                This is my problem
              </button>
            )}
          </li>
        ))}
      </ul>
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  )
}

export default KnownIssues
