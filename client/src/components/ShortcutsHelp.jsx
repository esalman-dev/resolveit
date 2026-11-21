// Shortcuts help: the "Keyboard shortcuts" panel staff open with "?" or the footer button.
//
// Built on <dialog>, like ConfirmDialog: Escape closes it, focus stays inside while it's open,
// and the shortcuts themselves are paused (lib/shortcuts.js skips keys while a dialog is open).

import { useEffect, useRef } from 'react'
import './ShortcutsHelp.css'

// What the panel lists. Must match the keys registered in AppShell, TicketsPage and TicketPage.
const GROUPS = [
  {
    title: 'Anywhere',
    keys: [
      [['?'], 'Show these shortcuts'],
      [['g', 't'], 'Go to Tickets'],
      [['g', 'd'], 'Go to Dashboard'],
      [['g', 'k'], 'Go to Knowledge base'],
    ],
  },
  {
    title: 'Ticket list',
    keys: [
      [['j'], 'Next ticket'],
      [['k'], 'Previous ticket'],
      [['Enter'], 'Open it'],
      [['/'], 'Search'],
      [['n'], 'New hire'],
    ],
  },
  {
    title: 'Ticket page',
    keys: [
      [['a'], 'Assign to me'],
      [['c'], 'Write a comment'],
      [['r'], 'Resolve'],
      [['Esc'], 'Back to the list'],
    ],
  },
]

function ShortcutsHelp({ open, onClose }) {
  const dialogRef = useRef(null)

  // React decides whether it's open; this tells the browser (as in ConfirmDialog).
  useEffect(() => {
    const dialog = dialogRef.current
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  return (
    <dialog
      ref={dialogRef}
      className="shortcuts-help"
      aria-labelledby="shortcuts-help-title"
      onCancel={(e) => {
        e.preventDefault() // Escape: let React close it, so `open` stays true to the screen
        onClose()
      }}
      // "?" closes it too, so the same key opens and closes it.
      // Why stopPropagation: React closes the panel straight away, so by the time this key
      // press reached the app's shortcut listener no box would be open, and "?" would open
      // the panel again.
      onKeyDown={(e) => {
        if (e.key !== '?') return
        e.stopPropagation()
        onClose()
      }}
    >
      <h3 id="shortcuts-help-title">Keyboard shortcuts</h3>
      <div className="shortcuts-help__groups">
        {GROUPS.map((group) => (
          <section key={group.title}>
            <h4 className="shortcuts-help__group">{group.title}</h4>
            <dl className="shortcuts-help__list">
              {group.keys.map(([keys, what]) => (
                <div key={what} className="shortcuts-help__row">
                  <dt>
                    {keys.map((k, i) => (
                      <span key={k}>
                        {i > 0 && <span className="shortcuts-help__then"> then </span>}
                        <kbd>{k}</kbd>
                      </span>
                    ))}
                  </dt>
                  <dd>{what}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
      <p className="hint">They don't work while you're typing in a box.</p>
      <div className="confirm-buttons">
        <button type="button" onClick={onClose} autoFocus>Close</button>
      </div>
    </dialog>
  )
}

export default ShortcutsHelp
