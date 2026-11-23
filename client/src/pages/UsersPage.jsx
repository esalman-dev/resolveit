// Users page: the Manage users screen for admins and owners.
//
// Every account with a role dropdown, a Disable/Enable button and Edit (name, job title,
// department) for people ranked below you; role and Disable changes are confirmed with
// an "Are you sure?" box, plus the account history (who changed what, and when).
//
// A search box (name or email) and a Role filter narrow the list. Like the ticket list, they're
// kept in the address (e.g. /admin/users?role=technician&page=2), so a refresh keeps them, and
// the server sends one page of 25 at a time.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { apiFetch } from '../lib/api.js'
import { ROLES, canManage, grantableRoles } from '../lib/roles.js'
import ConfirmDialog from '../components/ConfirmDialog.jsx'
import Pagination from '../components/Pagination.jsx'
import { showingText } from '../lib/paging.js'
import { usePageTitle } from '../lib/usePageTitle.js'
import './UsersPage.css'

/**
 * The Manage users screen.
 *
 * Note: hiding this page from other roles only keeps the interface tidy. The server is what
 * blocks them (GET /api/users answers 403 for anyone who isn't an admin or owner).
 */
function UsersPage({ currentUser }) {
  usePageTitle('Users')
  const [users, setUsers] = useState([])
  const [listInfo, setListInfo] = useState(null) // { total, total_all, page, per_page }
  const [history, setHistory] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // The action waiting for "Are you sure?", or null. Either
  // { kind: 'role', user, role } or { kind: 'disable', user, disabled }.
  const [pending, setPending] = useState(null)
  const [editing, setEditing] = useState(null) // the person whose details are being edited, or null
  const [saving, setSaving] = useState(false)
  const [params, setParams] = useSearchParams()

  // useCallback keeps the same function between renders, so the effect below runs only once.
  const loadHistory = useCallback(
    () => apiFetch('/api/users/history').then((data) => setHistory(data.history)),
    []
  )

  // The search and filters from the address, and the box (the address follows after a pause).
  const q = params.get('q') ?? ''
  const roleFilter = params.get('role') ?? ''
  const filtering = Boolean(q || roleFilter)
  const [typed, setTyped] = useState(q)
  const requestKey = params.toString()

  useEffect(() => {
    loadHistory().catch((err) => setError(err.message))
  }, [loadHistory])

  useEffect(() => {
    apiFetch(`/api/users?${requestKey}`)
      .then(({ users: list, ...info }) => {
        setUsers(list)
        setListInfo(info)
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [requestKey])

  // Why the pause: searching on every key press would ask the server once per letter.
  useEffect(() => {
    if (typed.trim() === q) return
    const timer = setTimeout(() => setFilter('q', typed.trim()), 300)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typed])

  // When the address's search changes by itself (Back, a link), the box shows it.
  useEffect(() => {
    setTyped((current) => (current.trim() === q ? current : q))
  }, [q])

  /**
   * Changes one filter in the address; an empty value removes it, and it goes back to page 1.
   * `replace` so typing doesn't add Back-button steps.
   */
  function setFilter(name, value) {
    setParams(
      (current) => {
        const next = new URLSearchParams(current)
        if (value) next.set(name, value)
        else next.delete(name)
        next.delete('page')
        return next
      },
      { replace: true }
    )
  }

  /** Goes to another page (a Back-button step, like turning a page). */
  function goToPage(page) {
    setParams((current) => {
      const next = new URLSearchParams(current)
      if (page > 1) next.set('page', String(page))
      else next.delete('page')
      return next
    })
    window.scrollTo({ top: 0 })
  }

  /**
   * Step 1: picking a role or clicking Disable doesn't save anything; it opens the confirm box.
   * The dropdown keeps showing the old role (its value comes from `users`), so Cancel needs no undo.
   */
  function ask(action) {
    setError('')
    setPending(action)
  }

  /** Step 2: saves the pending action after the confirm button is clicked, then reloads the history. */
  async function confirm() {
    const { kind, user } = pending
    setSaving(true)
    try {
      const data =
        kind === 'role'
          ? await apiFetch(`/api/users/${user.id}/role`, { method: 'PATCH', body: { role: pending.role } })
          : await apiFetch(`/api/users/${user.id}/disabled`, { method: 'PATCH', body: { disabled: pending.disabled } })
      // Replace just that one user in the list with the server's updated version.
      setUsers((list) => list.map((u) => (u.id === user.id ? { ...u, ...data.user } : u)))
      await loadHistory() // show the new history entry
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
      setPending(null)
    }
  }

  /** Why a row can't be changed (shown as a tooltip), or null if it can. */
  function lockedReason(u) {
    if (u.id === currentUser.id) return "You can't change your own account"
    if (u.role === 'owner') return 'Owners can only be changed on the server'
    if (!canManage(currentUser.role, u.role)) return `Only an owner can change an ${u.role}'s account`
    return null
  }

  if (loading || !listInfo) return <p>Loading users…</p>

  const options = grantableRoles(currentUser.role) // e.g. an admin may give: user, technician


  return (
    <section className="users-page">
      <p className="hint">
        Changes take effect immediately. Disabling someone logs them out everywhere; their tickets stay.
        {currentUser.role === 'admin' && ' Only an owner can change admins.'}
      </p>
      {error && <p className="error" role="alert">{error}</p>}

      <div className="users-page__toolbar" role="search">
        <label className="users-page__search">
          Search
          <input type="search" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Name or email" />
        </label>
        <label>
          Role
          <select value={roleFilter} onChange={(e) => setFilter('role', e.target.value)}>
            <option value="">All</option>
            {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
        {filtering && (
          <button
            type="button"
            className="link users-page__clear"
            onClick={() => {
              setTyped('')
              setParams({}, { replace: true })
            }}
          >
            Clear filters
          </button>
        )}
      </div>

      {/* aria-live: screen readers announce the new count as the filters change. */}
      <p className="hint users-page__count" aria-live="polite">
        {showingText(listInfo.page, listInfo.per_page, listInfo.total, filtering ? ['matching user', 'matching users'] : ['user', 'users'])}
        {filtering && ` (${listInfo.total_all.toLocaleString()} in all)`}
      </p>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Sign-in</th>
              <th>Role</th>
              <th>Account</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {users.length === 0 && (
              <tr>
                <td colSpan={6} className="users-page__none">No users match these filters.</td>
              </tr>
            )}
            {users.map((u) => {
              const reason = lockedReason(u)
              const disabled = Boolean(u.disabled_at)
              const work = [u.job_title, u.department].filter(Boolean).join(' · ')
              return (
                <tr key={u.id} className={disabled ? 'muted' : undefined}>
                  <td>
                    {u.name}{u.id === currentUser.id && ' (you)'}
                    {work && <span className="users-page__work">{work}</span>}
                  </td>
                  <td>{u.email}</td>
                  <td>{[u.has_password && 'Password', u.has_google && 'Google'].filter(Boolean).join(', ')}</td>
                  <td>
                    {reason ? (
                      // Locked: show the role as plain text, with the reason on hover.
                      <span className="badge" title={reason}>{u.role}</span>
                    ) : (
                      <select
                        value={u.role}
                        onChange={(e) => ask({ kind: 'role', user: u, role: e.target.value })}
                        disabled={saving}
                        aria-label={`Role for ${u.name}`}
                      >
                        {options.map((r) => <option key={r} value={r}>{r}</option>)}
                      </select>
                    )}
                  </td>
                  <td>
                    {reason ? (
                      <span title={reason}>{disabled ? 'Disabled' : 'Active'}</span>
                    ) : (
                      <button
                        type="button"
                        className={disabled ? undefined : 'danger-outline'}
                        onClick={() => ask({ kind: 'disable', user: u, disabled: !disabled })}
                        disabled={saving}
                      >
                        {disabled ? 'Enable' : 'Disable'}
                      </button>
                    )}
                  </td>
                  <td>
                    {/* Your own details are changed on the Profile page; others follow the ranking rule. */}
                    {u.id === currentUser.id ? (
                      <Link className="button-link" to="/profile">Edit your profile</Link>
                    ) : reason ? (
                      <span className="hint" title={reason}>–</span>
                    ) : (
                      <button type="button" className="link" onClick={() => setEditing(u)} disabled={saving} aria-label={`Edit ${u.name}'s details`}>
                        Edit
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <Pagination page={listInfo.page} perPage={listInfo.per_page} total={listInfo.total} onPage={goToPage} />

      <h3>Account history</h3>
      {history.length === 0 ? (
        <p className="hint">No changes yet.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>What</th>
              </tr>
            </thead>
            <tbody>
              {history.map((e) => (
                <tr key={e.id}>
                  <td>{new Date(e.created_at).toLocaleString()}</td>
                  {/* No actor means a server command (make-admin, make-owner) made the change. */}
                  <td>{e.actor_name ?? 'Server command'}</td>
                  <td>{describeEvent(e)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmDialog
        open={pending !== null}
        {...confirmText(pending)}
        busy={saving}
        onConfirm={confirm}
        onCancel={() => setPending(null)}
      />
      {editing && (
        <EditDetailsDialog
          user={editing}
          onSaved={(saved) => {
            setUsers((list) => list.map((u) => (u.id === saved.id ? { ...u, ...saved } : u)))
            setEditing(null)
            loadHistory().catch(() => {}) // a rename adds a history line
          }}
          onCancel={() => setEditing(null)}
        />
      )}
    </section>
  )
}

/**
 * The "Edit details" box for someone else: name, job title, department.
 * Why not the "Are you sure?" box: that one closes whatever happens, but a form should stay
 * open to show "Name is required" next to what was typed.
 */
function EditDetailsDialog({ user, onSaved, onCancel }) {
  const dialogRef = useRef(null)
  const [form, setForm] = useState({ name: user.name, job_title: user.job_title ?? '', department: user.department ?? '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // Opens as a modal box when shown (the same browser <dialog> as "Are you sure?").
  useEffect(() => {
    dialogRef.current.showModal()
  }, [])

  async function save(event) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const data = await apiFetch(`/api/users/${user.id}/details`, { method: 'PATCH', body: form })
      onSaved(data.user)
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="confirm"
      aria-labelledby="edit-details-title"
      onCancel={(e) => {
        e.preventDefault() // Escape: React decides, as with the other boxes
        if (!busy) onCancel()
      }}
    >
      <form className="users-page__details" onSubmit={save}>
        <h3 id="edit-details-title">Edit {user.name}'s details</h3>
        <label>
          Name
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={100} />
        </label>
        <label>
          <span>Job title <span className="hint">(optional)</span></span>
          <input value={form.job_title} onChange={(e) => setForm({ ...form, job_title: e.target.value })} maxLength={80} />
        </label>
        <label>
          <span>Department <span className="hint">(optional)</span></span>
          <input value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} maxLength={80} />
        </label>
        <p className="hint">A new name shows everywhere at once and goes in the account history.</p>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="confirm-buttons">
          <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="submit" className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </dialog>
  )
}

/** One history row in plain words, e.g. "Bob: technician → admin". */
function describeEvent(e) {
  if (e.action === 'role_changed') return `${e.user_name}: ${e.old_value} → ${e.new_value}`
  if (e.action === 'disabled') return `Disabled ${e.user_name}`
  if (e.action === 'enabled') return `Re-enabled ${e.user_name}`
  if (e.action === 'renamed') return `Renamed "${e.old_value}" to "${e.new_value}"`
  if (e.action === 'password_changed') return `${e.user_name} changed their password`
  return e.action
}

/** What the "Are you sure?" box says for each kind of action. */
function confirmText(pending) {
  if (!pending) return { title: '', message: '' }
  const { kind, user } = pending
  if (kind === 'role') {
    // A demotion (moving down the ranking) gets a red button.
    const demotion = ROLES.indexOf(pending.role) < ROLES.indexOf(user.role)
    return {
      title: 'Change role?',
      message: `${user.name} will go from ${user.role} to ${pending.role}. This takes effect immediately.`,
      confirmLabel: demotion ? 'Demote' : 'Change role',
      danger: demotion,
    }
  }
  return pending.disabled
    ? {
        title: `Disable ${user.name}?`,
        message: `${user.name} will be logged out everywhere and won't be able to log in. Their tickets and comments stay. You can re-enable them later.`,
        confirmLabel: 'Disable',
        danger: true,
      }
    : {
        title: `Re-enable ${user.name}?`,
        message: `${user.name} will be able to log in again.`,
        confirmLabel: 'Enable',
        danger: false,
      }
}

export default UsersPage
