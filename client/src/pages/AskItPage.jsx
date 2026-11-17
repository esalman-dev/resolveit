// Ask IT page: one quick IT question, one short answer from the AI.
//
// For "how do I…" and "what is…" questions, where Get help is for something broken. Each
// question counts toward the same daily limit as Get help and is saved with who asked, so staff
// see it on the AI help screen. The answer follows the same safety rules: a risky question gets
// "This needs a technician", never instructions.

import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { apiFetch } from '../lib/api.js'
import { saveDraft } from '../lib/drafts.js'
import { usePageTitle } from '../lib/usePageTitle.js'
import RelativeTime from '../components/RelativeTime.jsx'
import './AskItPage.css'

// Note: matches MAX_QUESTION in server/routes/help.js.
const MAX_QUESTION = 500
// Matches MAX_TITLE in server/routes/tickets.js, for carrying the question over to Get help.
const MAX_TITLE = 200

/** The small label on each recent question. */
const STATUS_LABELS = {
  pending: 'Waiting for your answer',
  fixed: 'Helped',
  still_broken: "Didn't help",
  escalated: 'Needs a technician',
}

/** The Ask IT box, the latest answer, and the user's recent questions. */
function AskItPage({ currentUser }) {
  usePageTitle('Ask IT')
  const navigate = useNavigate()
  const [question, setQuestion] = useState('')
  const [latest, setLatest] = useState(null) // the answer just received
  const [recent, setRecent] = useState([])
  const [error, setError] = useState('')
  const [unavailable, setUnavailable] = useState('') // the server's message on 429/503
  const [busy, setBusy] = useState(false)
  const [savingId, setSavingId] = useState(null) // the question whose Yes / No is being saved
  const answerRef = useRef(null)

  const loadRecent = () =>
    apiFetch('/api/help/questions/mine')
      .then((data) => setRecent(data.questions))
      .catch(() => setRecent([])) // only a convenience: asking works without it

  useEffect(() => {
    loadRecent()
  }, [])

  // Moves the keyboard focus to a new answer, so screen readers read it.
  useEffect(() => {
    if (latest) answerRef.current?.focus()
  }, [latest])

  async function handleAsk(e) {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      const data = await apiFetch('/api/help/ask', { method: 'POST', body: { question } })
      setLatest(data.question)
      setQuestion('')
      loadRecent()
    } catch (err) {
      // 429 = a daily limit, 503 = AI off or down: not the user's fault, so not a form error.
      if (err.status === 429 || err.status === 503) setUnavailable(err.message)
      else setError(err.message)
    }
    setBusy(false)
  }

  /** "Get help with this": opens Get help with the question already filled in, as a draft. */
  function getHelpWith(text) {
    saveDraft(currentUser.id, { title: text.slice(0, MAX_TITLE), description: text, categoryId: '' })
    navigate('/get-help')
  }

  /** "Yes, that helped" (fixed) or "No" (still_broken), for one question. */
  async function sendFeedback(q, outcome) {
    setError('')
    setSavingId(q.id)
    try {
      const data = await apiFetch(`/api/help/${q.id}/outcome`, { method: 'POST', body: { outcome } })
      if (latest?.id === q.id) setLatest(data.question)
      setRecent((list) => list.map((item) => (item.id === q.id ? data.question : item)))
    } catch (err) {
      setError(err.message)
    }
    setSavingId(null)
  }

  return (
    <div className="ask-it">
      <div className="ask-it__main">
        <section className="ask-it__card">
          <h2 className="ask-it__heading">Ask a quick IT question</h2>
          <form onSubmit={handleAsk}>
            <label>
              Your question
              <textarea
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                required
                maxLength={MAX_QUESTION}
                rows={3}
                disabled={busy}
                aria-describedby="ask-it-privacy"
                placeholder="e.g. How do I connect to the office printer?"
              />
            </label>
            {/* Security: the question is sent to the AI service and saved with your name. */}
            <p id="ask-it-privacy" className="hint ask-it__privacy">Don't include passwords or personal information.</p>

            {unavailable && (
              <p className="ask-it__notice" role="status">
                {unavailable}{' '}
                <button type="button" onClick={() => navigate('/get-help')}>Go to Get help</button>
              </p>
            )}
            {error && <p className="error" role="alert">{error}</p>}

            <div className="ask-it__actions">
              {busy && <p className="hint">This can take a few seconds.</p>}
              <button type="submit" className="primary" disabled={busy}>{busy ? 'Asking…' : 'Ask'}</button>
            </div>
          </form>
        </section>

        {latest && (
          <section
            className={`ask-it__answer ask-it__answer--${latest.outcome}`} // the edge color follows the result
            aria-labelledby="ask-it-answer"
          >
            <h2 id="ask-it-answer" ref={answerRef} tabIndex={-1}>
              {latest.needs_technician ? 'This needs a technician' : 'Answer'}
            </h2>
            <p className="ask-it__question">{latest.question}</p>
            {/* The AI's words are plain text (React escapes them), never HTML. */}
            <p className="ask-it__text">{latest.answer}</p>
            {latest.reason && <p className="hint">{latest.reason}</p>}
            <Feedback
              question={latest}
              saving={savingId === latest.id}
              onFeedback={sendFeedback}
              onGetHelp={getHelpWith}
            />
          </section>
        )}

        {recent.length > 0 && (
          <section aria-labelledby="ask-it-recent">
            <h2 id="ask-it-recent" className="ask-it__recent-heading">Your recent questions</h2>
            <ul className="ask-it__recent">
              {recent.map((q) => (
                <li key={q.id}>
                  {/* Why <details>: the browser handles opening, closing and the keyboard. */}
                  <details>
                    <summary>
                      <span className="ask-it__recent-question">{q.question}</span>
                      <span className={`ask-it__status ask-it__status--${q.outcome}`}>{STATUS_LABELS[q.outcome]}</span>
                      <span className="hint"><RelativeTime date={q.created_at} /></span>
                    </summary>
                    <p className="ask-it__text">{q.answer}</p>
                    <Feedback question={q} saving={savingId === q.id} onFeedback={sendFeedback} onGetHelp={getHelpWith} />
                  </details>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      <aside className="ask-it__side" aria-label="About Ask IT">
        <h2 className="ask-it__side-heading">Good questions</h2>
        <ul>
          <li>How do I connect to the office printer?</li>
          <li>What is a VPN, and when do I need it?</li>
          <li>How do I share a file from OneDrive?</li>
        </ul>
        <h2 className="ask-it__side-heading">Something broken?</h2>
        <p>Use Get help instead: you'll get steps to try, and a ticket if they don't work.</p>
      </aside>
    </div>
  )
}

/**
 * Under an answer: "Did this answer your question?" until the user says, then what follows.
 * Why ask: it's how staff (and the self-solved rate) know whether Ask IT actually helped.
 */
function Feedback({ question: q, saving, onFeedback, onGetHelp }) {
  const getHelp = (
    <button type="button" className="primary" onClick={() => onGetHelp(q.question)}>
      Get help with this
    </button>
  )

  if (q.outcome === 'pending') {
    return (
      <div className="ask-it__feedback" role="group" aria-label="Did this answer your question?">
        <p>Did this answer your question?</p>
        <div className="ask-it__feedback-buttons">
          <button type="button" className="primary" disabled={saving} onClick={() => onFeedback(q, 'fixed')}>
            Yes, that helped
          </button>
          <button type="button" disabled={saving} onClick={() => onFeedback(q, 'still_broken')}>
            No
          </button>
        </div>
      </div>
    )
  }
  if (q.outcome === 'fixed') return <p className="ask-it__thanks" role="status">Glad that helped!</p>
  if (q.outcome === 'still_broken') {
    return (
      <div className="ask-it__feedback" role="status">
        <p>Sorry it didn't help. Get help gives you steps to try, and a technician if they don't work.</p>
        {getHelp}
      </div>
    )
  }
  return <div className="ask-it__feedback">{getHelp}</div> // needs a technician
}

export default AskItPage
