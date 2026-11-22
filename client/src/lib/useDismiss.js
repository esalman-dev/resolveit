// Closing a pop-up panel (the bell, the account menu) the way people expect.

import { useEffect } from 'react'

/**
 * While a panel is open: Escape closes it and puts focus back on its button; a click anywhere
 * outside the panel and its button closes it.
 *
 * @param {boolean} open is the panel showing?
 * @param {(open: boolean) => void} setOpen the panel's state setter (called with false)
 * @param wrapper a ref to the element holding both the button and the panel
 * @param button a ref to the button that opens it
 */
export function useDismiss(open, setOpen, wrapper, button) {
  useEffect(() => {
    if (!open) return
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setOpen(false)
        button.current?.focus()
      }
    }
    const onClick = (e) => {
      if (!wrapper.current?.contains(e.target)) setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onClick)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onClick)
    }
  }, [open, setOpen, wrapper, button])
}
