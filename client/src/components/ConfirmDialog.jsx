// Confirm dialog: the reusable "Are you sure?" box for important staff actions.
//
// Built on the browser's own <dialog> element. showModal() provides, for free: a dimmed
// background that can't be clicked, keyboard focus kept inside the box (good for
// accessibility), and Escape to close (treated as Cancel).

import { useEffect, useRef } from 'react'

/**
 * Shows an "Are you sure?" box while `open` is true.
 *
 * @param danger shows a red confirm button, for actions that take something away
 * @param busy disables both buttons and shows "Saving…" while the action runs
 * @param children optional extra content under the message (e.g. a tick box)
 *
 * @example
 * <ConfirmDialog
 *   open={pending !== null}
 *   title="Change role?"
 *   message="Bob will become a technician."
 *   confirmLabel="Change role"
 *   onConfirm={save}
 *   onCancel={() => setPending(null)}
 * />
 */
function ConfirmDialog({ open, title, message, confirmLabel = 'Confirm', danger = false, busy = false, onConfirm, onCancel, children = null }) {
  const dialogRef = useRef(null)

  // React decides whether it's open (the `open` prop); this effect tells the browser.
  useEffect(() => {
    const dialog = dialogRef.current
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  return (
    <dialog
      ref={dialogRef}
      className="confirm"
      aria-labelledby="confirm-title"
      // The browser fires "cancel" when Escape is pressed. preventDefault stops it closing
      // on its own, so React stays in charge, then we run onCancel like the Cancel button.
      onCancel={(e) => {
        e.preventDefault()
        if (!busy) onCancel()
      }}
    >
      <h3 id="confirm-title">{title}</h3>
      <p>{message}</p>
      {children}
      <div className="confirm-buttons">
        {/* Cancel comes first and gets focus, so pressing Enter by accident does nothing harmful. */}
        <button type="button" onClick={onCancel} disabled={busy} autoFocus>
          Cancel
        </button>
        <button type="button" className={danger ? 'danger' : 'primary'} onClick={onConfirm} disabled={busy}>
          {busy ? 'Saving…' : confirmLabel}
        </button>
      </div>
    </dialog>
  )
}

export default ConfirmDialog
