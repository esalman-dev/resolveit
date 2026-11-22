// Knowledge base page: search, browse by category and read how-to articles. Staff also see
// drafts and archived articles, write one by hand or with the AI ("Write with AI"), and can ask
// the AI which common problems still have no article ("Missing articles").
//
// The search words, category and tab are kept in the address (/kb?q=outlook, /kb?category=3,
// /kb?tab=draft).

import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { apiFetch } from '../../lib/api.js'
import EmptyState from '../../components/EmptyState.jsx'
import RelativeTime from '../../components/RelativeTime.jsx'
import { isStaff } from '../../lib/roles.js'
import { usePageTitle } from '../../lib/usePageTitle.js'
import './KnowledgeBase.css'

const TABS = [
  { value: 'published', label: 'Published' },
  { value: 'draft', label: 'Drafts' },
  { value: 'archived', label: 'Archived' },
  { value: 'missing', label: 'Missing articles' },
]

/** The knowledge base list. */
function KnowledgeBasePage({ currentUser }) {
  usePageTitle('Knowledge base')
  const staff = isStaff(currentUser.role)
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const tab = staff && TABS.some((t) => t.value === params.get('tab')) ? params.get('tab') : 'published'
  const q = params.get('q') ?? ''
  const category = params.get('category') ?? ''
  const [typed, setTyped] = useState(q) // the box updates the address after a short pause
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [writing, setWriting] = useState(null) // "Write with AI": null (closed) or { problem, busy, error, covered }

  // Why the pause: searching on every key press would send a request per letter.
  // Note: only when the text differs from the address, or each update would start another.
  useEffect(() => {
    if (typed.trim() === q) return
    const timer = setTimeout(() => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current)
          if (typed.trim()) next.set('q', typed.trim())
          else next.delete('q')
          return next
        },
        { replace: true }
      )
    }, 300)
    return () => clearTimeout(timer)
  }, [typed, q, setParams])

  useEffect(() => {
    if (tab === 'missing') return // that tab loads only when asked (it's an AI call)
    let cancelled = false
    const published = tab === 'published'
    const query = new URLSearchParams({ status: tab, ...(q && published ? { q } : {}), ...(category && published ? { category } : {}) })
    apiFetch(`/api/kb?${query}`)
      .then((d) => !cancelled && setData(d))
      .catch((err) => !cancelled && setError(err.message))
    return () => {
      cancelled = true
    }
  }, [tab, q, category])

  /** Sets one value in the address (or removes it when empty), keeping the others. */
  function setParam(name, value) {
    setParams(
      (current) => {
        const next = new URLSearchParams(current)
        if (value) next.set(name, value)
        else next.delete(name)
        return next
      },
      { replace: true }
    )
  }

  /**
   * Asks the AI to draft an article for a problem. A new draft opens in the editor; an article
   * that already covers it is shown instead. Shared by "Write with AI" and "Missing articles".
   */
  async function draftWithAi(problem) {
    setWriting({ problem, busy: true, error: '', covered: null })
    try {
      const result = await apiFetch('/api/kb/write', { method: 'POST', body: { problem } })
      if (result.article) return navigate(`/kb/${result.article.id}`, { state: { edit: true } })
      setWriting({ problem, busy: false, error: '', covered: result.covered })
    } catch (err) {
      setWriting({ problem, busy: false, error: err.message, covered: null })
    }
  }

  if (error) return <p className="error" role="alert">{error}</p>

  return (
    <div className="kb">
      <div className="kb__top">
        {tab === 'published' && (
          <label className="kb__search">
            Search articles
            <input type="search" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="e.g. Outlook offline, printer" />
          </label>
        )}
        {staff && (
          <div className="kb__write-buttons">
            <button type="button" className="link" onClick={() => setWriting(writing ? null : { problem: '', busy: false, error: '', covered: null })}>
              Write with AI
            </button>
            <Link className="button-link" to="/kb/new">
              Write an article
            </Link>
          </div>
        )}
      </div>

      {staff && writing && (
        <WriteWithAi
          state={writing}
          onChange={(problem) => setWriting({ ...writing, problem, error: '', covered: null })}
          onSubmit={() => draftWithAi(writing.problem)}
          onClose={() => setWriting(null)}
        />
      )}

      {staff && (
        <div className="kb__tabs" role="group" aria-label="Show">
          {TABS.map((t) => (
            <button
              key={t.value}
              type="button"
              aria-pressed={tab === t.value}
              onClick={() => setParams(t.value === 'published' ? {} : { tab: t.value }, { replace: true })}
            >
              {t.label}
              {t.value === 'draft' && data?.counts?.drafts > 0 && <span className="kb__count">{data.counts.drafts}</span>}
            </button>
          ))}
        </div>
      )}

      {tab === 'published' && data?.categories?.length > 0 && (
        // Browse by category: one pressed at a time, "All" clears it.
        <div className="kb__categories" role="group" aria-label="Category">
          <button type="button" aria-pressed={!category} onClick={() => setParam('category', '')}>All</button>
          {data.categories.map((c) => (
            <button key={c.id} type="button" aria-pressed={category === String(c.id)} onClick={() => setParam('category', String(c.id))}>
              {c.name} <span className="kb__category-count">{c.count}</span>
            </button>
          ))}
        </div>
      )}

      {tab === 'missing' ? (
        <MissingArticles onDraft={draftWithAi} drafting={writing?.busy ? writing.problem : null} />
      ) : !data ? (
        <p className="hint">Loading articles…</p>
      ) : data.articles.length === 0 ? (
        <EmptyState
          message={
            q && tab === 'published'
              ? `No articles match "${q}". Try other words, or use Get help.`
              : tab === 'draft'
                ? 'No drafts. When a ticket is resolved, the AI can draft one from the fix, or use Write with AI.'
                : 'No articles here yet.'
          }
        />
      ) : (
        <ul className="kb__list">
          {data.articles.map((a) => (
            <li key={a.id}>
              {/* The whole card is the link, like the dashboard's "Needs attention". */}
              <Link className={a.flagged ? 'kb__item kb__item--flagged' : 'kb__item'} to={`/kb/${a.id}`}>
                <span className="kb__item-title">{a.title}</span>
                <span className="kb__item-problem">{a.problem}</span>
                <span className="kb__item-meta">
                  {a.category_name && <span>{a.category_name}</span>}
                  {a.status === 'published' && a.helpful_count > 0 && <span>Fixed it for {a.helpful_count}</span>}
                  {a.status === 'draft' && <span>Drafted <RelativeTime date={a.created_at} />{a.source_ticket_id ? ` from ticket #${a.source_ticket_id}` : ''}</span>}
                  {a.flagged && <span className="kb__flag">⚠ Needs checking</span>}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** The "Write with AI" box: a problem in, a draft (or "already covered") out. */
function WriteWithAi({ state, onChange, onSubmit, onClose }) {
  return (
    <form
      className="kb__write"
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit()
      }}
    >
      <label>
        What problem should the article cover?
        <input value={state.problem} onChange={(e) => onChange(e.target.value)} required maxLength={300} placeholder="e.g. VPN won't connect from home" autoFocus />
      </label>
      <p className="hint">The AI drafts a full article from standard fixes. It opens as a draft for you to check before publishing.</p>
      {state.error && <p className="error" role="alert">{state.error}</p>}
      {state.covered && (
        <p className="kb__covered" role="status">
          Already covered: <Link to={`/kb/${state.covered.id}`}>{state.covered.title}</Link>
        </p>
      )}
      <div className="kb__write-actions">
        <button type="button" onClick={onClose} disabled={state.busy}>Cancel</button>
        <button type="submit" className="primary" disabled={state.busy || !state.problem.trim()}>
          {state.busy ? 'Drafting…' : 'Draft it'}
        </button>
      </div>
    </form>
  )
}

/**
 * The "Missing articles" tab: the AI groups the last 30 days of requests no article helped with.
 * Loaded only when the button is pressed, because each press is an AI call.
 * @param onDraft drafts an article for a problem ("Draft with AI")
 * @param drafting the problem being drafted right now, or null
 */
function MissingArticles({ onDraft, drafting }) {
  const [result, setResult] = useState(null) // { groups, request_count }
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function find() {
    setBusy(true)
    setError('')
    try {
      setResult(await apiFetch('/api/kb/missing', { method: 'POST' }))
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="kb__missing" aria-labelledby="kb-missing">
      <h2 id="kb-missing" className="kb__missing-heading">Problems that keep coming up with no article</h2>
      <p className="hint">Looks at the last 30 days of Get help requests and tickets that no article fixed.</p>
      <button type="button" className="primary" onClick={find} disabled={busy}>
        {busy ? 'Looking…' : result ? 'Look again' : 'Find missing articles'}
      </button>
      {error && <p className="error" role="alert">{error}</p>}
      {result && result.groups.length === 0 && (
        <p className="hint" role="status">
          {result.request_count < 3 ? 'Not enough recent requests to spot a pattern yet.' : 'Nothing common is missing. The articles cover what people ask about.'}
        </p>
      )}
      {result?.groups.length > 0 && (
        <ul className="kb__list">
          {result.groups.map((g) => (
            <li key={g.problem} className="kb__gap">
              <span className="kb__item-title">{g.problem}</span>
              <span className="kb__item-meta">
                <span>Came up {g.count} {g.count === 1 ? 'time' : 'times'}</span>
                {g.examples.length > 0 && <span>e.g. "{g.examples.join('", "')}"</span>}
              </span>
              <button type="button" className="link" onClick={() => onDraft(g.problem)} disabled={drafting !== null}>
                {drafting === g.problem ? 'Drafting…' : 'Draft with AI'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export default KnowledgeBasePage
