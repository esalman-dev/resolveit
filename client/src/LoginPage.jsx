import { useState } from 'react'
import { apiFetch, saveToken } from './api.js'

// One form for both "log in" and "create account".
// onLoggedIn(user) is called after success so App can switch screens.
function LoginPage({ onLoggedIn }) {
  const [mode, setMode] = useState('login') // 'login' or 'register'
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false) // disables the button so it can't be double-clicked

  const isRegister = mode === 'register'

  async function handleSubmit(e) {
    e.preventDefault() // stop the browser's default full-page form submit
    setError('')
    setBusy(true)
    try {
      const data = await apiFetch(`/api/auth/${mode}`, {
        method: 'POST',
        body: isRegister ? { name, email, password } : { email, password },
      })
      saveToken(data.token)
      onLoggedIn(data.user)
    } catch (err) {
      setError(err.message) // show the server's message, e.g. "Invalid email or password"
    } finally {
      setBusy(false)
    }
  }

  function switchMode() {
    setMode(isRegister ? 'login' : 'register')
    setError('')
  }

  return (
    <section className="card">
      <h2>{isRegister ? 'Create an account' : 'Log in'}</h2>

      <form onSubmit={handleSubmit}>
        {isRegister && (
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" />
          </label>
        )}
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={isRegister ? 8 : undefined}
            autoComplete={isRegister ? 'new-password' : 'current-password'}
          />
        </label>

        {error && <p className="error" role="alert">{error}</p>}

        <button type="submit" disabled={busy}>
          {busy ? 'Please wait…' : isRegister ? 'Create account' : 'Log in'}
        </button>
      </form>

      <p className="switch">
        {isRegister ? 'Already have an account?' : 'New to ResolveIT?'}{' '}
        <button type="button" className="link" onClick={switchMode}>
          {isRegister ? 'Log in' : 'Create an account'}
        </button>
      </p>
    </section>
  )
}

export default LoginPage
