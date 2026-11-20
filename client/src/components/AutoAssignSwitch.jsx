// Auto-assign switch: the "Auto-assign: On / Off" line at the top of the staff Tickets page.
// Admins and owners can change it (turning it off asks "Are you sure?"); technicians just see it.
//
// Note: the server is what stops technicians changing it (PUT /api/settings is admins only).

import { useEffect, useState } from 'react'
import { apiFetch } from '../lib/api.js'
import ConfirmDialog from './ConfirmDialog.jsx'
import './AutoAssignSwitch.css'

const ABOUT = 'New tickets go to the available technician with the fewest open tickets.'

/** @param canChange true for admins and owners */
function AutoAssignSwitch({ canChange }) {
  const [on, setOn] = useState(null) // null until loaded
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    apiFetch('/api/settings')
      .then((data) => setOn(data.settings.auto_assign))
      .catch(() => setOn(null)) // not worth an error on the queue: the line just doesn't show
  }, [])

  async function save(value) {
    setBusy(true)
    setError('')
    try {
      const data = await apiFetch('/api/settings', { method: 'PUT', body: { auto_assign: value } })
      setOn(data.settings.auto_assign)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
      setConfirming(false)
    }
  }

  if (on === null) return null

  return (
    <div className="auto-assign">
      {canChange ? (
        <label className="auto-assign__label" title={ABOUT}>
          Auto-assign:
          <select
            value={on ? 'on' : 'off'}
            disabled={busy}
            // Turning it off asks first; turning it back on doesn't need to.
            onChange={(e) => (e.target.value === 'off' ? setConfirming(true) : save(true))}
          >
            <option value="on">On</option>
            <option value="off">Off</option>
          </select>
        </label>
      ) : (
        <span className="auto-assign__label" title={ABOUT}>
          Auto-assign: <strong>{on ? 'On' : 'Off'}</strong>
        </span>
      )}
      {error && <span className="error" role="alert">{error}</span>}

      <ConfirmDialog
        open={confirming}
        title="Turn off auto-assign?"
        message="New tickets will stay unassigned until someone picks them up. Tickets already assigned stay as they are."
        confirmLabel="Turn off"
        busy={busy}
        onConfirm={() => save(false)}
        onCancel={() => setConfirming(false)}
      />
    </div>
  )
}

export default AutoAssignSwitch
