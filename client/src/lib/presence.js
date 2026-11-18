// Presence: who's online, and (for staff) the once-a-minute check-in that keeps you online.
//
// While a staff member's tab is visible, it checks in every minute, saying whether the mouse or
// keyboard was used since the last check-in (only whether, never what). The server turns that
// into Available / Busy / Away / Offline (see server/routes/presence.js). Everyone also fetches
// how many staff are online, for the sidebar.

import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch } from './api.js'

const EVERY = 60 * 1000 // one minute

/** The words for each status. */
export const STATUS_LABELS = { available: 'Available', busy: 'Busy', away: 'Away', offline: 'Offline' }

/**
 * Online status for the app shell.
 * Returns { online, available, staff, me, setAvailability }: `staff` (who's online) and `me`
 * (your own status) only for staff; `setAvailability('busy')` changes yours.
 */
export function usePresence(isStaff) {
  const [presence, setPresence] = useState({ online: null, available: null, staff: [], me: null })
  const active = useRef(true) // was the mouse or keyboard used since the last check-in?

  const refresh = useCallback(async () => {
    if (document.visibilityState !== 'visible') return // a hidden tab doesn't count as being here
    try {
      if (isStaff) {
        await apiFetch('/api/presence/heartbeat', { method: 'POST', body: { active: active.current } })
        active.current = false
      }
      const data = await apiFetch('/api/presence')
      setPresence((p) => ({ ...p, ...data }))
    } catch {
      // Not important enough to show an error: the next minute tries again.
    }
  }, [isStaff])

  useEffect(() => {
    const markActive = () => {
      active.current = true
    }
    const events = ['pointerdown', 'pointermove', 'keydown', 'wheel']
    for (const name of events) window.addEventListener(name, markActive, { passive: true })
    // Coming back to the tab checks in at once, instead of waiting for the next minute.
    const onVisible = () => document.visibilityState === 'visible' && refresh()
    document.addEventListener('visibilitychange', onVisible)
    const first = setTimeout(refresh, 0) // the first check-in right after the page appears
    const timer = setInterval(refresh, EVERY)
    return () => {
      for (const name of events) window.removeEventListener(name, markActive)
      document.removeEventListener('visibilitychange', onVisible)
      clearTimeout(first)
      clearInterval(timer)
    }
  }, [refresh])

  /** Sets your own status and shows it straight away. */
  async function setAvailability(availability) {
    const data = await apiFetch('/api/presence/me', { method: 'PUT', body: { availability } })
    setPresence((p) => ({ ...p, me: data.me }))
    refresh()
  }

  return { ...presence, setAvailability }
}
