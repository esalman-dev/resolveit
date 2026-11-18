// Reviews page: the "How did we do?" reviews, for staff.
//
// Technicians see their own reviews only, without who wrote them or which ticket (the server
// leaves those out). Admins and owners see everyone's, with names and ticket links, and can
// pick one technician; the choice is kept in the address (?technician=4, or none).

import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { apiFetch } from '../lib/api.js'
import EmptyState from '../components/EmptyState.jsx'
import RelativeTime from '../components/RelativeTime.jsx'
import { Stars } from '../components/Stars.jsx'
import { isAdminOrOwner } from '../lib/roles.js'
import { usePageTitle } from '../lib/usePageTitle.js'
import './ReviewsPage.css'

/** The Reviews screen. */
function ReviewsPage({ currentUser }) {
  const admin = isAdminOrOwner(currentUser.role)
  usePageTitle(admin ? 'Reviews' : 'My reviews')
  const [params, setParams] = useSearchParams()
  const technician = admin ? (params.get('technician') ?? '') : ''
  const [data, setData] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    const query = technician ? `?technician_id=${encodeURIComponent(technician)}` : ''
    apiFetch(`/api/reviews${query}`)
      .then(setData)
      .catch((err) => setError(err.message))
  }, [technician])

  if (error) return <p className="error" role="alert">{error}</p>
  if (!data) return <p className="hint">Loading reviews…</p>

  const { summary, reviews } = data
  return (
    <div className="reviews-page">
      <div className="reviews-page__main">
        {admin && (
          <label className="reviews-page__filter">
            Technician
            <select
              value={technician}
              onChange={(e) => setParams(e.target.value ? { technician: e.target.value } : {}, { replace: true })}
            >
              <option value="">Everyone</option>
              {data.technicians.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              <option value="none">No technician</option>
            </select>
          </label>
        )}

        <Summary summary={summary} />

        {reviews.length === 0 ? (
          <EmptyState message={admin ? 'No reviews yet.' : "You don't have any reviews yet. They appear here when someone rates a ticket you resolved."} />
        ) : (
          <ul className="reviews-page__list">
            {reviews.map((r, i) => (
              <li key={r.ticket_id ?? i} className="reviews-page__review">
                <div className="reviews-page__review-top">
                  <Stars stars={r.stars} />
                  <span className="hint"><RelativeTime date={r.created_at} /></span>
                </div>
                {r.comment ? <p className="reviews-page__comment">{r.comment}</p> : <p className="hint reviews-page__comment">No comment</p>}
                {admin && (
                  <p className="hint reviews-page__who">
                    {r.rated_by_name} on <Link to={`/tickets/${r.ticket_id}`}>#{r.ticket_id}</Link>
                    {' · '}
                    {r.technician_name ? `credits ${r.technician_name}` : 'no technician'}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
        {summary.count > reviews.length && <p className="hint">Showing the newest {reviews.length} of {summary.count}.</p>}
      </div>

      <aside className="reviews-page__about" aria-label="About reviews">
        <h2 className="reviews-page__about-heading">About reviews</h2>
        <p>When a ticket is resolved, the person who opened it can rate it from 1 to 5 stars, with an optional comment, and change it for 7 days.</p>
        <p>A review counts for the technician the ticket was assigned to at the time.</p>
        <p>
          {admin
            ? 'Technicians see their own reviews without names or ticket numbers, so people can be honest.'
            : 'You see your reviews without names or ticket numbers, so people can be honest.'}
        </p>
      </aside>
    </div>
  )
}

/** The average, the count, and one bar per star level (5 at the top). */
function Summary({ summary }) {
  if (summary.count === 0) return null
  const widest = Math.max(...Object.values(summary.stars), 1)
  return (
    <section className="reviews-page__summary" aria-label="Summary">
      <div className="reviews-page__average">
        <span className="reviews-page__average-number">{summary.average.toFixed(1)}</span>
        <Stars stars={Math.round(summary.average)} />
        <span className="hint">{summary.count} {summary.count === 1 ? 'review' : 'reviews'}</span>
      </div>
      <ol className="reviews-page__bars">
        {[5, 4, 3, 2, 1].map((n) => (
          <li key={n}>
            <span className="reviews-page__bar-label">{n} ★</span>
            <span className="reviews-page__bar">
              <span className="reviews-page__bar-fill" style={{ width: `${(summary.stars[n] / widest) * 100}%` }} />
            </span>
            <span className="reviews-page__bar-count">{summary.stars[n]}</span>
          </li>
        ))}
      </ol>
    </section>
  )
}

export default ReviewsPage
