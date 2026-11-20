// Ticket page: one ticket, at /tickets/:id.
//
// Two columns: the ticket and its activity (comments and history) on the left, and the side
// panel (status, priority, category, assignee) on the right. On phones the panel sits between
// the description and the activity.
//
// Staff change the ticket from the side panel. The person who opened it can edit the text while
// it's still open, close it, and comment.

import { useCallback, useEffect, useState } from 'react'
import { useLocation, useNavigate, useOutletContext, useParams } from 'react-router'
import { apiFetch } from '../../lib/api.js'
import ConfirmDialog from '../../components/ConfirmDialog.jsx'
import EmptyState from '../../components/EmptyState.jsx'
import RelativeTime from '../../components/RelativeTime.jsx'
import { AttachmentList } from '../../components/Attachments.jsx'
import TicketActivity from './TicketActivity.jsx'
import TicketSidePanel from './TicketSidePanel.jsx'
import { isAdminOrOwner, isStaff } from '../../lib/roles.js'
import ReviewCard from './ReviewCard.jsx'
import { statusLabel } from '../../lib/ticketLabels.js'
import { usePageTitle } from '../../lib/usePageTitle.js'
import './TicketPage.css'

// Note: these match MAX_TITLE and MAX_DESCRIPTION in server/routes/tickets.js.
const MAX_TITLE = 200
const MAX_DESCRIPTION = 5000

