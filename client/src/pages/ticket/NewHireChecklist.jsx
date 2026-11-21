// New-hire checklist: the tick boxes on a new-hire setup ticket, between the ticket and its
// activity.
//
// Each step is to do, done (ticked) or not needed (skipped). Staff tick, skip, add and remove
// steps; every change is saved at once and answered with the ticket, its history and checklist,
// which go back to the page through onSaved. Once the ticket is resolved the list is read-only.

import { useState } from 'react'
import { apiFetch } from '../../lib/api.js'
import RelativeTime from '../../components/RelativeTime.jsx'
import './NewHireChecklist.css'

const MAX_STEPS = 30 // the server's limits (routes/checklist.js)
const MAX_LENGTH = 120

/**
 * @param checklist [{ id, title, state, changed_by_name, changed_at }], in order
 * @param canChange staff, on a ticket that isn't resolved
 * @param onSaved   receives the server's answer: { ticket, history, checklist }
 */
function NewHireChecklist({ ticketId, checklist, canChange, resolved, onSaved }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [newStep, setNewStep] = useState('')

  const finished = checklist.filter((s) => s.state !== 'todo').length
  const percent = checklist.length ? Math.round((finished / checklist.length) * 100) : 0

  /** Sends one change; the page updates from the answer. Returns true if it saved. */
  async function send(path, options) {
    setBusy(true)
    setError('')
    try {
      onSaved(await apiFetch(`/api/tickets/${ticketId}/checklist${path}`, options))
      return true
    } catch (err) {
      setError(err.message)
      return false
    } finally {
      setBusy(false)
    }
  }

  const setState = (step, state) => send(`/${step.id}`, { method: 'PATCH', body: { state } })
  const remove = (step) => send(`/${step.id}`, { method: 'DELETE' })

  async function add(e) {
    e.preventDefault()
    if (await send('', { method: 'POST', body: { title: newStep } })) setNewStep('')
  }

  return (
    <section className="checklist" aria-labelledby="checklist-heading">
      <header className="checklist__header">
        <h2 id="checklist-heading" className="checklist__heading">Setup checklist</h2>
        <span className="checklist__count">{finished} of {checklist.length} done</span>
      </header>
      {/* The words above say the same, so the bar is hidden from screen readers. */}
      <div className="checklist__bar" aria-hidden="true">
        <div className="checklist__bar-fill" style={{ width: `${percent}%` }} />
      </div>

      <ul className="checklist__steps">
        {checklist.map((step) => (
          <li key={step.id} className={`checklist__step checklist__step--${step.state}`}>
            <label className="checklist__tick">
              <input
                type="checkbox"
                checked={step.state === 'done'}
                disabled={!canChange || busy || step.state === 'not_needed'}
                onChange={(e) => setState(step, e.target.checked ? 'done' : 'todo')}
              />
              <span className="checklist__title">{step.title}</span>
            </label>

            {step.state !== 'todo' && step.changed_by_name && (
              <span className="checklist__who">
                {step.state === 'not_needed' ? 'Not needed · ' : ''}
                {step.changed_by_name} · <RelativeTime date={step.changed_at} />
              </span>
            )}

            {canChange && (
              <span className="checklist__tools">
                {step.state === 'todo' && (
                  <button type="button" className="link" disabled={busy} onClick={() => setState(step, 'not_needed')}>
                    Not needed
                  </button>
                )}
                {step.state === 'not_needed' && (
                  <button type="button" className="link" disabled={busy} onClick={() => setState(step, 'todo')}>
                    Undo
                  </button>
                )}
                <button
                  type="button"
                  className="link"
                  disabled={busy || checklist.length === 1}
                  onClick={() => remove(step)}
                  aria-label={`Remove the step ${step.title}`}
                >
                  ✕
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>

      {error && <p className="error" role="alert">{error}</p>}

      {canChange && checklist.length < MAX_STEPS && (
        <form className="checklist__add" onSubmit={add}>
          <input
            value={newStep}
            onChange={(e) => setNewStep(e.target.value)}
            required
            maxLength={MAX_LENGTH}
            placeholder="Add a step, e.g. Order a monitor"
            aria-label="New step"
          />
          <button type="submit" disabled={busy}>Add</button>
        </form>
      )}
      {resolved && <p className="hint checklist__note">Resolved. Reopen the ticket to change the checklist.</p>}
    </section>
  )
}

export default NewHireChecklist
