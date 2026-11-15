import { useEffect, useState } from 'react'

// Where the Express server lives while developing
const API_URL = 'http://localhost:5000'

function App() {
  // 'checking' until the server answers, then 'ok' or 'offline'
  const [serverStatus, setServerStatus] = useState('checking')

  // Runs once when the page first loads: ask the server if it's alive
  useEffect(() => {
    fetch(`${API_URL}/api/health`)
      .then((res) => res.json())
      .then((data) => setServerStatus(data.status))
      .catch(() => setServerStatus('offline'))
  }, [])

  return (
    <main>
      <h1>ResolveIT</h1>
      <p>Help desk with AI self-service fixes. Coming soon.</p>
      <p>
        Server status: <strong>{serverStatus}</strong>
      </p>
    </main>
  )
}

export default App
