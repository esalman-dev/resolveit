// Demo buttons: "Try as a user / technician / admin" on the live site (home page and login form).
//
// One click logs into a shared demo account (POST /api/auth/demo) and opens that role's first
// page. The free server sleeps when nobody uses it, so a slow first click says why it's waiting.

import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { apiFetch, setAccessToken } from '../lib/api.js'
import './DemoButtons.css'

const ROLES = [
  ['user', 'Try as a user', '/get-help'],
  ['technician', 'Try as a technician', '/tickets'],
  ['admin', 'Try as an admin', '/tickets'],
]
const SLOW_MS = 3000 // after this, explain the wait

/**
 * The three demo buttons.
 * @param onLoggedIn called with the demo user, so App switches to the logged-in screens
 * @param size 'big' on the home page's hero
 */
function DemoButtons({ onLoggedIn, size }) {
  const navigate = useNavigate()
  const [busy, setBusy] = useState(null) // the role being logged into
  const [slow, setSlow] = useState(false)
  const [error, setError] = useState('')
  const timer = useRef(null)

  useEffect(() => () => clearTimeout(timer.current), [])

  async function tryAs(role, home) {
    setBusy(role)
    setError('')
    setSlow(false)
    timer.current = setTimeout(() => setSlow(true), SLOW_MS)
    try {
      const data = await apiFetch('/api/auth/demo', { method: 'POST', body: { as: role } })
      setAccessToken(data.token)
      onLoggedIn(data.user)
      navigate(home)
    } catch (err) {
      setError(err.message)
      setBusy(null)
    } finally {
      clearTimeout(timer.current)
    }
  }

  return (
    <div className={size === 'big' ? 'demo-buttons demo-buttons--big' : 'demo-buttons'}>
      <div className="demo-buttons__row">
        {ROLES.map(([role, label, home], i) => (
          <button
            key={role}
            type="button"
            className={i === 0 ? 'primary' : undefined}
            onClick={() => tryAs(role, home)}
            disabled={busy !== null}
          >
            {busy === role ? 'Opening…' : label}
          </button>
        ))}
      </div>
      <p className="demo-buttons__note" aria-live="polite">
        {error ||
          (slow
            ? 'Waking up the server… (it sleeps when nobody uses it, so this can take up to a minute)'
            : 'No sign-up needed. Shared demo accounts; changes reset every night.')}
      </p>
    </div>
  )
}

export default DemoButtons
