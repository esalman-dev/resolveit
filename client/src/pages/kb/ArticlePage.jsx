// Article page: one knowledge base article, at /kb/:id (or /kb/new to write one).
//
// Everyone reads published articles: the steps are a checklist to tick while trying them, and
// the page ends with "Did this fix it?". "That fixed it" is counted like Get help's; "Still
// broken" opens a ticket with the ticked steps listed as tried. Staff edit, publish drafts and
// discard them; admins and owners archive and restore. Publishing is checked on the server: a
// step that mentions something risky (registry, command line…) stops it.

import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router'
import { apiFetch } from '../../lib/api.js'
import ConfirmDialog from '../../components/ConfirmDialog.jsx'
import EmptyState from '../../components/EmptyState.jsx'
import RelativeTime from '../../components/RelativeTime.jsx'
import { isAdminOrOwner, isStaff } from '../../lib/roles.js'
import { usePageTitle } from '../../lib/usePageTitle.js'
import './KnowledgeBase.css'

const MAX_STEPS = 7 // matches MAX_STEPS in server/services/guardrails.js
const EMPTY = { title: '', problem: '', also_called: '', steps: [{ title: '', detail: '' }], if_still_broken: '', category_id: null }

/** Turns the editor's "wifi, no internet" box into a list of phrases. */
const phrases = (text) => text.split(',').map((p) => p.trim()).filter(Boolean)

