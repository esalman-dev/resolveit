import { useEffect, useRef, useState } from 'react'
import { apiFetch, saveToken } from './api.js'

// Public ID from Google Cloud Console (not a secret: it's visible in every page that uses it).
// If it isn't set, this component shows nothing and email/password login still works.
const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID

// Load Google's sign-in script once, no matter how many times the button mounts
let scriptPromise
function loadGoogleScript() {
  scriptPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://accounts.google.com/gsi/client'
    script.async = true
    script.onload = resolve
    script.onerror = () => reject(new Error('Could not load Google sign-in'))
    document.head.appendChild(script)
  })
  return scriptPromise
}

function GoogleButton({ onLoggedIn }) {
  const buttonRef = useRef(null) // the empty <div> Google draws its button into
  const [error, setError] = useState('')

  useEffect(() => {
    if (!CLIENT_ID) return
    let cancelled = false

    loadGoogleScript()
      .then(() => {
        if (cancelled) return
        window.google.accounts.id.initialize({
          client_id: CLIENT_ID,
          // Google calls this after the user picks an account. response.credential is
          // Google's signed ID token; we pass it to OUR server, which verifies it.
          callback: async (response) => {
            try {
              const data = await apiFetch('/api/auth/google', {
                method: 'POST',
                body: { credential: response.credential },
              })
              saveToken(data.token) // from here on it's a normal ResolveIT login
              onLoggedIn(data.user)
            } catch (err) {
              setError(err.message)
            }
          },
        })
        window.google.accounts.id.renderButton(buttonRef.current, {
          theme: 'outline',
          size: 'large',
          text: 'continue_with',
        })
      })
      .catch((err) => !cancelled && setError(err.message))

    return () => { cancelled = true } // don't update state if the page changed meanwhile
  }, [onLoggedIn])

  if (!CLIENT_ID) return null

  return (
    <div className="google">
      <div className="divider"><span>or</span></div>
      <div ref={buttonRef} />
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  )
}

export default GoogleButton