/** Shows one ticket, plus a "Ticket created" message when arriving from the Get help form. */
function TicketPage({ currentUser }) {
  const { id } = useParams() // the 12 in /tickets/12
  const location = useLocation()
  const navigate = useNavigate()
  const { outages } = useOutletContext() // open outages, from the app shell
  const staff = isStaff(currentUser.role)

  const [ticket, setTicket] = useState(null)
  const [history, setHistory] = useState([])
  const [comments, setComments] = useState([])
  const [attachments, setAttachments] = useState([]) // every file on the ticket and its comments
  const [rating, setRating] = useState(null) // the review, for the person who opened it and admins
  const [categories, setCategories] = useState([]) // staff only
  const [assignees, setAssignees] = useState([]) // staff only
  const [loadError, setLoadError] = useState('')
  const [actionError, setActionError] = useState('')
  const [busy, setBusy] = useState(false) // a ticket change is saving
  // A change waiting for "Are you sure?": { fields, title, message, confirmLabel, danger, offerDraft }.
  const [pending, setPending] = useState(null)
  const [draftChoice, setDraftChoice] = useState(true) // "Draft a knowledge base article" when resolving
  const [notice, setNotice] = useState('') // e.g. "Drafting a knowledge base article…"
  const [kbArticle, setKbArticle] = useState(null) // the article drafted from this ticket (staff)
  const [editing, setEditing] = useState(false) // the title/description edit form is open
  const [draft, setDraft] = useState({ title: '', description: '' })
  // Read once: the Get help form sends { created: true } along with the address.
  const [justCreated] = useState(Boolean(location.state?.created))

  usePageTitle(ticket ? `#${ticket.id} ${ticket.title}` : 'Ticket')

  // Why: the browser keeps that state through a refresh, which would show "Ticket created"
  // again. Replacing it with nothing means the message shows only the first time.
  useEffect(() => {
    if (location.state?.created) navigate(location.pathname, { replace: true, state: null })
  }, [location, navigate])

  // Everything the page needs, in parallel. Staff also need the dropdown choices.
  useEffect(() => {
    const requests = [
      apiFetch(`/api/tickets/${id}`),
      apiFetch(`/api/tickets/${id}/comments`),
      apiFetch(`/api/tickets/${id}/attachments`),
    ]
    if (staff) requests.push(apiFetch('/api/categories'), apiFetch('/api/tickets/assignees'))
    Promise.all(requests)
      .then(([ticketData, commentData, attachmentData, categoryData, assigneeData]) => {
        setTicket(ticketData.ticket)
        setHistory(ticketData.history)
        setComments(commentData.comments)
        setAttachments(attachmentData.attachments)
        if (staff) {
          setCategories(categoryData.categories)
          setAssignees(assigneeData.assignees)
        }
      })
      .catch((err) => setLoadError(err.message))
  }, [id, staff])

  // The review, once resolved. Only the person who opened the ticket and admins may see it: the
  // server refuses technicians, who see their reviews without names on the Reviews page.
  const seesReview = ticket && (ticket.created_by === currentUser.id || isAdminOrOwner(currentUser.role))
  const resolved = ticket?.status === 'resolved'
  useEffect(() => {
    if (!seesReview || !resolved) return
    apiFetch(`/api/tickets/${id}/rating`)
      .then((data) => setRating(data.rating))
      .catch(() => {}) // the page works without it
  }, [id, seesReview, resolved])

  /** Staff: the knowledge base article drafted from this ticket, if there is one. */
  const loadArticle = useCallback(() => {
    if (!staff) return
    apiFetch(`/api/kb?source_ticket=${id}`)
      .then((data) => setKbArticle(data.articles[0] ?? null))
      .catch(() => {}) // the page works without it
  }, [id, staff])

  useEffect(() => {
    const first = setTimeout(loadArticle, 0)
    return () => clearTimeout(first)
  }, [loadArticle])

  // Security: someone else's ticket answers 404, the same as one that doesn't exist, so
  // nobody can find out which ticket numbers are in use.
  if (loadError) return <EmptyState message={loadError} actionLabel="Back to tickets" actionTo="/tickets" />
  if (!ticket) return <p className="hint">Loading ticket…</p>

  const isCreator = ticket.created_by === currentUser.id
  // The server's rule: staff can always edit; the creator only while nobody has started on it.
  const canEdit = staff || (isCreator && ticket.status === 'open')

  // --- Changing the ticket ---

  /** Saves changed fields. The server answers with the updated ticket and its history. */
  async function save(fields) {
    setBusy(true)
    setActionError('')
    try {
      const data = await apiFetch(`/api/tickets/${ticket.id}`, { method: 'PATCH', body: fields })
      setTicket(data.ticket)
      setHistory(data.history)
      if (data.article_drafting) {
        setNotice('Drafting a knowledge base article from this fix. It will be under Knowledge base → Drafts in a moment.')
        setTimeout(loadArticle, 8000) // the AI usually takes a few seconds
      }
      return true
    } catch (err) {
      setActionError(err.message)
      return false
    } finally {
      setBusy(false)
      setPending(null)
    }
  }

  /** Staff: links the ticket to an open outage, or unlinks it (null), then shows the result. */
  async function linkOutage(outageId) {
    setBusy(true)
    setActionError('')
    try {
      await apiFetch(`/api/outages/tickets/${ticket.id}`, { method: 'PUT', body: { outage_id: outageId } })
      const data = await apiFetch(`/api/tickets/${ticket.id}`)
      setTicket(data.ticket)
      outages.refresh() // the outage cards' ticket counts
    } catch (err) {
      setActionError(err.message)
    } finally {
      setBusy(false)
    }
  }

  /**
   * A change from the side panel. Big changes ask "Are you sure?" first; small ones save
   * straight away, because every change is in the history and easy to undo.
   */
  function handleChange(fields) {
    const question = confirmationFor(fields)
    if (question) setPending({ fields, ...question })
    else save(fields)
  }

  /** The "Are you sure?" text for a change, or null if it doesn't need one. */
  function confirmationFor(fields) {
    if ('status' in fields && fields.status === 'resolved') {
      return {
        title: `Mark #${ticket.id} resolved?`,
        message: `${ticket.created_by_name} will see the ticket as resolved.`,
        confirmLabel: 'Mark resolved',
        offerDraft: staff && !kbArticle, // staff can have the AI draft a how-to from the fix
      }
    }
    if ('status' in fields && ticket.status === 'resolved') {
      return {
        title: `Reopen #${ticket.id}?`,
        message: `The ticket goes back to ${statusLabel(fields.status)}.`,
        confirmLabel: 'Reopen',
      }
    }
    // Taking a ticket away from someone else: they may be in the middle of it.
    if ('assigned_to' in fields && ticket.assigned_to && ticket.assigned_to !== currentUser.id) {
      const to = assignees.find((a) => a.id === fields.assigned_to)?.name
      return {
        title: 'Reassign this ticket?',
        message: `It's assigned to ${ticket.assigned_to_name}. ${to ? `It will move to ${to}.` : 'It will be unassigned.'}`,
        confirmLabel: to ? 'Reassign' : 'Unassign',
      }
    }
    return null
  }

  function askToClose() {
    setPending({
      fields: { status: 'resolved' },
      title: 'Close this ticket?',
      message: 'It will be marked resolved. If the problem comes back, add a comment and a technician can reopen it.',
      confirmLabel: 'Close ticket',
      danger: true,
    })
  }

  function startEditing() {
    setDraft({ title: ticket.title, description: ticket.description })
    setEditing(true)
  }

  async function saveEdit(e) {
    e.preventDefault()
    if (await save({ title: draft.title, description: draft.description })) setEditing(false)
  }

  // --- Comments ---

  async function addComment(text, isInternal, attachmentIds = []) {
    const data = await apiFetch(`/api/tickets/${ticket.id}/comments`, {
      method: 'POST',
      body: { body: text, is_internal: isInternal, attachment_ids: attachmentIds },
    })
    setComments((list) => [...list, data.comment])
    setTicket((t) => ({ ...t, updated_at: data.comment.created_at })) // a comment counts as activity
    if (attachmentIds.length) {
      // The comment's files now belong to it; reload the list so they show under it.
      apiFetch(`/api/tickets/${ticket.id}/attachments`)
        .then((files) => setAttachments(files.attachments))
        .catch(() => {})
    }
  }

  async function editComment(commentId, text) {
    const data = await apiFetch(`/api/tickets/${ticket.id}/comments/${commentId}`, {
      method: 'PATCH',
      body: { body: text },
    })
    setComments((list) => list.map((c) => (c.id === commentId ? data.comment : c)))
  }

  return (
    <div className="ticket-page">
      {justCreated && (
        <p className="ticket-page__created" role="status">
          Ticket created. A technician will take a look; you'll see updates here.
        </p>
      )}
      {actionError && <p className="ticket-page__error" role="alert">{actionError}</p>}
      {notice && <p className="ticket-page__notice" role="status">{notice}</p>}

      <div className="ticket-page__layout">
        <article className="ticket-page__post">
          <header className="ticket-page__post-header">
            <span>
              <strong>{ticket.created_by_name}</strong> opened this ticket <RelativeTime date={ticket.created_at} />
            </span>
            {canEdit && !editing && (
              <button type="button" className="link" onClick={startEditing}>Edit</button>
            )}
          </header>

          {editing ? (
            <form className="ticket-page__edit" onSubmit={saveEdit}>
              <label>
                Title
                <input
                  value={draft.title}
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                  required
                  maxLength={MAX_TITLE}
                />
              </label>
              <label>
                Details
                <textarea
                  value={draft.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  required
                  maxLength={MAX_DESCRIPTION}
                  rows={6}
                />
              </label>
              <div className="ticket-page__edit-buttons">
                <button type="button" onClick={() => setEditing(false)} disabled={busy}>Cancel</button>
                <button type="submit" className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
              </div>
            </form>
          ) : (
            <p className="ticket-page__description">{ticket.description}</p>
          )}
          {/* Files sent with the ticket itself (from Get help, or the plain ticket form). */}
          <AttachmentList className="ticket-page__files" attachments={attachments.filter((a) => a.comment_id === null)} />
        </article>

        <TicketSidePanel
          ticket={ticket}
          currentUser={currentUser}
          staff={staff}
          categories={categories}
          assignees={assignees}
          busy={busy}
          onChange={handleChange}
          onClose={askToClose}
          // Admins and owners see the review here; the person who opened it has the review card.
          rating={!isCreator ? rating : null}
          article={kbArticle}
          openOutages={outages.list}
          onOutageChange={linkOutage}
        />

        <TicketActivity
          history={history}
          comments={comments}
          attachments={attachments}
          stepsTried={ticket.steps_tried}
          beforeCommentBox={
            isCreator ? <ReviewCard key={rating ? 'saved' : 'new'} ticket={ticket} rating={rating} onSaved={setRating} /> : null
          }
          currentUser={currentUser}
          staff={staff}
          onAddComment={addComment}
          onEditComment={editComment}
        />
      </div>

      <ConfirmDialog
        open={pending !== null}
        title={pending?.title ?? ''}
        message={pending?.message ?? ''}
        confirmLabel={pending?.confirmLabel}
        danger={pending?.danger}
        busy={busy}
        onConfirm={() => save(pending.offerDraft && draftChoice ? { ...pending.fields, draft_article: true } : pending.fields)}
        onCancel={() => setPending(null)}
      >
        {pending?.offerDraft && (
          // Knowledge base: on by default; untick it for a one-off fix nobody else will need.
          <label className="ticket-page__draft-choice">
            <input type="checkbox" checked={draftChoice} onChange={(e) => setDraftChoice(e.target.checked)} />
            Draft a knowledge base article from this fix
          </label>
        )}
      </ConfirmDialog>
    </div>
  )
}

export default TicketPage