/** The article page. */
function ArticlePage({ currentUser }) {
  const { id } = useParams()
  const isNew = id === 'new'
  const navigate = useNavigate()
  const location = useLocation()
  const staff = isStaff(currentUser.role)
  const admin = isAdminOrOwner(currentUser.role)
  const [article, setArticle] = useState(null)
  const [error, setError] = useState('')
  // "Write with AI" opens its new draft straight in the editor.
  const [editing, setEditing] = useState(isNew || Boolean(location.state?.edit))
  const [form, setForm] = useState(EMPTY)
  const [categories, setCategories] = useState([])
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState('')
  const [confirm, setConfirm] = useState(null) // 'discard' | 'archive' while asking "Are you sure?"
  const [ticked, setTicked] = useState([]) // step numbers ticked off, on this screen only
  const [outcome, setOutcome] = useState(null) // null | 'fixed' | 'broken' (the "Still broken" box is open)
  const [details, setDetails] = useState('') // "Anything IT should know?"
  usePageTitle(isNew ? 'Write an article' : (article?.title ?? 'Article'))

  useEffect(() => {
    if (isNew) return
    let cancelled = false
    apiFetch(`/api/kb/${id}`)
      .then((d) => {
        if (cancelled) return
        setArticle(d.article)
        if (location.state?.edit) setForm(formFrom(d.article))
      })
      .catch((err) => !cancelled && setError(err.message))
    return () => {
      cancelled = true
    }
    // Why only id: location.state is read once, when the page opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, isNew])

  useEffect(() => {
    if (staff) apiFetch('/api/categories').then((d) => setCategories(d.categories)).catch(() => {})
  }, [staff])

  /** The editor's fields for an article. */
  function formFrom(a) {
    return {
      title: a.title,
      problem: a.problem,
      also_called: a.also_called.join(', '),
      steps: a.steps.map((s) => ({ ...s })),
      if_still_broken: a.if_still_broken,
      category_id: a.category_id,
    }
  }

  /** Opens the editor with the article's current text. */
  function startEditing() {
    setForm(formFrom(article))
    setActionError('')
    setEditing(true)
  }

  /** Runs a request that changes the article, and shows the result or the server's reason. */
  async function act(path, options) {
    setBusy(true)
    setActionError('')
    try {
      const data = await apiFetch(path, options)
      if (data?.article) setArticle(data.article)
      return data ?? {}
    } catch (err) {
      setActionError(err.message) // e.g. "The article mentions registry edits…"
      return null
    } finally {
      setBusy(false)
    }
  }

  async function save(event) {
    event.preventDefault()
    const body = { ...form, also_called: phrases(form.also_called), steps: form.steps.filter((s) => s.title.trim()) }
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

  const toggleStep = (i) => setTicked((t) => (t.includes(i) ? t.filter((j) => j !== i) : [...t, i]))

  /** "That fixed it": counted as solved by this article, like Get help's button. */
  async function fixed() {
    const body = { article_id: article.id, title: article.title, description: 'Fixed with the knowledge base article.' }
    if (await act('/api/help/article-fixed', { method: 'POST', body })) setOutcome('fixed')
  }

  /** "Send to IT": opens a ticket with the ticked steps as tried, then shows it. */
  async function sendToIt(event) {
    event.preventDefault()
    const body = { article_id: article.id, details, tried: [...ticked].sort((a, b) => a - b) }
    const data = await act('/api/help/article-broken', { method: 'POST', body })
    if (data) navigate(`/tickets/${data.ticket_id}`, { state: { created: true } })
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
          Also called
          <input value={form.also_called} onChange={(e) => setForm({ ...form, also_called: e.target.value })} placeholder="Other words people use, separated by commas: outlook offline, email not arriving" />
          <span className="hint">Searched with the title, so people find it in their own words.</span>
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
                <textarea aria-label={`Step ${i + 1} detail`} value={step.detail} onChange={(e) => setStep(i, 'detail', e.target.value)} maxLength={600} rows={4} placeholder="Exactly where to click, and what you'll see when it worked." />
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

        <label>
          If it still doesn't work
          <textarea value={form.if_still_broken} onChange={(e) => setForm({ ...form, if_still_broken: e.target.value })} maxLength={1000} rows={3} placeholder="What to note down for IT (the exact error, when it started), then use Get help." />
        </label>

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
  const published = article.status === 'published'
  // Back to the list this article is in: a draft to Drafts, an archived one to Archived.
  const back = draft ? ['/kb?tab=draft', 'Drafts'] : published ? ['/kb', 'Knowledge base'] : ['/kb?tab=archived', 'Archived']
  return (
    <>
    <Link className="button-link kb-article__back" to={back[0]}>
      ← {back[1]}
    </Link>
    <article className="kb-article">
      {!published && (
        <p className={article.flagged ? 'kb-article__banner kb-article__banner--flagged' : 'kb-article__banner'}>
          {draft ? 'Draft: only staff can see this.' : 'Archived: hidden from everyone but staff.'}
          {article.flagged && ' ⚠ The article mentions something only a technician should do. Edit it before publishing.'}
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
      {article.also_called.length > 0 && <p className="hint kb-article__also">Also called: {article.also_called.join(', ')}</p>}

      <h2 className="kb-article__heading">Try these steps</h2>
      <p className="hint kb-article__tick-hint">Tick each one as you go.</p>
      <ol className="kb-article__steps">
        {article.steps.map((step, i) => (
          <li key={i} className={ticked.includes(i) ? 'kb-step kb-step--done' : 'kb-step'}>
            <label className="kb-step__label">
              <input type="checkbox" checked={ticked.includes(i)} onChange={() => toggleStep(i)} />
              <span>
                <span className="kb-step__number">{i + 1}.</span> <strong>{step.title}</strong>
                {step.detail && <span className="kb-step__detail">{step.detail}</span>}
              </span>
            </label>
          </li>
        ))}
      </ol>

      {article.if_still_broken && (
        <section className="kb-article__fallback" aria-labelledby="kb-fallback">
          <h2 id="kb-fallback" className="kb-article__heading">If it still doesn't work</h2>
          <p>{article.if_still_broken}</p>
        </section>
      )}

      {published && (
        <div className="kb-article__outcome" aria-live="polite">
          {outcome === 'fixed' ? (
            <p className="kb-article__done">Glad that worked.</p>
          ) : outcome === 'broken' ? (
            <form className="kb-article__broken" onSubmit={sendToIt}>
              <label>
                Anything IT should know? (optional)
                <textarea value={details} onChange={(e) => setDetails(e.target.value)} rows={3} maxLength={5000} placeholder="The exact error, when it started, what changed…" />
              </label>
              <p className="hint">
                IT will see the article and which steps you ticked as tried ({ticked.length} of {article.steps.length}).
              </p>
              {actionError && <p className="error" role="alert">{actionError}</p>}
              <div className="kb-article__buttons">
                <button type="button" onClick={() => setOutcome(null)} disabled={busy}>Cancel</button>
                <button type="submit" className="primary" disabled={busy}>{busy ? 'Sending…' : 'Send to IT'}</button>
              </div>
            </form>
          ) : (
            <>
              <span className="kb-article__question">Did this fix it?</span>
              <button type="button" className="primary" onClick={fixed} disabled={busy}>That fixed it</button>
              <button type="button" onClick={() => setOutcome('broken')} disabled={busy}>Still broken</button>
              {actionError && <p className="error" role="alert">{actionError}</p>}
            </>
          )}
        </div>
      )}

      {staff && (
        <div className="kb-article__staff">
          {actionError && !published && <p className="error" role="alert">{actionError}</p>}
          <div className="kb-article__buttons">
            <button type="button" className="link" onClick={startEditing} disabled={busy}>Edit</button>
            {draft && <button type="button" className="danger-outline" onClick={() => setConfirm('discard')} disabled={busy}>Discard draft</button>}
            {draft && (
              <button type="button" className="primary" onClick={() => act(`/api/kb/${id}/publish`, { method: 'POST' })} disabled={busy}>
                Publish
              </button>
            )}
            {admin && published && (
              <button type="button" className="danger-outline" onClick={() => setConfirm('archive')} disabled={busy}>Archive</button>
            )}
            {admin && article.status === 'archived' && (
              <button type="button" className="primary" onClick={() => act(`/api/kb/${id}/publish`, { method: 'POST' })} disabled={busy}>
                Restore
              </button>
            )}
          </div>
          <p className="hint">
            {article.helpful_count} fixed it · {article.not_helpful_count} still broken
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
    </>
  )
}

export default ArticlePage
