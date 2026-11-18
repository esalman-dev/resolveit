// Article page: one knowledge base article, at /kb/:id (or /kb/new to write one).
//
// Everyone reads published articles and can say whether one helped. Staff edit, publish drafts
// and discard them; admins and owners archive and restore. Publishing is checked on the server:
// a step that mentions something risky (registry, command line…) stops it.

import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { apiFetch } from '../../lib/api.js'
import ConfirmDialog from '../../components/ConfirmDialog.jsx'
import EmptyState from '../../components/EmptyState.jsx'
import RelativeTime from '../../components/RelativeTime.jsx'
import { isAdminOrOwner, isStaff } from '../../lib/roles.js'
import { usePageTitle } from '../../lib/usePageTitle.js'
import './KnowledgeBase.css'

const MAX_STEPS = 7 // matches MAX_STEPS in server/services/guardrails.js
const EMPTY = { title: '', problem: '', steps: [{ title: '', detail: '' }], category_id: null }

/** The article page. */
function ArticlePage({ currentUser }) {
  const { id } = useParams()
  const isNew = id === 'new'
  const navigate = useNavigate()
  const staff = isStaff(currentUser.role)
  const admin = isAdminOrOwner(currentUser.role)
  const [article, setArticle] = useState(null)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(isNew)
  const [form, setForm] = useState(EMPTY)
  const [categories, setCategories] = useState([])
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState('')
  const [confirm, setConfirm] = useState(null) // 'discard' | 'archive' while asking "Are you sure?"
  const [feedback, setFeedback] = useState(null) // true / false once answered
  usePageTitle(isNew ? 'Write an article' : (article?.title ?? 'Article'))

  useEffect(() => {
    if (isNew) return
    let cancelled = false
    apiFetch(`/api/kb/${id}`)
      .then((d) => !cancelled && setArticle(d.article))
      .catch((err) => !cancelled && setError(err.message))
    return () => {
      cancelled = true
    }
  }, [id, isNew])

  useEffect(() => {
    if (staff) apiFetch('/api/categories').then((d) => setCategories(d.categories)).catch(() => {})
  }, [staff])

  /** Opens the editor with the article's current text. */
  function startEditing() {
    setForm({ title: article.title, problem: article.problem, steps: article.steps.map((s) => ({ ...s })), category_id: article.category_id })
    setActionError('')
    setEditing(true)
  }

  /** Runs a request that changes the article, and shows the result or the server's reason. */
  async function act(path, options) {
    setBusy(true)
    setActionError('')
    try {
      const data = await apiFetch(path, options)
      if (data.article) setArticle(data.article)
      return data
    } catch (err) {
      setActionError(err.message) // e.g. "A step mentions registry edits…"
      return null
    } finally {
      setBusy(false)
    }
  }

  async function save(event) {
    event.preventDefault()
    const body = { ...form, steps: form.steps.filter((s) => s.title.trim()) }
    const data = isNew ? await act('/api/kb', { method: 'POST', body }) : await act(`/api/kb/${id}`, { method: 'PATCH', body })
    if (!data) return
    setEditing(false)
    if (isNew) navigate(`/kb/${data.article.id}`, { replace: true })
  }

  async function discard() {
    const done = await act(`/api/kb/${id}`, { method: 'DELETE' })
    setConfirm(null)
    if (done) navigate('/kb?tab=draft', { replace: true })
  }

  async function sendFeedback(helpful) {
    setFeedback(helpful)
    await apiFetch(`/api/kb/${id}/feedback`, { method: 'POST', body: { helpful } }).catch(() => {})
  }

  // --- Step editing ---
  const setStep = (i, field, value) => setForm((f) => ({ ...f, steps: f.steps.map((s, j) => (j === i ? { ...s, [field]: value } : s)) }))
  const addStep = () => setForm((f) => ({ ...f, steps: [...f.steps, { title: '', detail: '' }] }))
  const removeStep = (i) => setForm((f) => ({ ...f, steps: f.steps.filter((_, j) => j !== i) }))
  const moveStep = (i, by) =>
    setForm((f) => {
      const steps = [...f.steps]
      ;[steps[i], steps[i + by]] = [steps[i + by], steps[i]]
      return { ...f, steps }
    })

  if (error) return <EmptyState message={error} actionLabel="Back to the knowledge base" actionTo="/kb" />
  if (!isNew && !article) return <p className="hint">Loading the article…</p>

  // --- The editor ---
  if (editing) {
    return (
      <form className="kb-article kb-article--editing" onSubmit={save}>
        <label>
          Title
          <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required maxLength={200} placeholder="What the person sees, e.g. Outlook says Working Offline" />
        </label>
        <label>
          Problem
          <textarea value={form.problem} onChange={(e) => setForm({ ...form, problem: e.target.value })} required maxLength={2000} rows={3} placeholder="What the person notices, in a sentence or two." />
        </label>
        <label>
          Category
          <select value={form.category_id ?? ''} onChange={(e) => setForm({ ...form, category_id: e.target.value ? Number(e.target.value) : null })}>
            <option value="">None</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>

        <fieldset className="kb-steps-edit">
          <legend>Steps (easiest first)</legend>
          {form.steps.map((step, i) => (
            <div key={i} className="kb-steps-edit__step">
              <span className="kb-steps-edit__number">{i + 1}</span>
              <div className="kb-steps-edit__fields">
                <input aria-label={`Step ${i + 1} title`} value={step.title} onChange={(e) => setStep(i, 'title', e.target.value)} maxLength={120} placeholder="Short action, e.g. Turn off Work Offline" />
                <textarea aria-label={`Step ${i + 1} detail`} value={step.detail} onChange={(e) => setStep(i, 'detail', e.target.value)} maxLength={600} rows={2} placeholder="How to do it, in plain words." />
              </div>
              <div className="kb-steps-edit__tools">
                <button type="button" className="link" onClick={() => moveStep(i, -1)} disabled={i === 0} aria-label={`Move step ${i + 1} up`}>↑</button>
                <button type="button" className="link" onClick={() => moveStep(i, 1)} disabled={i === form.steps.length - 1} aria-label={`Move step ${i + 1} down`}>↓</button>
                <button type="button" className="link" onClick={() => removeStep(i)} disabled={form.steps.length === 1} aria-label={`Remove step ${i + 1}`}>✕</button>
              </div>
            </div>
          ))}
          {form.steps.length < MAX_STEPS && (
            <button type="button" className="link" onClick={addStep}>+ Add a step</button>
          )}
        </fieldset>

        {actionError && <p className="error" role="alert">{actionError}</p>}
        <div className="kb-article__buttons">
          <button type="button" onClick={() => (isNew ? navigate('/kb') : setEditing(false))} disabled={busy}>Cancel</button>
          <button type="submit" className="primary" disabled={busy}>{busy ? 'Saving…' : isNew ? 'Save as draft' : 'Save'}</button>
        </div>
      </form>
    )
  }

  // --- Reading ---
  const draft = article.status === 'draft'
  return (
    <article className="kb-article">
      {article.status !== 'published' && (
        <p className={article.flagged ? 'kb-article__banner kb-article__banner--flagged' : 'kb-article__banner'}>
          {draft ? 'Draft: only staff can see this.' : 'Archived: hidden from everyone but staff.'}
          {article.flagged && ' ⚠ A step mentions something only a technician should do. Edit it before publishing.'}
          {article.source_ticket_id && (
            <> Drafted from <Link to={`/tickets/${article.source_ticket_id}`}>ticket #{article.source_ticket_id}</Link>.</>
          )}
        </p>
      )}

      <div className="kb-article__head">
        {article.category_name && <span className="kb-article__category">{article.category_name}</span>}
        <span className="hint">
          {article.published_at ? <>Published <RelativeTime date={article.published_at} /></> : <>Drafted <RelativeTime date={article.created_at} /></>}
        </span>
      </div>
      <p className="kb-article__problem">{article.problem}</p>

      <h2 className="kb-article__heading">Try these steps</h2>
      <ol className="kb-article__steps">
        {article.steps.map((step, i) => (
          <li key={i}>
            <strong>{step.title}</strong>
            {step.detail && <p>{step.detail}</p>}
          </li>
        ))}
      </ol>

      {article.status === 'published' && (
        <div className="kb-article__feedback" aria-live="polite">
          {feedback === null ? (
            <>
              <span>Was this helpful?</span>
              <button type="button" onClick={() => sendFeedback(true)}>Yes</button>
              <button type="button" onClick={() => sendFeedback(false)}>No</button>
            </>
          ) : feedback ? (
            <span>Glad it helped.</span>
          ) : (
            <span>
              Sorry about that. <Link className="button-link" to="/get-help">Get help</Link>
            </span>
          )}
        </div>
      )}

      {staff && (
        <div className="kb-article__staff">
          {actionError && <p className="error" role="alert">{actionError}</p>}
          <div className="kb-article__buttons">
            <button type="button" className="link" onClick={startEditing} disabled={busy}>Edit</button>
            {draft && <button type="button" className="danger-outline" onClick={() => setConfirm('discard')} disabled={busy}>Discard draft</button>}
            {draft && (
              <button type="button" className="primary" onClick={() => act(`/api/kb/${id}/publish`, { method: 'POST' })} disabled={busy}>
                Publish
              </button>
            )}
            {admin && article.status === 'published' && (
              <button type="button" className="danger-outline" onClick={() => setConfirm('archive')} disabled={busy}>Archive</button>
            )}
            {admin && article.status === 'archived' && (
              <button type="button" className="primary" onClick={() => act(`/api/kb/${id}/publish`, { method: 'POST' })} disabled={busy}>
                Restore
              </button>
            )}
          </div>
          <p className="hint">
            {article.helpful_count} found it helpful · {article.not_helpful_count} didn't
            {article.published_by_name && ` · published by ${article.published_by_name}`}
          </p>
        </div>
      )}

      <ConfirmDialog
        open={confirm !== null}
        title={confirm === 'discard' ? 'Discard this draft?' : 'Archive this article?'}
        message={
          confirm === 'discard'
            ? 'The draft will be deleted. This cannot be undone.'
            : 'It will be hidden from everyone and Get help will stop suggesting it. You can restore it later.'
        }
        confirmLabel={confirm === 'discard' ? 'Discard' : 'Archive'}
        danger
        busy={busy}
        onConfirm={() => (confirm === 'discard' ? discard() : act(`/api/kb/${id}/archive`, { method: 'POST' }).then(() => setConfirm(null)))}
        onCancel={() => setConfirm(null)}
      />
    </article>
  )
}

export default ArticlePage
