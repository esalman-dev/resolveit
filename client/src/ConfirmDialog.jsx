import { useEffect, useRef } from 'react'

// A reusable "Are you sure?" box for important staff actions (role changes now;
// resolving, reassigning and archiving later on the ticket screens).
//
// It uses the browser's built-in <dialog> element. showModal() gives us, for free:
//   - a dimmed background, and nothing behind it can be clicked
//   - keyboard focus kept inside the box (good for accessibility)
//   - the Escape key closes it (we treat that as "Cancel")
//
// Usage:
//   <ConfirmDialog
//     open={pending !== null}
//     title="Change role?"
//     message="Bob will become a technician."
//     confirmLabel="Change role"
//     onConfirm={...}
//     onCancel={...}
//   />
function ConfirmDialog({ open, title, message, confirmLabel = 'Confirm', danger = false, busy = false, onConfirm, onCancel }) {
  const dialogRef = useRef(null)

  // React decides WHETHER it's open (the `open` prop); this effect tells the browser.
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
      <div className="confirm-buttons">
        {/* Cancel comes first and gets focus, so pressing Enter by accident does nothing harmful */}
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
