// Users page: the Manage users screen for admins and owners.
//
// Every account with a role dropdown and a Disable/Enable button, each change confirmed with
// an "Are you sure?" box, plus the account history (who changed what, and when).
//
// A search box (name or email) and a Role filter narrow the list. Like the ticket list, they're
// kept in the address (e.g. /admin/users?role=technician), so a refresh keeps them.

import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router'
import { apiFetch } from '../lib/api.js'
import { ROLES, canManage, grantableRoles } from '../lib/roles.js'
import ConfirmDialog from '../components/ConfirmDialog.jsx'
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
  const [history, setHistory] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // The action waiting for "Are you sure?", or null. Either
  // { kind: 'role', user, role } or { kind: 'disable', user, disabled }.
  const [pending, setPending] = useState(null)
  const [saving, setSaving] = useState(false)
  const [params, setParams] = useSearchParams()

  // useCallback keeps the same function between renders, so the effect below runs only once.
  const loadHistory = useCallback(
    () => apiFetch('/api/users/history').then((data) => setHistory(data.history)),
    []
  )

  useEffect(() => {
    Promise.all([apiFetch('/api/users').then((data) => setUsers(data.users)), loadHistory()])
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [loadHistory])

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

  if (loading) return <p>Loading users…</p>

  const options = grantableRoles(currentUser.role) // e.g. an admin may give: user, technician

  // --- Search and filter ---
  const q = params.get('q') ?? ''
  const roleFilter = params.get('role') ?? ''
  const filtering = Boolean(q || roleFilter)
  const text = q.trim().toLowerCase()
  const shown = users.filter(
    (u) =>
      (!text || u.name.toLowerCase().includes(text) || u.email.toLowerCase().includes(text)) &&
      (!roleFilter || u.role === roleFilter)
  )

  /** Changes one filter in the address; `replace` so typing doesn't add Back-button steps. */
  function setFilter(name, value) {
    setParams(
      (current) => {
        const next = new URLSearchParams(current)
        if (value) next.set(name, value)
        else next.delete(name)
        return next
      },
      { replace: true }
    )
  }

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
          <input type="search" value={q} onChange={(e) => setFilter('q', e.target.value)} placeholder="Name or email" />
        </label>
        <label>
          Role
          <select value={roleFilter} onChange={(e) => setFilter('role', e.target.value)}>
            <option value="">All</option>
            {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
        {filtering && (
          <button type="button" className="link users-page__clear" onClick={() => setParams({}, { replace: true })}>
            Clear filters
          </button>
        )}
      </div>

      {/* aria-live: screen readers announce the new count as the filters change. */}
      <p className="hint users-page__count" aria-live="polite">
        {filtering ? `Showing ${shown.length} of ` : ''}
        {users.length} {users.length === 1 ? 'user' : 'users'}
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
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td colSpan={5} className="users-page__none">No users match these filters.</td>
              </tr>
            )}
            {shown.map((u) => {
              const reason = lockedReason(u)
              const disabled = Boolean(u.disabled_at)
              return (
                <tr key={u.id} className={disabled ? 'muted' : undefined}>
                  <td>{u.name}{u.id === currentUser.id && ' (you)'}</td>
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
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

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
    </section>
  )
}

/** One history row in plain words, e.g. "Bob: technician → admin". */
function describeEvent(e) {
  if (e.action === 'role_changed') return `${e.user_name}: ${e.old_value} → ${e.new_value}`
  if (e.action === 'disabled') return `Disabled ${e.user_name}`
  if (e.action === 'enabled') return `Re-enabled ${e.user_name}`
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
