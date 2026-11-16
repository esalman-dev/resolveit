// Get help page: where someone describes a problem and opens a ticket.
//
// Everyone sees it, and it's a regular user's home page. There's no priority field: new tickets
// start at medium, and staff set the priority (the server ignores one sent by a regular user).

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { apiFetch } from '../lib/api.js'
import { usePageTitle } from '../lib/usePageTitle.js'
import './GetHelpPage.css'

// Note: these match MAX_TITLE and MAX_DESCRIPTION in server/routes/tickets.js. The server
// checks them too; these just stop people typing more than will be accepted.
const MAX_TITLE = 200
const MAX_DESCRIPTION = 5000

/** The New Ticket form. After it's sent, opens the new ticket's page. */
function GetHelpPage() {
  usePageTitle('Get help')
  const navigate = useNavigate()
  const [categories, setCategories] = useState([])
  const [categoriesError, setCategoriesError] = useState('')
  const [title, setTitle] = useState('')
  const [categoryId, setCategoryId] = useState('') // '' means "Not sure"
  const [description, setDescription] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false) // stops a double click opening two tickets

  // The category list, archived ones left out (the server does that for non-admins and by default).
  useEffect(() => {
    apiFetch('/api/categories')
      .then((data) => setCategories(data.categories))
      .catch(() => setCategoriesError("Couldn't load categories. You can still send the form without one."))
  }, [])

  async function handleSubmit(e) {
    e.preventDefault() // stop the browser's default full-page form submit
    setError('')
    setBusy(true)
    try {
      const data = await apiFetch('/api/tickets', {
        method: 'POST',
        body: { title, description, category_id: categoryId ? Number(categoryId) : null },
      })
      // The ticket page reads `created` to show a "Ticket created" message.
      navigate(`/tickets/${data.ticket.id}`, { state: { created: true } })
    } catch (err) {
      setError(err.message) // e.g. "Title must be 200 characters or fewer"
      setBusy(false)
    }
  }

  return (
    <div className="get-help">
      <section className="get-help__card">
        <h2 className="get-help__heading">What's going wrong?</h2>
        <p className="hint">Describe the problem and a technician will take a look.</p>

        <form onSubmit={handleSubmit}>
          <label>
            Title
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              maxLength={MAX_TITLE}
              placeholder="e.g. Laptop won't connect to Wi-Fi"
            />
          </label>

          <label>
            Category
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">Not sure</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          {categoriesError && <p className="hint">{categoriesError}</p>}

          <label>
            Details
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              required
              maxLength={MAX_DESCRIPTION}
              rows={6}
              placeholder="What happened, when it started, and anything you've already tried."
            />
          </label>

          {error && <p className="error" role="alert">{error}</p>}

          <div className="get-help__actions">
            <button type="submit" className="primary" disabled={busy}>
              {busy ? 'Sending…' : 'Submit'}
            </button>
          </div>
        </form>
      </section>

      {/* Why: good tickets get fixed faster. Telling people what to include saves a round of
          "what does the error say?" comments. */}
      <aside className="get-help__tips" aria-label="Tips">
        <h2 className="get-help__tips-heading">Tips for a faster fix</h2>
        <ul>
          <li>Say what you were doing when it happened.</li>
          <li>Copy any error message word for word.</li>
          <li>Mention what you've already tried, like restarting.</li>
        </ul>
        <h2 className="get-help__tips-heading">What happens next</h2>
        <p>
          A technician looks at new tickets, sets the priority and picks it up. You'll see every update on
          the ticket's page and under My tickets.
        </p>
      </aside>
    </div>
  )
}

export default GetHelpPage
