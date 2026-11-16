// Categories page: admins and owners add, rename, archive and restore ticket categories.
//
// Categories are never deleted, only archived: an archived category disappears from the Get help
// form, but old tickets keep it, so the ticket list and reports stay correct.

import { useEffect, useState } from 'react'
import { apiFetch } from './api.js'
import ConfirmDialog from './ConfirmDialog.jsx'
import { usePageTitle } from './usePageTitle.js'
import './CategoriesPage.css'

// Note: matches MAX_NAME in server/routes/categories.js.
const MAX_NAME = 50

/**
 * The Categories screen.
 *
 * Note: hiding this page from other roles only keeps the interface tidy. The server is what
 * blocks them (adding, renaming and archiving answer 403 for anyone who isn't an admin or owner).
 */
function CategoriesPage() {
  usePageTitle('Categories')
  const [categories, setCategories] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false) // a change is saving
  const [renaming, setRenaming] = useState(null) // { id, name } while a row is being renamed
  const [archiving, setArchiving] = useState(null) // the category waiting for "Are you sure?"
  const [showArchived, setShowArchived] = useState(false)

  // ?all=true includes archived categories (admins and owners only).
  useEffect(() => {
    apiFetch('/api/categories?all=true')
      .then((data) => setCategories(data.categories))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [])

  /**
   * Runs one change and puts the server's version of that category into the list. Returns
   * true if it worked. Errors (like "A category with that name already exists") show above
   * the list.
   */
  async function change(request) {
    setBusy(true)
    setError('')
    try {
      const { category } = await request()
      setCategories((list) => [...list.filter((c) => c.id !== category.id), category])
      return true
    } catch (err) {
      setError(err.message)
      return false
    } finally {
      setBusy(false)
    }
  }

  async function add(e) {
    e.preventDefault()
    const ok = await change(() => apiFetch('/api/categories', { method: 'POST', body: { name: newName } }))
    if (ok) setNewName('')
  }

  async function saveRename(e) {
    e.preventDefault()
    const { id, name } = renaming
    const ok = await change(() => apiFetch(`/api/categories/${id}`, { method: 'PATCH', body: { name } }))
    if (ok) setRenaming(null)
  }

  async function setActive(category, active) {
    await change(() => apiFetch(`/api/categories/${category.id}`, { method: 'PATCH', body: { active } }))
    setArchiving(null)
  }

  if (loading) return <p className="hint">Loading categories…</p>

  // A to Z, ignoring capital letters, like the server's own order.
  const sorted = [...categories].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  const active = sorted.filter((c) => c.active)
  const archived = sorted.filter((c) => !c.active)

  return (
    <div className="categories-page">
      <section className="categories-page__card">
        <form className="categories-page__add" onSubmit={add}>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            required
            maxLength={MAX_NAME}
            placeholder="New category name"
            aria-label="New category name"
          />
          <button type="submit" className="primary" disabled={busy}>Add</button>
        </form>

        {error && <p className="error categories-page__error" role="alert">{error}</p>}

        {active.length === 0 ? (
          <p className="hint categories-page__empty">No active categories. Add one above.</p>
        ) : (
          <ul className="categories-page__list">
            {active.map((c) => (
              <li key={c.id} className="categories-page__row">
                {renaming?.id === c.id ? (
                  // Rename in place: the name turns into a text box with Save and Cancel.
                  <form className="categories-page__rename" onSubmit={saveRename}>
                    <input
                      value={renaming.name}
                      onChange={(e) => setRenaming({ ...renaming, name: e.target.value })}
                      required
                      maxLength={MAX_NAME}
                      aria-label={`New name for ${c.name}`}
                      autoFocus
                    />
                    <button type="submit" className="primary" disabled={busy}>Save</button>
                    <button type="button" onClick={() => setRenaming(null)} disabled={busy}>Cancel</button>
                  </form>
                ) : (
                  <>
                    <span className="categories-page__name">{c.name}</span>
                    <span className="categories-page__actions">
                      <button type="button" onClick={() => setRenaming({ id: c.id, name: c.name })} disabled={busy}>
                        Rename
                      </button>
                      <button type="button" className="danger-outline" onClick={() => setArchiving(c)} disabled={busy}>
                        Archive
                      </button>
                    </span>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}

        {archived.length > 0 && (
          <div className="categories-page__archived">
            <button
              type="button"
              className="link"
              aria-expanded={showArchived}
              onClick={() => setShowArchived((open) => !open)}
            >
              {showArchived ? '▾ Hide' : '▸ Show'} archived ({archived.length})
            </button>
            {showArchived && (
              <ul className="categories-page__list">
                {archived.map((c) => (
                  <li key={c.id} className="categories-page__row categories-page__row--archived">
                    <span className="categories-page__name">{c.name}</span>
                    {/* Restoring needs no "Are you sure?": it only brings a choice back. */}
                    <button type="button" onClick={() => setActive(c, true)} disabled={busy}>Restore</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      <aside className="categories-page__about" aria-label="About categories">
        <h2 className="categories-page__about-heading">About categories</h2>
        <p>People pick a category when they ask for help, and staff can change it on the ticket.</p>
        <p>
          Archiving hides a category from new tickets. Tickets that already use it keep it, and you can restore it
          at any time. Nothing is deleted.
        </p>
      </aside>

      <ConfirmDialog
        open={archiving !== null}
        title={`Archive ${archiving?.name ?? ''}?`}
        message="It won't be offered on new tickets. Tickets that already use it keep it, and you can restore it later."
        confirmLabel="Archive"
        danger
        busy={busy}
        onConfirm={() => setActive(archiving, false)}
        onCancel={() => setArchiving(null)}
      />
    </div>
  )
}

export default CategoriesPage
