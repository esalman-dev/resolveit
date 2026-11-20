// Get help page: where someone describes a problem, tries a few safe steps, and only then
// opens a ticket if they still need one.
//
// Everyone sees it, and it's a regular user's home page. The flow:
//   1. form: describe the problem → "Get help" asks the server (and its AI) for steps
//   2. steps: try them, tick the ones tried → "That fixed it" (done) or "Still broken" (a ticket
//      is opened with the steps tried, and the user lands on it)
//   Or, at step 1: "needs a technician" (the server opened a ticket straight away).
// When automatic help isn't available (switched off, down, or a daily limit reached), the same
// form sends a plain ticket instead, so asking for help never breaks.
//
// Nothing is lost by leaving: each request has its own address (/get-help?request=12), so it can
// be reopened without asking the AI again; unfinished ones are listed at the top; and the unsent
// form is kept as a draft in this browser (see lib/drafts.js).
//
// There's no priority field: users can't set one; staff and the AI's suggestion do.

import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useOutletContext, useSearchParams } from 'react-router'
import { apiFetch } from '../lib/api.js'
import { clearDraft, loadDraft, saveDraft } from '../lib/drafts.js'
import { usePageTitle } from '../lib/usePageTitle.js'
import RelativeTime from '../components/RelativeTime.jsx'
import '../components/StatusDot.css' // the status dot colors
import { STATUS_LABELS } from '../lib/presence.js'
import { AttachmentList, AttachmentPicker } from '../components/Attachments.jsx'
import { useAttachmentPicker } from '../lib/attachments.js'
import KnownIssues from '../components/KnownIssues.jsx'
import './GetHelpPage.css'

// Note: these match MAX_TITLE and MAX_DESCRIPTION in server/routes/tickets.js. The server
// checks them too; these just stop people typing more than will be accepted.
const MAX_TITLE = 200
const MAX_DESCRIPTION = 5000

