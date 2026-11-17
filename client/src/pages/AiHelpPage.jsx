// AI help page: every AI request and how it ended, for staff: Get help attempts and Ask IT
// questions.
//
// Fixes never become tickets, so this is where staff see what users solved on their own. Both
// sources use the same five results, so the count cards (which double as filters), the Result
// filter and the Source filter combine: e.g. Source = Ask IT + "Fixed by user" = questions that
// helped. Filters are kept in the address (e.g. /ai-help?result=fixed&type=question), like the
// ticket list. Each request opens in place to show the details, the steps or answer, which
// steps the user tried, and anything the safety check blocked.

import { useCallback, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { apiFetch } from '../lib/api.js'
import CountCards from '../components/CountCards.jsx'
import EmptyState from '../components/EmptyState.jsx'
import RelativeTime from '../components/RelativeTime.jsx'
import { usePageTitle } from '../lib/usePageTitle.js'
import './AiHelpPage.css'

/** Each result, in display order, with the words staff see and its card color. */
const RESULTS = [
  { value: 'fixed', label: 'Fixed by user', tone: 'green' },
  { value: 'still_broken', label: 'Still broken', tone: 'orange' },
  { value: 'escalated', label: 'Sent to technician', tone: 'blue' },
  { value: 'pending', label: 'No answer', tone: 'gray' },
  { value: 'failed', label: 'AI unavailable', tone: 'red' },
]
const resultLabel = (value) => RESULTS.find((r) => r.value === value)?.label ?? value

/** Where a request came from. */
const SOURCES = [
  { value: 'fix', label: 'Get help' },
  { value: 'question', label: 'Ask IT' },
]
const sourceLabel = (value) => SOURCES.find((s) => s.value === value)?.label ?? value

/** The AI help list with count cards, search and a result filter. */
function AiHelpPage() {
  usePageTitle('AI help')
  const [params, setParams] = useSearchParams()
  const [sessions, setSessions] = useState([])
  const [counts, setCounts] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const fetchSessions = useCallback(() => {
    apiFetch('/api/help/sessions')
      .then((data) => {
        setSessions(data.sessions)
        setCounts(data.counts)
      })
      .catch(() => setError("Couldn't load AI help."))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    fetchSessions()
  }, [fetchSessions])

  /** The "Try again" button: back to the loading state, then fetch again. */
  function retry() {
    setLoading(true)
    setError('')
    fetchSessions()
  }

  const q = params.get('q') ?? ''
  const result = params.get('result') ?? ''
  const type = params.get('type') ?? ''
  const filtering = Boolean(q || result || type)

  /** Changes one filter in the address; an empty value removes it. `replace`: no Back step per letter. */
  function setFilter(name, value) {
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

  const text = q.trim().toLowerCase()
  const shown = sessions.filter(
    (s) =>
      (!result || s.outcome === result) &&
      (!type || s.kind === type) &&
      (!text || s.title.toLowerCase().includes(text) || s.user_name.toLowerCase().includes(text))
  )

  // The self-solved rate: fixed out of every attempt that reached an answer. "No answer" and
  // "AI unavailable" are left out, since the user never got to say whether it worked.
  // The cards and the rate follow the Source filter: all requests, or one source.
  const shownCounts = counts[type || 'all'] ?? {}
  const finished = (shownCounts.fixed ?? 0) + (shownCounts.still_broken ?? 0) + (shownCounts.escalated ?? 0)
  const solvedRate = finished ? Math.round(((shownCounts.fixed ?? 0) / finished) * 100) : null

  if (loading) return <p className="hint">Loading AI help…</p>
  if (error) {
    return (
      <p className="error" role="alert">
        {error} <button type="button" onClick={retry}>Try again</button>
      </p>
    )
  }

  return (
    <div className="ai-help">
      <div className="ai-help__main">
        {/* Each card is a toggle: click once to filter to that result, again to show all. */}
        <CountCards
          label="Filter by result"
          cards={RESULTS.map((r) => ({ ...r, count: shownCounts[r.value] ?? 0 }))}
          selected={result}
          onSelect={(value) => setFilter('result', value)}
        />
        {solvedRate !== null && (
          <p className="hint ai-help__rate">
            Users fixed <strong>{solvedRate}%</strong> of answered requests themselves ({shownCounts.fixed} of {finished})
            {type ? ` (${sourceLabel(type)} only)` : ''}.
          </p>
        )}

        {sessions.length === 0 ? (
          <EmptyState message="No one has asked for AI help yet." />
        ) : (
          <>
            <div className="ai-help__toolbar" role="search">
              <label className="ai-help__search">
                Search
                <input
                  type="search"
                  value={q}
                  onChange={(e) => setFilter('q', e.target.value)}
                  placeholder="Problem or person"
                />
              </label>
              <label>
                Result
                <select value={result} onChange={(e) => setFilter('result', e.target.value)}>
                  <option value="">All</option>
                  {RESULTS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
              </label>
              <label>
                Source
                <select value={type} onChange={(e) => setFilter('type', e.target.value)}>
                  <option value="">All</option>
                  {SOURCES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </label>
              {filtering && (
                <button type="button" className="link ai-help__clear" onClick={() => setParams({}, { replace: true })}>
                  Clear filters
                </button>
              )}
            </div>

            <p className="hint ai-help__shown" aria-live="polite">
              {filtering ? `Showing ${shown.length} of ` : ''}
              {sessions.length} {sessions.length === 1 ? 'request' : 'requests'}
            </p>

            {shown.length === 0 ? (
              <EmptyState message="No requests match these filters." />
            ) : (
              <ul className="ai-help__list">
                {shown.map((s) => <SessionItem key={s.id} session={s} />)}
              </ul>
            )}
          </>
        )}
      </div>

      <aside className="ai-help__side" aria-label="About AI help">
        <h2 className="ai-help__side-heading">About AI help</h2>
        <p>
          Two sources: <strong>Get help</strong> (steps for something broken) and <strong>Ask IT</strong> (a quick
          question). Both end in one of these results:
        </p>
        <dl>
          <dt>Fixed by user</dt>
          <dd>A step worked, or the answer helped. No ticket was needed.</dd>
          <dt>Still broken</dt>
          <dd>It didn't help. Get help opens a ticket with the steps tried; Ask IT points to Get help.</dd>
          <dt>Sent to technician</dt>
          <dd>Too risky to self-fix. Get help opens a ticket straight away.</dd>
          <dt>No answer</dt>
          <dd>The person left without saying whether it helped.</dd>
          <dt>AI unavailable</dt>
          <dd>The AI couldn't answer; the person could still open a ticket.</dd>
        </dl>
        <p>Anything the safety check blocked is shown to staff only, so false alarms can be spotted.</p>
      </aside>
    </div>
  )
}

/**
 * One AI help attempt. The summary line is always shown; clicking it opens the details.
 * Why <details>: the browser handles opening, closing, the keyboard and screen readers.
 */
function SessionItem({ session: s }) {
  // When the attempt became a ticket, the ticket's list says which steps were tried.
  const steps = s.steps_tried?.length ? s.steps_tried : s.steps

  return (
    <li>
      <details className="ai-help__item">
        <summary className="ai-help__summary">
          <span className={`ai-help__result ai-help__result--${s.outcome}`}>{resultLabel(s.outcome)}</span>
          {/* Where it came from: its own label, separate from the result. */}
          <span className={`ai-help__source ai-help__source--${s.kind}`}>{sourceLabel(s.kind)}</span>
          <span className="ai-help__title">{s.title}</span>
          {s.ticket_id && <span className="ai-help__ticket">Ticket #{s.ticket_id}</span>}
          <span className="ai-help__meta">
            {s.user_name} · <RelativeTime date={s.created_at} />
          </span>
        </summary>

        <div className="ai-help__details">
          {s.kind === 'question' ? (
            s.answer && (
              <>
                <h3 className="ai-help__steps-heading">Answer given</h3>
                <p className="ai-help__description">{s.answer}</p>
              </>
            )
          ) : (
            <>
              <p className="ai-help__description">{s.description}</p>
              <p className="hint">
                Category: {s.category_name ?? 'Not sure'}
                {s.suggested_category_name && s.suggested_category_name !== s.category_name &&
                  ` (AI suggested ${s.suggested_category_name})`}
              </p>
            </>
          )}

          {s.escalate_reason && <p><strong>Why a technician:</strong> {s.escalate_reason}</p>}

          {/* Staff only: what the AI wrote before the safety check overruled it. */}
          {s.blocked_steps?.length > 0 && (
            <div className="ai-help__blocked">
              <h3 className="ai-help__steps-heading">Blocked by the safety check</h3>
              <ul>
                {s.blocked_steps.map((step, i) => (
                  <li key={i}>
                    <strong>{step.title}</strong>
                    <span className="ai-help__step-detail">{step.detail}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {steps.length > 0 && (
            <>
              <h3 className="ai-help__steps-heading">Steps suggested</h3>
              <ol className="ai-help__steps">
                {steps.map((step, i) => (
                  <li key={i}>
                    <strong>{step.title}</strong>
                    {step.tried === true && <span className="ai-help__tried">Tried</span>}
                    {step.tried === false && <span className="ai-help__not-tried">Not tried</span>}
                    <span className="ai-help__step-detail">{step.detail}</span>
                  </li>
                ))}
              </ol>
            </>
          )}

          {s.ticket_id && <Link className="button-link" to={`/tickets/${s.ticket_id}`}>Open ticket #{s.ticket_id}</Link>}
        </div>
      </details>
    </li>
  )
}

export default AiHelpPage
