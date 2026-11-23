// Profile page: your name, job title and department, your password, and (staff) your numbers
// for the last 30 days. Opened from the account menu, at /profile.
//
// A saved name shows in the header at once: the page hands the updated user back to App.

import { useEffect, useState } from 'react'
import { apiFetch } from '../lib/api.js'
import { isStaff } from '../lib/roles.js'
import { formatDuration } from '../lib/sla.js'
import { usePageTitle } from '../lib/usePageTitle.js'
import './ProfilePage.css'

const MINUTE = 60 * 1000

/**
 * The Profile page.
 * @param onUserChange called with the saved details, so the header shows them at once
 */
function ProfilePage({ currentUser, onUserChange }) {
  usePageTitle('Profile')
  const [data, setData] = useState(null) // { user, stats, stats_days }
  const [error, setError] = useState('')

  useEffect(() => {
    apiFetch('/api/profile')
      .then(setData)
      .catch((err) => setError(err.message))
  }, [])

  if (error) return <p className="error" role="alert">{error}</p>
  if (!data) return <p className="hint">Loading your profile…</p>

  return (
    <div className="profile">
      <DetailsCard user={data.user} onSaved={(user) => {
        setData({ ...data, user: { ...data.user, ...user } })
        onUserChange(user)
      }} />
      <PasswordCard hasPassword={data.user.has_password} />
      {isStaff(currentUser.role) && <StatsCard stats={data.stats} days={data.stats_days} />}
    </div>
  )
}

/** Name, job title and department, with Save. */
function DetailsCard({ user, onSaved }) {
  const [form, setForm] = useState({ name: user.name, job_title: user.job_title ?? '', department: user.department ?? '' })
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(null) // { ok, text }
  const changed = form.name !== user.name || form.job_title !== (user.job_title ?? '') || form.department !== (user.department ?? '')

  async function save(event) {
    event.preventDefault()
    setBusy(true)
    setMessage(null)
    try {
      const { user: saved } = await apiFetch('/api/profile', { method: 'PATCH', body: form })
      setForm({ name: saved.name, job_title: saved.job_title ?? '', department: saved.department ?? '' })
      onSaved({ name: saved.name, job_title: saved.job_title, department: saved.department })
      setMessage({ ok: true, text: 'Saved.' })
    } catch (err) {
      setMessage({ ok: false, text: err.message })
    } finally {
      setBusy(false)
    }
  }

  const signIn = [user.has_password && 'Password', user.has_google && 'Google'].filter(Boolean).join(' and ')
  return (
    <form className="profile__card" onSubmit={save} aria-labelledby="profile-details">
      <h2 id="profile-details" className="profile__heading">Your details</h2>
      <label>
        Name
        <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={100} autoComplete="name" />
        <span className="hint">How you appear on tickets, comments and the dashboard.</span>
      </label>
      <label>
        <span>Job title <span className="profile__optional">(optional)</span></span>
        <input value={form.job_title} onChange={(e) => setForm({ ...form, job_title: e.target.value })} maxLength={80} placeholder="e.g. Accountant" autoComplete="organization-title" />
      </label>
      <label>
        <span>Department <span className="profile__optional">(optional)</span></span>
        <input value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} maxLength={80} placeholder="e.g. Finance" />
      </label>
      <dl className="profile__facts">
        <dt>Email</dt>
        <dd>{user.email} <span className="hint">(can't be changed here)</span></dd>
        <dt>Signs in with</dt>
        <dd>{signIn}</dd>
      </dl>
      <div className="profile__actions">
        {message && <p className={message.ok ? 'profile__ok' : 'error'} role={message.ok ? 'status' : 'alert'}>{message.text}</p>}
        <button type="submit" className="primary" disabled={busy || !changed}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </form>
  )
}

/** Change password: current, new, and the new one again. */
function PasswordCard({ hasPassword }) {
  const EMPTY = { current: '', next: '', again: '' }
  const [form, setForm] = useState(EMPTY)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(null) // { ok, text }

  if (!hasPassword) {
    return (
      <section className="profile__card" aria-labelledby="profile-password">
        <h2 id="profile-password" className="profile__heading">Password</h2>
        <p className="hint">You sign in with Google, so there's no ResolveIT password to change.</p>
      </section>
    )
  }

  async function change(event) {
    event.preventDefault()
    // Why check here too: a typo in the new password would otherwise lock you out of it.
    if (form.next !== form.again) return setMessage({ ok: false, text: "The new passwords don't match." })
    setBusy(true)
    setMessage(null)
    try {
      await apiFetch('/api/auth/password', { method: 'POST', body: { current_password: form.current, new_password: form.next } })
      setForm(EMPTY)
      setMessage({ ok: true, text: "Password changed. You've been logged out on your other devices." })
    } catch (err) {
      setMessage({ ok: false, text: err.message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="profile__card" onSubmit={change} aria-labelledby="profile-password">
      <h2 id="profile-password" className="profile__heading">Password</h2>
      <label>
        Current password
        <input type="password" value={form.current} onChange={(e) => setForm({ ...form, current: e.target.value })} required autoComplete="current-password" />
      </label>
      <label>
        New password
        <input type="password" value={form.next} onChange={(e) => setForm({ ...form, next: e.target.value })} required minLength={8} autoComplete="new-password" />
        <span className="hint">At least 8 characters.</span>
      </label>
      <label>
        New password again
        <input type="password" value={form.again} onChange={(e) => setForm({ ...form, again: e.target.value })} required autoComplete="new-password" />
      </label>
      <div className="profile__actions">
        {message && <p className={message.ok ? 'profile__ok' : 'error'} role={message.ok ? 'status' : 'alert'}>{message.text}</p>}
        <button type="submit" className="primary" disabled={busy}>{busy ? 'Changing…' : 'Change password'}</button>
      </div>
    </form>
  )
}

/** Staff: your own numbers, the same as your row in the dashboard's team table. */
function StatsCard({ stats, days }) {
  return (
    <section className="profile__card" aria-labelledby="profile-stats">
      <h2 id="profile-stats" className="profile__heading">Your last {days} days</h2>
      {!stats ? (
        <p className="hint">No tickets assigned to you yet. Your numbers appear here once you have some.</p>
      ) : (
        <dl className="profile__stats">
          <Stat label="Resolved" value={stats.resolved} />
          <Stat label="Average time to fix" value={stats.fix_avg === null ? '–' : formatDuration(stats.fix_avg * MINUTE)} />
          <Stat label="Fixed on time" value={stats.fixed_on_time_rate === null ? '–' : `${Math.round(stats.fixed_on_time_rate)}%`} />
          <Stat label={`Rating (${stats.reviews} ${stats.reviews === 1 ? 'review' : 'reviews'})`} value={stats.average_rating === null ? '–' : `★ ${stats.average_rating.toFixed(1)}`} />
          <Stat label="Open now" value={stats.open_now} />
        </dl>
      )}
    </section>
  )
}

/** One number with its label. */
function Stat({ label, value }) {
  return (
    <div className="profile__stat">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

export default ProfilePage
