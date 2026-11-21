// New-hire steps page: admins and owners edit the standard checklist every new-hire setup
// ticket starts with ("Create account", "Prepare laptop"…).
//
// Each ticket copies the list when it's opened, so saving only changes tickets opened
// afterwards. That's why there's no "Are you sure?": nothing that already exists changes.

import { useEffect, useState } from 'react'
import { apiFetch } from '../lib/api.js'
import { usePageTitle } from '../lib/usePageTitle.js'
import './NewHireStepsPage.css'

const MAX_STEPS = 30 // the server's limits (routes/newHireSteps.js)
const MAX_LENGTH = 120

/**
 * The New-hire steps screen.
 *
 * Note: hiding this page from other roles only keeps the interface tidy. The server is what
 * blocks them (PUT /api/new-hire-steps answers 403 for anyone who isn't an admin or owner).
 */
function NewHireStepsPage() {
  usePageTitle('New-hire steps')
  const [steps, setSteps] = useState([]) // the step names, in order
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    apiFetch('/api/new-hire-steps')
      .then((data) => setSteps(data.steps))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [])

  /** Every change goes through here, so "Saved" disappears as soon as the list differs. */
  function change(next) {
    setSaved(false)
    setSteps(next)
  }

  const rename = (i, title) => change(steps.map((s, j) => (j === i ? title : s)))
  const remove = (i) => change(steps.filter((_, j) => j !== i))
  const add = () => change([...steps, ''])
  /** Swaps a step with the one above (by = -1) or below (by = 1). */
  function move(i, by) {
    const next = [...steps]
    ;[next[i], next[i + by]] = [next[i + by], next[i]]
    change(next)
  }

  async function save(e) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const data = await apiFetch('/api/new-hire-steps', { method: 'PUT', body: { steps } })
      setSteps(data.steps)
      setSaved(true)
    } catch (err) {
      setError(err.message) // e.g. "Prepare laptop" is in the list twice
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <p className="hint">Loading the steps…</p>

  return (
    <div className="new-hire-steps">
      <section className="new-hire-steps__card">
        <form onSubmit={save}>
          <ol className="new-hire-steps__list">
            {steps.map((title, i) => (
              <li key={i} className="new-hire-steps__step">
                <span className="new-hire-steps__number" aria-hidden="true">{i + 1}</span>
                <input
                  aria-label={`Step ${i + 1}`}
                  value={title}
                  onChange={(e) => rename(i, e.target.value)}
                  required
                  maxLength={MAX_LENGTH}
                  placeholder="e.g. Order a monitor"
                />
                <span className="new-hire-steps__tools">
                  <button type="button" className="link" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move step ${i + 1} up`}>↑</button>
                  <button type="button" className="link" onClick={() => move(i, 1)} disabled={i === steps.length - 1} aria-label={`Move step ${i + 1} down`}>↓</button>
                  <button type="button" className="link" onClick={() => remove(i)} disabled={steps.length === 1} aria-label={`Remove step ${i + 1}`}>✕</button>
                </span>
              </li>
            ))}
          </ol>
          {steps.length < MAX_STEPS && (
            <button type="button" className="link new-hire-steps__add" onClick={add}>+ Add a step</button>
          )}

          {error && <p className="error" role="alert">{error}</p>}
          {saved && <p className="new-hire-steps__saved" role="status">Saved. New-hire tickets opened from now on start with these steps.</p>}
          <div className="new-hire-steps__actions">
            <button type="submit" className="primary" disabled={busy}>Save</button>
          </div>
        </form>
      </section>

      <aside className="new-hire-steps__about" aria-label="About new-hire steps">
        <h2 className="new-hire-steps__about-heading">About new-hire steps</h2>
        <p>
          When staff start a <strong>New hire</strong> ticket, it gets a checklist with these steps, in this order.
        </p>
        <p>
          Each ticket keeps its own copy. Staff can add or remove steps on a ticket, and changing this list never
          changes a ticket that already exists.
        </p>
        <p>A new-hire ticket can only be resolved once every step is done or marked not needed.</p>
      </aside>
    </div>
  )
}

export default NewHireStepsPage
