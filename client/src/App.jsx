import { useEffect, useState } from 'react'

// Where the Express server lives while developing
const API_URL = 'http://localhost:5000'

function App() {
  // 'checking' until the server answers, then 'ok' or 'offline'
  const [serverStatus, setServerStatus] = useState('checking')
  const [dbStatus, setDbStatus] = useState('checking')

  // Runs once when the page first loads: ask the server if it (and the database) are alive
  useEffect(() => {
    fetch(`${API_URL}/api/health`)
      .then((res) => res.json())
      .then((data) => {
        setServerStatus(data.status)
        setDbStatus(data.database)
      })
      .catch(() => {
        setServerStatus('offline')
        setDbStatus('unknown') // can't ask about the database if the server is down
      })
  }, [])

  return (
    <main>
      <h1>ResolveIT</h1>
      <p>Help desk with AI self-service fixes. Coming soon.</p>
      <p>
        Server status: <strong>{serverStatus}</strong>
      </p>
      <p>
        Database: <strong>{dbStatus}</strong>
      </p>
    </main>
  )
}

export default App
