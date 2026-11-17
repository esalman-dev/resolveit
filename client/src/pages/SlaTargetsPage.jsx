// Target times page: admins and owners set how fast each priority should get a first reply and
// be fixed (the SLA). Counted in clock time from when a ticket was opened.
//
// Due times are worked out from these on the server every time a ticket is read, so saving
// changes the due times of every open ticket at once; the page asks "Are you sure?" first.

import { useEffect, useState } from 'react'
import { apiFetch } from '../lib/api.js'
import ConfirmDialog from '../components/ConfirmDialog.jsx'
import { PriorityBadge } from '../components/Badges.jsx'
import { formatDuration } from '../lib/sla.js'
import { usePageTitle } from '../lib/usePageTitle.js'
import './SlaTargetsPage.css'

const UNITS = { minutes: 1, hours: 60, days: 1440 } // minutes in one of each

/** Splits minutes into the largest whole unit: 1440 → { amount: 1, unit: 'days' }. */
function toAmount(minutes) {
  if (minutes % UNITS.days === 0) return { amount: String(minutes / UNITS.days), unit: 'days' }
  if (minutes % UNITS.hours === 0) return { amount: String(minutes / UNITS.hours), unit: 'hours' }
  return { amount: String(minutes), unit: 'minutes' }
}

/** Back to minutes, or NaN if the number isn't usable (the server says why). */
const toMinutes = ({ amount, unit }) => Math.round(Number(amount) * UNITS[unit])

/**
 * The Target times screen.
 *
 * Note: hiding this page from other roles only keeps the interface tidy. The server is what
 * blocks them (PUT /api/sla-targets answers 403 for anyone who isn't an admin or owner).
 */
function SlaTargetsPage() {
  usePageTitle('Target times')
  const [rows, setRows] = useState([]) // [{ priority, reply: { amount, unit }, fix: { amount, unit }, updated... }]
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

  /** Puts the server's targets into the form. */
  const show = (targets) =>
    setRows(
      targets.map((t) => ({
        priority: t.priority,
        reply: toAmount(t.first_response_minutes),
        fix: toAmount(t.resolve_minutes),
        updatedAt: t.updated_at,
        updatedBy: t.updated_by_name,
      }))
    )

  useEffect(() => {
    apiFetch('/api/sla-targets')
      .then((data) => show(data.targets))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [])

  /** Changes one box or unit in one row. */
  function update(priority, step, field, value) {
    setSaved(false)
    setRows((list) => list.map((r) => (r.priority === priority ? { ...r, [step]: { ...r[step], [field]: value } } : r)))
  }

  async function save() {
    setBusy(true)
    setError('')
    try {
      const targets = rows.map((r) => ({
        priority: r.priority,
        first_response_minutes: toMinutes(r.reply),
        resolve_minutes: toMinutes(r.fix),
      }))
      const data = await apiFetch('/api/sla-targets', { method: 'PUT', body: { targets } })
      show(data.targets)
      setSaved(true)
    } catch (err) {
      setError(err.message) // e.g. "The fix target for low can't be shorter than its first-reply target"
    } finally {
      setBusy(false)
      setConfirming(false)
    }
  }

  if (loading) return <p className="hint">Loading target times…</p>

  const lastChange = rows.filter((r) => r.updatedBy).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0]

  return (
    <div className="targets-page">
      <section className="targets-page__card">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            setConfirming(true)
          }}
        >
          <div className="table-wrap">
            <table className="targets-page__table">
              <thead>
                <tr>
                  <th scope="col">Priority</th>
                  <th scope="col">First reply within</th>
                  <th scope="col">Fixed within</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.priority}>
                    <td><PriorityBadge priority={r.priority} /></td>
                    {['reply', 'fix'].map((step) => (
                      <td key={step}>
                        <span className="targets-page__time">
                          <input
                            type="number"
                            min="1"
                            step="any"
                            required
                            value={r[step].amount}
                            onChange={(e) => update(r.priority, step, 'amount', e.target.value)}
                            aria-label={`${step === 'reply' ? 'First reply' : 'Fixed'} for ${r.priority}`}
                          />
                          <select
                            value={r[step].unit}
                            onChange={(e) => update(r.priority, step, 'unit', e.target.value)}
                            aria-label={`Unit for ${step === 'reply' ? 'first reply' : 'fixed'}, ${r.priority}`}
                          >
                            {Object.keys(UNITS).map((u) => <option key={u} value={u}>{u}</option>)}
                          </select>
                        </span>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {error && <p className="error" role="alert">{error}</p>}
          {saved && <p className="targets-page__saved" role="status">Saved. Every open ticket now uses these times.</p>}
          <div className="targets-page__actions">
            {lastChange && (
              <span className="hint">
                Last changed by {lastChange.updatedBy}, {new Date(lastChange.updatedAt).toLocaleDateString()}
              </span>
            )}
            <button type="submit" className="primary" disabled={busy}>Save</button>
          </div>
        </form>
      </section>

      <aside className="targets-page__about" aria-label="About target times">
        <h2 className="targets-page__about-heading">About target times</h2>
        <p>
          Every ticket gets two deadlines from its priority, counted from when it was opened, around the clock
          (nights and weekends included).
        </p>
        <p>
          <strong>First reply</strong> is met by the first thing staff do that the user can see: a comment or a status
          change. Assigning a ticket or writing an internal note doesn't count.
        </p>
        <p>
          <strong>Fixed</strong> is met when the ticket is resolved.
        </p>
        <p>The ticket list shows what's due next and can sort the queue by most urgent.</p>
      </aside>

      <ConfirmDialog
        open={confirming}
        title="Save target times?"
        message={`This changes the deadlines of every open ticket at once. ${rows
          .map((r) => {
            const reply = toMinutes(r.reply)
            const fix = toMinutes(r.fix)
            return Number.isFinite(reply) && Number.isFinite(fix)
              ? `${r.priority[0].toUpperCase()}${r.priority.slice(1)}: reply ${formatDuration(reply * 60000)}, fixed ${formatDuration(fix * 60000)}.`
              : ''
          })
          .join(' ')}`}
        confirmLabel="Save"
        busy={busy}
        onConfirm={save}
        onCancel={() => setConfirming(false)}
      />
    </div>
  )
}

export default SlaTargetsPage
