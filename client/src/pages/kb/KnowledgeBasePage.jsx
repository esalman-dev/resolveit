// Knowledge base page: search and read how-to articles. Staff also see drafts (usually written
// by the AI from a resolved ticket) and archived articles, and can write one by hand.
//
// The search words and the tab are kept in the address (/kb?q=outlook, /kb?tab=draft).

import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
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
]

/** The knowledge base list. */
function KnowledgeBasePage({ currentUser }) {
  usePageTitle('Knowledge base')
  const staff = isStaff(currentUser.role)
  const [params, setParams] = useSearchParams()
  const tab = staff && TABS.some((t) => t.value === params.get('tab')) ? params.get('tab') : 'published'
  const q = params.get('q') ?? ''
  const [typed, setTyped] = useState(q) // the box updates the address after a short pause
  const [data, setData] = useState(null)
  const [error, setError] = useState('')

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
    let cancelled = false
    const query = new URLSearchParams({ status: tab, ...(q && tab === 'published' ? { q } : {}) })
    apiFetch(`/api/kb?${query}`)
      .then((d) => !cancelled && setData(d))
      .catch((err) => !cancelled && setError(err.message))
    return () => {
      cancelled = true
    }
  }, [tab, q])

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
          <Link className="button-link kb__new" to="/kb/new">
            Write an article
          </Link>
        )}
      </div>

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

      {!data ? (
        <p className="hint">Loading articles…</p>
      ) : data.articles.length === 0 ? (
        <EmptyState
          message={
            q && tab === 'published'
              ? `No articles match "${q}". Try other words, or use Get help.`
              : tab === 'draft'
                ? 'No drafts. When a ticket is resolved, the AI can draft one from the fix.'
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
                  {a.status === 'published' && a.helpful_count > 0 && <span>{a.helpful_count} found this helpful</span>}
                  {a.status === 'draft' && <span>Drafted <RelativeTime date={a.created_at} />{a.source_ticket_id ? ` from ticket #${a.source_ticket_id}` : ''}</span>}
                  {a.flagged && <span className="kb__flag">⚠ A step needs checking</span>}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default KnowledgeBasePage
