import { useEffect, useState } from 'react'
import { apiFetch } from './api.js'

const ROLES = ['user', 'technician', 'admin']

// Admin screen: every account, with a dropdown to change its role.
// Hiding this page from non-admins is just for a clean UI; the SERVER is what actually
// blocks them (GET /api/users returns 403 for anyone who isn't an admin).
function UsersPage({ currentUser }) {
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [savingId, setSavingId] = useState(null) // which row is being saved right now

  useEffect(() => {
    apiFetch('/api/users')
      .then((data) => setUsers(data.users))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [])

  async function changeRole(user, role) {
    setError('')
    setSavingId(user.id)
    try {
      const data = await apiFetch(`/api/users/${user.id}/role`, { method: 'PATCH', body: { role } })
      // Replace just that one user in the list with the server's updated version
      setUsers((list) => list.map((u) => (u.id === user.id ? { ...u, role: data.user.role } : u)))
    } catch (err) {
      setError(err.message)
    } finally {
      setSavingId(null)
    }
  }

  if (loading) return <p>Loading users…</p>

  return (
    <section>
      <h2>Manage users</h2>
      <p className="hint">
        Role changes take effect immediately. The person's screen updates the next time they reload the page.
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
              const isMe = u.id === currentUser.id
              return (
                <tr key={u.id}>
                  <td>{u.name}{isMe && ' (you)'}</td>
                  <td>{u.email}</td>
                  <td>{[u.has_password && 'Password', u.has_google && 'Google'].filter(Boolean).join(', ')}</td>
                  <td>
                    <select
                      value={u.role}
                      onChange={(e) => changeRole(u, e.target.value)}
                      disabled={isMe || savingId === u.id}
                      title={isMe ? "You can't change your own role" : undefined}
                      aria-label={`Role for ${u.name}`}
                    >
                      {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}

export default UsersPage