/** The Get help form, the AI's steps, and what happens after them. */
function GetHelpPage({ currentUser }) {
  usePageTitle('Get help')
  const { presence, outages } = useOutletContext() // who's online and the open outages, from the app shell
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const requestId = params.get('request') // the request being shown, if any
  const [categories, setCategories] = useState([])
  const [categoriesError, setCategoriesError] = useState('')

  // The form starts from the saved draft, unless the address names a request to reopen.
  const [initialDraft] = useState(() => (requestId ? null : loadDraft(currentUser.id)))
  const [title, setTitle] = useState(initialDraft?.title ?? '')
  const [categoryId, setCategoryId] = useState(initialDraft?.categoryId ?? '') // '' means "Not sure"
  const [description, setDescription] = useState(initialDraft?.description ?? '')
  const [draftRestored, setDraftRestored] = useState(Boolean(initialDraft))
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false) // stops a double click sending twice

  const [phase, setPhase] = useState('form') // 'form' | 'articles' | 'steps' | 'fixed' | 'escalated'
  const [session, setSession] = useState(null) // { id, steps } while steps are shown
  const [tried, setTried] = useState([]) // numbers of the steps ticked "I tried this"
  const [escalation, setEscalation] = useState(null) // { ticketId, reason }
  const [matches, setMatches] = useState([]) // knowledge base articles that matched, shown before the AI
  const [fallback, setFallback] = useState('') // why automatic help is off; the form then sends a plain ticket
  const headingRef = useRef(null) // the heading of whatever just appeared, for keyboard focus
  const picker = useAttachmentPicker() // files being added to the form
  const [sentFiles, setSentFiles] = useState([]) // the files of the request on screen, once sent
  const [unfinished, setUnfinished] = useState([]) // the user's requests still waiting for an answer
  const [loadingRequest, setLoadingRequest] = useState(false)
  const shownId = useRef(null) // the request on screen, so the address change it causes doesn't reload it

  // The category list, archived ones left out (the server does that for non-admins and by default).
  useEffect(() => {
    apiFetch('/api/categories')
      .then((data) => setCategories(data.categories))
      .catch(() => setCategoriesError("Couldn't load categories. You can still send the form without one."))
  }, [])

  // Keeps the unsent form as a draft while it's being written.
  useEffect(() => {
    if (phase === 'form' && !requestId) saveDraft(currentUser.id, { title, description, categoryId })
  }, [title, description, categoryId, phase, requestId, currentUser.id])

  // The "unfinished requests" list, refreshed whenever the empty form is showing.
  useEffect(() => {
    if (phase !== 'form' || requestId) return
    apiFetch('/api/help/mine')
      .then((data) => setUnfinished(data.sessions))
      .catch(() => setUnfinished([])) // only a convenience: the form works without it
  }, [phase, requestId])

  // Why: new content appears below the form. Moving the focus to its heading means keyboard
  // and screen reader users land on it, instead of staying on a now-locked form.
  useEffect(() => {
    if (phase !== 'form') headingRef.current?.focus()
  }, [phase])

  const problem = () => ({
    title,
    description,
    category_id: categoryId ? Number(categoryId) : null,
    attachment_ids: picker.ids,
  })

  /** Puts a request on screen, wherever it got to: steps waiting, fixed, or with a technician. */
  function showRequest(s) {
    if (s.outcome === 'still_broken') return navigate(`/tickets/${s.ticket_id}`, { replace: true })
    shownId.current = String(s.id)
    setTitle(s.title)
    setDescription(s.description)
    setCategoryId(s.category_id ? String(s.category_id) : '')
    setSentFiles(s.attachments ?? [])
    setDraftRestored(false)
    setError('')
    if (s.outcome === 'pending') {
      setSession(s)
      setTried([])
      setPhase('steps')
    } else if (s.outcome === 'escalated') {
      setEscalation({ ticketId: s.ticket_id, reason: s.escalate_reason })
      setPhase('escalated')
    } else if (s.outcome === 'fixed') {
      setPhase('fixed')
    } else {
      setParams({}, { replace: true }) // failed: back to the form, with the text filled in
    }
  }

  /** Remembers which request is showing and puts its number in the address. */
  function rememberRequest(id) {
    shownId.current = String(id)
    setParams({ request: String(id) }, { replace: true })
  }

  /** "Get help": asks for steps, or sends a plain ticket when automatic help is off. */
  async function handleSubmit(e) {
    e.preventDefault() // stop the browser's default full-page form submit
    setError('')
    setBusy(true)
    if (fallback) return submitTicket()

    // Knowledge base first: matching how-to articles cost nothing and don't use the daily limit.
    // If none match (or the search fails), it goes straight to the AI as before.
    try {
      const found = await apiFetch('/api/help/match', { method: 'POST', body: { title, description } })
      if (found.articles.length > 0) {
        setMatches(found.articles)
        setPhase('articles')
        setBusy(false)
        return
      }
    } catch {
      // No articles this time; the AI still answers.
    }
    return askAi([])
  }

  /**
   * Asks the AI for steps. `skippedArticleIds` are articles the person saw and passed on: the
   * server counts them as not helpful and gives the AI the best matches as background.
   */
  async function askAi(skippedArticleIds) {
    setError('')
    setBusy(true)
    try {
      const data = await apiFetch('/api/help/suggest', {
        method: 'POST',
        body: { ...problem(), skipped_article_ids: skippedArticleIds },
      })
      clearDraft(currentUser.id) // it's saved on the server now
      setDraftRestored(false)
      setSentFiles(picker.attachments)
      picker.reset() // the files belong to the request now
      rememberRequest(data.session.id)
      if (data.ticket_id) {
        setEscalation({ ticketId: data.ticket_id, reason: data.session.escalate_reason })
        setPhase('escalated')
      } else {
        setSession(data.session)
        setTried([])
        setPhase('steps')
      }
    } catch (err) {
      // 429 = a daily limit, 503 = AI off or down. Either way the form keeps working as a
      // plain ticket form; anything else (e.g. a too-long title) is a normal form error.
      if (err.status === 429 || err.status === 503) setFallback(err.message)
      else setError(err.message)
    }
    setBusy(false)
  }

  /** "That fixed it" on a knowledge base article: saved as fixed, with no AI call. */
  async function articleFixed(article) {
    setError('')
    setBusy(true)
    try {
      await apiFetch('/api/help/article-fixed', { method: 'POST', body: { ...problem(), article_id: article.id } })
      clearDraft(currentUser.id)
      setDraftRestored(false)
      setSentFiles(picker.attachments)
      picker.reset()
      setPhase('fixed')
    } catch (err) {
      setError(err.message)
    }
    setBusy(false)
  }

  /** Sends the form as a plain ticket (the Phase 1 way), then opens it. */
  async function submitTicket() {
    try {
      const data = await apiFetch('/api/tickets', { method: 'POST', body: problem() })
      clearDraft(currentUser.id)
      picker.reset()
      // The ticket page reads `created` to show a "Ticket created" message.
      navigate(`/tickets/${data.ticket.id}`, { state: { created: true } })
    } catch (err) {
      setError(err.message) // e.g. "Title must be 200 characters or fewer"
      setBusy(false)
    }
  }

  /** "That fixed it" or "Still broken". */
  async function sendOutcome(outcome) {
    setError('')
    setBusy(true)
    try {
      const body = outcome === 'still_broken' ? { outcome, tried } : { outcome }
      const data = await apiFetch(`/api/help/${session.id}/outcome`, { method: 'POST', body })
      if (outcome === 'fixed') {
        setPhase('fixed')
        setBusy(false)
      } else {
        navigate(`/tickets/${data.ticket_id}`, { state: { created: true } })
      }
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  const toggleTried = (index) =>
    setTried((list) => (list.includes(index) ? list.filter((i) => i !== index) : [...list, index]))

  /** Back to an empty form (the draft is cleared too, since the boxes are now empty). */
  function resetForm() {
    shownId.current = null
    setTitle('')
    setCategoryId('')
    setDescription('')
    setDraftRestored(false)
    setSession(null)
    setTried([])
    setEscalation(null)
    setMatches([])
    setSentFiles([])
    picker.reset()
    setError('')
    setPhase('form')
  }

  /** "Ask about something else": an empty form and a clean address. */
  function startOver() {
    resetForm()
    setParams({}, { replace: true })
  }

  /** "Clear" on a restored draft. */
  function discardDraft() {
    clearDraft(currentUser.id)
    picker.discard() // unsent uploads are deleted, not just forgotten
    resetForm()
  }

  // The address names a request: load it and show it where the user left off. No AI call.
  useEffect(() => {
    if (!requestId) {
      if (shownId.current) resetForm() // e.g. the sidebar's Get help link while a request was showing
      return
    }
    if (shownId.current === requestId) return // already on screen (it was just created)
    let cancelled = false
    setLoadingRequest(true)
    apiFetch(`/api/help/${requestId}`)
      .then((data) => !cancelled && showRequest(data.session))
      .catch((err) => {
        if (cancelled) return
        setError(err.message) // e.g. "Help request not found"
        setParams({}, { replace: true })
      })
      .finally(() => !cancelled && setLoadingRequest(false))
    return () => {
      cancelled = true
    }
    // Why: this should run only when the address changes. showRequest and setParams are
    // recreated on every render, so listing them would reload the request each time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestId])

  const asking = phase === 'form'

  return (
    <div className="get-help">
      <div className="get-help__main">
        {/* A known outage first: "This is my problem" saves opening a ticket for it. */}
        {asking && !requestId && <KnownIssues outages={outages} />}
        {/* Requests left with steps showing, to pick up without asking the AI again. */}
        {asking && !requestId && unfinished.length > 0 && (
          <section className="get-help__unfinished" aria-labelledby="get-help-unfinished">
            <h2 id="get-help-unfinished" className="get-help__unfinished-heading">
              You have {unfinished.length} unfinished {unfinished.length === 1 ? 'request' : 'requests'}
            </h2>
            <ul>
              {unfinished.map((s) => (
                <li key={s.id}>
                  <span className="get-help__unfinished-title">{s.title}</span>
                  <span className="hint"><RelativeTime date={s.created_at} /></span>
                  <button type="button" onClick={() => setParams({ request: String(s.id) }, { replace: true })}>
                    Continue
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="get-help__card">
          <h2 className="get-help__heading">What's going wrong?</h2>
          <p className="hint">
            {fallback
              ? 'Describe the problem and a technician will take a look.'
              : "Describe the problem and we'll suggest a few safe steps to try first."}
          </p>
          {asking && draftRestored && (
            <p className="get-help__draft" role="status">
              Draft restored.{' '}
              <button type="button" className="link" onClick={discardDraft}>Clear</button>
            </p>
          )}
          {loadingRequest && <p className="hint" role="status">Opening your request…</p>}

          <form onSubmit={handleSubmit}>
            {/* Why: once steps are shown, the form locks, so the steps always match what was asked. */}
            <fieldset className="get-help__fields" disabled={!asking || busy || loadingRequest}>
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
                  aria-describedby="get-help-privacy"
                  placeholder="What happened, when it started, and anything you've already tried."
                />
              </label>
              {/* Security: the text is sent to the AI service and saved on the ticket. */}
              <p id="get-help-privacy" className="hint">Don't include passwords or personal information.</p>
            </fieldset>

            {asking ? (
              <AttachmentPicker
                picker={picker}
                disabled={busy || loadingRequest}
                // Security: screenshots are sent to the AI service too, so the form says so.
                hint={fallback ? null : 'Screenshots you add are sent to the AI with your description.'}
              />
            ) : (
              <AttachmentList attachments={sentFiles} />
            )}

            {fallback && asking && <p className="get-help__notice" role="status">{fallback}</p>}
            {asking && error && <p className="error" role="alert">{error}</p>}

            {asking && (
              <div className="get-help__actions">
                {busy && !fallback && <p className="hint">This can take up to 30 seconds.</p>}
                {picker.uploading && <p className="hint">Waiting for files to upload…</p>}
                <button type="submit" className="primary" disabled={busy || picker.uploading}>
                  {fallback ? (busy ? 'Sending…' : 'Submit ticket') : busy ? 'Finding steps…' : 'Get help'}
                </button>
              </div>
            )}
          </form>
        </section>

        {phase === 'articles' && (
          // Knowledge base articles that match, before asking the AI (no AI call yet).
          <section className="get-help__card" aria-labelledby="get-help-articles">
            <h2 id="get-help-articles" className="get-help__heading">These articles might help</h2>
            <p className="hint">From our knowledge base. Open one to see its steps.</p>
            <ul className="get-help__articles">
              {matches.map((article, i) => (
                <li key={article.id}>
                  {/* The first one starts open: it's the best match. */}
                  <details className="get-help__article" open={i === 0}>
                    <summary>
                      <span className="get-help__article-title">{article.title}</span>
                      {article.category_name && <span className="hint">{article.category_name}</span>}
                    </summary>
                    <p className="hint">{article.problem}</p>
                    <ol>
                      {article.steps.map((step, j) => (
                        <li key={j}>
                          <strong>{step.title}</strong>
                          {step.detail && <span className="get-help__article-detail">{step.detail}</span>}
                        </li>
                      ))}
                    </ol>
                    <button type="button" className="primary" onClick={() => articleFixed(article)} disabled={busy}>
                      That fixed it
                    </button>
                  </details>
                </li>
              ))}
            </ul>
            {error && <p className="error" role="alert">{error}</p>}
            <div className="get-help__actions">
              <button type="button" className="link" onClick={() => setPhase('form')} disabled={busy}>
                Change my description
              </button>
              <button type="button" onClick={() => askAi(matches.map((a) => a.id))} disabled={busy}>
                {busy ? 'Finding steps…' : 'None of these, get AI steps'}
              </button>
            </div>
          </section>
        )}

        {phase === 'steps' && (
          <section className="get-help__card" aria-labelledby="get-help-steps">
            <h2 id="get-help-steps" className="get-help__heading" ref={headingRef} tabIndex={-1}>
              Try these steps
            </h2>
            <p className="hint">
              Work through them in order. Tick the ones you tried, so a technician knows if you still need help.
            </p>

            <ol className="get-help__steps">
              {session.steps.map((step, index) => (
                <li key={index} className="get-help__step">
                  <div>
                    <strong>{index + 1}. {step.title}</strong>
                    <p>{step.detail}</p>
                  </div>
                  <label className="get-help__tried">
                    <input
                      type="checkbox"
                      checked={tried.includes(index)}
                      onChange={() => toggleTried(index)}
                      disabled={busy}
                    />
                    I tried this
                  </label>
                </li>
              ))}
            </ol>

            {error && <p className="error" role="alert">{error}</p>}
            <div className="get-help__actions">
              <button type="button" onClick={() => sendOutcome('still_broken')} disabled={busy}>
                Still broken
              </button>
              <button type="button" className="primary" onClick={() => sendOutcome('fixed')} disabled={busy}>
                That fixed it
              </button>
            </div>
          </section>
        )}

        {phase === 'fixed' && (
          <section className="get-help__result get-help__result--fixed" aria-labelledby="get-help-fixed">
            <h2 id="get-help-fixed" ref={headingRef} tabIndex={-1}>Glad that worked!</h2>
            <p>No ticket needed. If the problem comes back, you can always ask again.</p>
            <button type="button" onClick={startOver}>Ask about something else</button>
          </section>
        )}

        {phase === 'escalated' && (
          <section className="get-help__result" aria-labelledby="get-help-escalated">
            <h2 id="get-help-escalated" ref={headingRef} tabIndex={-1}>This needs a technician</h2>
            <p>We've opened ticket #{escalation.ticketId} for you, so a technician can take it from here.</p>
            {escalation.reason && <p className="hint">{escalation.reason}</p>}
            <div className="get-help__result-actions">
              <Link className="get-help__view" to={`/tickets/${escalation.ticketId}`}>View ticket</Link>
              <button type="button" onClick={startOver}>Ask about something else</button>
            </div>
          </section>
        )}
      </div>

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
          We suggest a few safe steps first. If they don't fix it, a ticket is opened with what you tried, and
          a technician takes over. You'll see every update on the ticket's page and under My tickets.
        </p>

        {/* Who's around to help: first names and status only. */}
        {presence?.online !== null && presence?.online !== undefined && (
          <>
            <h2 className="get-help__tips-heading get-help__team-heading">IT team online</h2>
            {presence.staff.length === 0 ? (
              <p>Nobody is online right now. Your ticket will be picked up when someone is back.</p>
            ) : (
              <ul className="get-help__team">
                {presence.staff.map((person, i) => (
                  <li key={`${person.name}-${i}`}>
                    {/* Decoration only: the status word is shown beside the name. */}
                    <span className={`status-dot status-dot--${person.status}`} aria-hidden="true" />
                    <span className="get-help__team-name">{person.name}</span>
                    <span className="get-help__team-status">{STATUS_LABELS[person.status]}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </aside>
    </div>
  )
}

export default GetHelpPage
