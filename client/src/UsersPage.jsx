import { useEffect, useState } from 'react'
import { apiFetch } from './api.js'
import { ROLES, canManage, grantableRoles } from './roles.js'
import ConfirmDialog from './ConfirmDialog.jsx'

// Admin/owner screen: every account, with a dropdown to change its role.
// Hiding this page from others is just for a clean UI; the SERVER is what actually
// blocks them (GET /api/users returns 403 for anyone who isn't an admin or owner).
function UsersPage({ currentUser }) {
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [pending, setPending] = useState(null) // { user, role } waiting for "Are you sure?", or null
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    apiFetch('/api/users')
      .then((data) => setUsers(data.users))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [])

  // Step 1: picking a role in the dropdown doesn't save anything. It only opens the confirm box.
  // The dropdown keeps showing the OLD role (its value comes from `users`), so Cancel needs no undo.
  function askToChangeRole(user, role) {
    setError('')
    setPending({ user, role })
  }

  // Step 2: they clicked the confirm button
  async function confirmChange() {
    const { user, role } = pending
    setSaving(true)
    try {
      const data = await apiFetch(`/api/users/${user.id}/role`, { method: 'PATCH', body: { role } })
      // Replace just that one user in the list with the server's updated version
      setUsers((list) => list.map((u) => (u.id === user.id ? { ...u, role: data.user.role } : u)))
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
      setPending(null)
    }
  }

  // Why a row can't be changed (shown as a tooltip), or null if it can
  function lockedReason(u) {
    if (u.id === currentUser.id) return "You can't change your own role"
    if (u.role === 'owner') return 'Owners can only be changed on the server'
    if (!canManage(currentUser.role, u.role)) return `Only an owner can change an ${u.role}'s role`
    return null
  }

  if (loading) return <p>Loading users…</p>

  const options = grantableRoles(currentUser.role) // e.g. an admin may give: user, technician
  // A demotion (moving down the ranking) gets a red button
  const isDemotion = pending && ROLES.indexOf(pending.role) < ROLES.indexOf(pending.user.role)

  return (
    <section>
      <h2>Manage users</h2>
      <p className="hint">
        Role changes take effect immediately. The person's screen updates the next time they reload the page.
        {currentUser.role === 'admin' && ' Only an owner can promote or demote admins.'}
      </p>
      {error && <p className="error" role="alert">{error}</p>}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Sign-in</th>
              <th>Role</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const reason = lockedReason(u)
              return (
                <tr key={u.id}>
                  <td>{u.name}{u.id === currentUser.id && ' (you)'}</td>
                  <td>{u.email}</td>
                  <td>{[u.has_password && 'Password', u.has_google && 'Google'].filter(Boolean).join(', ')}</td>
                  <td>
                    {reason ? (
                      // Locked: show the role as plain text, with the reason on hover
                      <span className="badge" title={reason}>{u.role}</span>
                    ) : (
                      <select
                        value={u.role}
                        onChange={(e) => askToChangeRole(u, e.target.value)}
                        disabled={saving}
                        aria-label={`Role for ${u.name}`}
                      >
                        {options.map((r) => <option key={r} value={r}>{r}</option>)}
                      </select>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <ConfirmDialog
        open={pending !== null}
        title="Change role?"
        message={pending && `${pending.user.name} will go from ${pending.user.role} to ${pending.role}. This takes effect immediately.`}
        confirmLabel={isDemotion ? 'Demote' : 'Change role'}
        danger={isDemotion}
        busy={saving}
        onConfirm={confirmChange}
        onCancel={() => setPending(null)}
      />
    </section>
  )
}

export default UsersPage
