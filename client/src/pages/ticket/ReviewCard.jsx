// Review card: "How did we do?" on a resolved ticket, for the person who opened it.
//
// Before a review: stars, an optional comment, Send review. After: the review, with Edit until
// the 7-day window closes (the server enforces it too).

import { useState } from 'react'
import { apiFetch } from '../../lib/api.js'
import { StarPicker, Stars } from '../../components/Stars.jsx'
import './ReviewCard.css'

// Note: matches MAX_REVIEW in server/routes/tickets.js.
const MAX_REVIEW = 1000

/**
 * The review card. Renders nothing until the ticket is resolved.
 * @param rating the saved review, or null
 * @param onSaved called with the saved review
 */
function ReviewCard({ ticket, rating, onSaved }) {
  const [editing, setEditing] = useState(false)
  const [stars, setStars] = useState(rating?.stars ?? 0)
  const [comment, setComment] = useState(rating?.comment ?? '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [openedAt] = useState(() => Date.now()) // the clock is read once, not on every redraw

  if (ticket.status !== 'resolved' && !rating) return null
  const canEdit = rating && new Date(rating.editable_until).getTime() > openedAt

  async function send(e) {
    e.preventDefault()
    if (!stars) return setError('Choose from 1 to 5 stars.')
    setBusy(true)
    setError('')
    try {
      const data = await apiFetch(`/api/tickets/${ticket.id}/rating`, { method: 'PUT', body: { stars, comment } })
      onSaved(data.rating)
      setEditing(false)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  // --- A saved review ---
  if (rating && !editing) {
    return (
      <section className="review-card review-card--done" aria-labelledby="review-heading">
        <h2 id="review-heading" className="review-card__heading">Your review</h2>
        <p className="review-card__line">
          <Stars stars={rating.stars} />
          {rating.comment && <span className="review-card__comment">“{rating.comment}”</span>}
        </p>
        <p className="hint review-card__meta">
          Thanks for the feedback.{' '}
          {canEdit ? (
            <>
              You can change it until {new Date(rating.editable_until).toLocaleDateString([], { month: 'short', day: 'numeric' })}.{' '}
              <button
                type="button"
                className="link"
                onClick={() => {
                  setStars(rating.stars)
                  setComment(rating.comment ?? '')
                  setEditing(true)
                }}
              >
                Edit
              </button>
            </>
          ) : null}
        </p>
      </section>
    )
  }

  // --- The form ---
  return (
    <section className="review-card" aria-labelledby="review-heading">
      <h2 id="review-heading" className="review-card__heading">{rating ? 'Edit your review' : 'How did we do?'}</h2>
      {!rating && <p className="hint">Your ticket is resolved. A quick rating helps the team improve.</p>}
      <form onSubmit={send}>
        <StarPicker
          value={stars}
          onChange={(n) => {
            setStars(n)
            setError('') // the "choose stars" message goes as soon as there are some
          }}
          disabled={busy}
        />
        <label>
          Comment (optional)
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            maxLength={MAX_REVIEW}
            rows={2}
            placeholder="What went well, or what could be better?"
            disabled={busy}
          />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="review-card__buttons">
          {rating && <button type="button" onClick={() => setEditing(false)} disabled={busy}>Cancel</button>}
          <button type="submit" className="primary" disabled={busy}>{busy ? 'Sending…' : 'Send review'}</button>
        </div>
      </form>
    </section>
  )
}

export default ReviewCard
