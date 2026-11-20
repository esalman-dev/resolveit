// Outage cards: on the staff Tickets page, one amber card per open outage.
//   Suspected: "Possible outage · Network · 3 tickets since 10:42" with Confirm… and Not an outage.
//   Confirmed: "Outage · Network · Wi-Fi down… · 5 tickets, 7 people said me too" with
//              Edit message and Mark fixed….
// Every action goes through one "Are you sure?" box (ConfirmDialog); three of them include a text box.

import { useState } from 'react'
import ConfirmDialog from './ConfirmDialog.jsx'
import './OutageCards.css'

// Note: these match MAX_MESSAGE and MAX_FIX_MESSAGE in server/routes/outages.js.
const MAX_MESSAGE = 200
const MAX_FIX_MESSAGE = 2000

/** What each action's box says, and what it sends. */
const ACTIONS = {
  confirm: {
    title: 'Confirm this outage?',
    message: 'Everyone will see this at the top of every page. Say where, if you know.',
    label: 'Message',
    max: MAX_MESSAGE,
    confirmLabel: 'Confirm outage',
    send: (outages, o, text) => outages.act(o.id, 'confirm', { message: text }),
  },
  edit: {
    title: 'Change the message?',
    message: 'Everyone sees the new message straight away.',
    label: 'Message',
    max: MAX_MESSAGE,
    confirmLabel: 'Save',
    send: (outages, o, text) => outages.act(o.id, '', { message: text }, 'PATCH'),
  },
  fix: {
    title: 'Mark this outage fixed?',
    message: 'Every linked ticket is resolved with this message as your reply, and everyone affected is told.',
    label: 'What fixed it?',
    max: MAX_FIX_MESSAGE,
    confirmLabel: 'Mark fixed',
    send: (outages, o, text) => outages.act(o.id, 'fix', { message: text }),
  },
  dismiss: {
    title: 'Not an outage?',
    message: 'The card goes away and its tickets carry on as normal.',
    confirmLabel: 'Not an outage',
    send: (outages, o) => outages.act(o.id, 'dismiss'),
  },
}

const time = (date) => new Date(date).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * @param outages the shared outages object from useOutages (lib/outages.js)
 * @param onChanged called after an action, so the page can reload its tickets (fixing resolves them)
 */
function OutageCards({ outages, onChanged }) {
  const [open, setOpen] = useState(null) // { kind, outage, text } while a box is showing
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  if (outages.list.length === 0) return null

  function start(kind, outage) {
    setError('')
    // The banner adds "We're working on it" itself, so the starting text only says what's down.
    const text = kind === 'confirm' ? `${outage.category_name} problems` : kind === 'edit' ? outage.message : ''
    setOpen({ kind, outage, text })
  }

  async function finish() {
    const action = ACTIONS[open.kind]
    if (action.max && !open.text.trim()) return setError(`${action.label} can't be empty.`)
    setBusy(true)
    setError('')
    try {
      await action.send(outages, open.outage, open.text.trim())
      setOpen(null)
      onChanged?.()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const action = open && ACTIONS[open.kind]

  return (
    <>
      {outages.list.map((o) => (
        <section key={o.id} className="outage-card" aria-label={o.status === 'suspected' ? 'Possible outage' : 'Outage'}>
          <p className="outage-card__text">
            <span aria-hidden="true">⚠ </span>
            <strong>{o.status === 'suspected' ? 'Possible outage' : 'Outage'}</strong> · {o.category_name}
            {o.status === 'confirmed' && <> · {o.message}</>}
            <span className="outage-card__counts">
              {' '}· {plural(o.ticket_count, 'ticket')}
              {o.report_count > 0 && `, ${o.report_count} ${o.report_count === 1 ? 'person' : 'people'} said me too`}
              {o.status === 'suspected' && ` since ${time(o.detected_at)}`}
            </span>
          </p>
          <div className="outage-card__actions">
            {o.status === 'suspected' ? (
              <>
                <button type="button" className="primary" onClick={() => start('confirm', o)}>Confirm…</button>
                <button type="button" onClick={() => start('dismiss', o)}>Not an outage</button>
              </>
            ) : (
              <>
                <button type="button" className="link" onClick={() => start('edit', o)}>Edit message</button>
                <button type="button" className="primary" onClick={() => start('fix', o)}>Mark fixed…</button>
              </>
            )}
          </div>
        </section>
      ))}

      <ConfirmDialog
        open={open !== null}
        title={action?.title ?? ''}
        message={action?.message ?? ''}
        confirmLabel={action?.confirmLabel}
        busy={busy}
        onConfirm={finish}
        onCancel={() => setOpen(null)}
      >
        {action?.max && (
          <label className="outage-card__field">
            {action.label}
            <textarea
              value={open.text}
              maxLength={action.max}
              rows={open.kind === 'fix' ? 4 : 2}
              onChange={(e) => setOpen({ ...open, text: e.target.value })}
            />
          </label>
        )}
        {error && <p className="error" role="alert">{error}</p>}
      </ConfirmDialog>
    </>
  )
}

export default OutageCards
