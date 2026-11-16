// Ticket activity: the conversation on a ticket. Comments and history lines are mixed into
// one timeline in time order, like a GitHub issue, with the comment box underneath.

import { useState } from 'react'
import RelativeTime from './RelativeTime.jsx'
import { priorityLabel, statusLabel } from './ticketLabels.js'
import './TicketActivity.css'

// Note: matches MAX_COMMENT in server/routes/tickets.js.
const MAX_COMMENT = 5000

/**
 * The timeline and the comment box.
 *
 * @param onAddComment called with (text, isInternal); returns a promise that rejects on failure
 * @param onEditComment called with (commentId, text); returns a promise that rejects on failure
 */
function TicketActivity({ history, comments, currentUser, staff, onAddComment, onEditComment }) {
  // One list, sorted by time. History lines are small and gray; comments are full cards.
  const items = [
    ...history.map((event) => ({ kind: 'event', at: event.created_at, key: `e${event.id}`, event })),
    ...comments.map((comment) => ({ kind: 'comment', at: comment.created_at, key: `c${comment.id}`, comment })),
  ].sort((a, b) => new Date(a.at) - new Date(b.at))

  return (
    <section className="ticket-page__activity" aria-labelledby="ticket-activity">
      <h2 id="ticket-activity" className="ticket-page__heading">Activity</h2>
      <ol className="activity">
        {items.map((item) =>
          item.kind === 'event' ? (
            <li key={item.key} className="activity__event">
              <strong>{item.event.actor_name}</strong> {describeEvent(item.event)} · <RelativeTime date={item.at} />
            </li>
          ) : (
            <li key={item.key} className="activity__item">
              <Comment comment={item.comment} mine={item.comment.author_id === currentUser.id} onEdit={onEditComment} />
            </li>
          )
        )}
      </ol>
      <CommentForm staff={staff} onAdd={onAddComment} />
    </section>
  )
}

/** One comment: who wrote it and when, the text, and for its author an Edit link. */
function Comment({ comment, mine, onEdit }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(comment.body)
  const [showVersions, setShowVersions] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function save(e) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await onEdit(comment.id, draft)
      setEditing(false)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  // Every earlier version and when it was written: the first one when the comment was posted,
  // each later one when the edit before it was saved.
  const versions = comment.edits.map((edit, i) => ({
    body: edit.old_body,
    writtenAt: i === 0 ? comment.created_at : comment.edits[i - 1].edited_at,
  }))

  return (
    <article className={comment.is_internal ? 'comment comment--internal' : 'comment'}>
      <header className="comment__header">
        <span>
          <strong>{comment.author_name}</strong> <RelativeTime date={comment.created_at} />
          {comment.edited_at && (
            <>
              {' · '}
              <button
                type="button"
                className="link comment__edited"
                aria-expanded={showVersions}
                onClick={() => setShowVersions((open) => !open)}
              >
                edited
              </button>
            </>
          )}
        </span>
        <span className="comment__tools">
          {/* Never color alone: internal notes also say so in words. */}
          {comment.is_internal && <span className="comment__label">Internal</span>}
          {mine && !editing && (
            <button
              type="button"
              className="link"
              onClick={() => {
                setDraft(comment.body)
                setEditing(true)
              }}
            >
              Edit
            </button>
          )}
        </span>
      </header>

      {editing ? (
        <form className="comment__form" onSubmit={save}>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            required
            maxLength={MAX_COMMENT}
            rows={4}
            aria-label="Edit comment"
          />
          {error && <p className="error" role="alert">{error}</p>}
          <div className="comment__buttons">
            <button type="button" onClick={() => setEditing(false)} disabled={busy}>Cancel</button>
            <button type="submit" className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </form>
      ) : (
        <p className="comment__body">{comment.body}</p>
      )}

      {showVersions && (
        <div className="comment__versions">
          <p className="comment__versions-title">Earlier versions</p>
          <ol>
            {versions.map((v, i) => (
              <li key={i}>
                <span className="comment__versions-time">Written <RelativeTime date={v.writtenAt} /></span>
                <p className="comment__body">{v.body}</p>
              </li>
            ))}
          </ol>
        </div>
      )}
    </article>
  )
}

/** The "Write a comment" box. Staff can tick "Internal note" to hide it from the user. */
function CommentForm({ staff, onAdd }) {
  const [text, setText] = useState('')
  const [internal, setInternal] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function send(e) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await onAdd(text, internal)
      setText('')
      setInternal(false)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className={internal ? 'comment-form comment-form--internal' : 'comment-form'} onSubmit={send}>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        required
        maxLength={MAX_COMMENT}
        rows={3}
        placeholder={internal ? 'Write an internal note (only staff will see it)…' : 'Write a comment…'}
        aria-label="Comment"
      />
      {error && <p className="error" role="alert">{error}</p>}
      <div className="comment-form__row">
        {staff ? (
          <label className="comment-form__check">
            <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} />
            Internal note (staff only)
          </label>
        ) : (
          <span />
        )}
        <button type="submit" className="primary" disabled={busy}>{busy ? 'Sending…' : 'Send'}</button>
      </div>
    </form>
  )
}

/**
 * One history entry in words, after the person's name.
 * @example describeEvent({ action: 'changed', field: 'status', old_value: 'open', new_value: 'resolved' })
 * // "changed the status from Open to Resolved"
 */
function describeEvent({ action, field, old_value: from, new_value: to }) {
  if (action === 'created') return 'opened this ticket'
  switch (field) {
    case 'status':
      return `changed the status from ${statusLabel(from)} to ${statusLabel(to)}`
    case 'priority':
      return `changed the priority from ${priorityLabel(from)} to ${priorityLabel(to)}`
    case 'category':
      if (!from) return `set the category to ${to}`
      if (!to) return `removed the category ${from}`
      return `changed the category from ${from} to ${to}`
    case 'assignee':
      if (!from) return `assigned this to ${to}`
      if (!to) return `unassigned ${from}`
      return `reassigned this from ${from} to ${to}`
    case 'title':
      return `changed the title from "${from}" to "${to}"`
    case 'description':
      return 'edited the description' // the full old text would be too long for one line
    default:
      return `changed the ${field}`
  }
}

export default TicketActivity
