// New hire page: staff start a setup ticket for someone who's joining. The ticket gets a
// checklist copied from the standard New-hire steps, and is due at 9:00 AM on the start date.

import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { apiFetch } from '../lib/api.js'
import { usePageTitle } from '../lib/usePageTitle.js'
import './NewHirePage.css'

const MAX_TEXT = 80 // name and job title (the server's limit)
const READY_AT = '09:00' // setup should be finished before the person's first morning

/** Today as YYYY-MM-DD in this computer's time zone (what <input type="date"> uses). */
function today() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * The New hire form.
 *
 * Note: the start date becomes an exact time here, in the browser, because only the browser
 * knows the person's time zone. "2026-12-01" + 9:00 AM local is sent as one ISO time.
 */
function NewHirePage() {
  usePageTitle('New hire')
  const navigate = useNavigate()
  const [form, setForm] = useState({ name: '', jobTitle: '', startDate: '', notes: '' })
  const [steps, setSteps] = useState(null) // the standard steps, shown as a preview
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    apiFetch('/api/new-hire-steps')
      .then((data) => setSteps(data.steps))
      .catch(() => setSteps([])) // only a preview: the ticket still gets the steps
  }, [])

  const set = (field) => (e) => setForm({ ...form, [field]: e.target.value })

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const data = await apiFetch('/api/tickets/new-hire', {
        method: 'POST',
        body: {
          name: form.name,
          job_title: form.jobTitle,
          ready_by: new Date(`${form.startDate}T${READY_AT}`).toISOString(),
          notes: form.notes,
        },
      })
      navigate(`/tickets/${data.ticket.id}`, { state: { created: true } })
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  return (
    <form className="card new-hire" onSubmit={submit}>
      <label>
        Name
        <input value={form.name} onChange={set('name')} required maxLength={MAX_TEXT} autoComplete="off" placeholder="e.g. Jane Doe" />
      </label>
      <label>
        Job title
        <input value={form.jobTitle} onChange={set('jobTitle')} required maxLength={MAX_TEXT} placeholder="e.g. Sales Associate" />
      </label>
      <label>
        Start date
        <input type="date" value={form.startDate} onChange={set('startDate')} required min={today()} className="new-hire__date" />
        <span className="hint">The setup is due by 9:00 AM that day.</span>
      </label>
      <label>
        <span>Notes <span className="hint">(optional)</span></span>
        <textarea value={form.notes} onChange={set('notes')} rows={3} maxLength={4000} placeholder="Anything extra, e.g. needs a second monitor" />
      </label>

      {steps && steps.length > 0 && (
        <div className="new-hire__steps">
          <p className="new-hire__steps-heading">These steps will be added. You can change them on the ticket.</p>
          <ol>
            {steps.map((title) => <li key={title}>{title}</li>)}
          </ol>
        </div>
      )}

      {error && <p className="error" role="alert">{error}</p>}
      <div className="new-hire__actions">
        <Link className="button-link" to="/tickets">Cancel</Link>
        <button type="submit" className="primary" disabled={busy}>{busy ? 'Creating…' : 'Create ticket'}</button>
      </div>
    </form>
  )
}

export default NewHirePage
