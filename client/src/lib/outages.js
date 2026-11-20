// Outages: the open outages, for the banner, Get help's "Known issues right now", the staff
// Tickets page and the ticket page. Checked once a minute while the tab is visible, like the bell.
//
// The app shell calls useOutages() once and hands it to pages through the outlet context, so
// every screen shows the same list and an action on one screen updates them all.

import { useCallback, useEffect, useState } from 'react'
import { apiFetch } from './api.js'

const EVERY = 60 * 1000 // one minute

/**
 * Returns { list, refresh, act }. `act` sends one change and shows the list the server sends back:
 * @example await outages.act(12, 'confirm', { message: 'Wi-Fi down in Building B' })
 * @example await outages.act(12, '', { message: 'Also Building C' }, 'PATCH')
 */
export function useOutages() {
  const [list, setList] = useState([])

  const refresh = useCallback(async () => {
    if (document.visibilityState !== 'visible') return
    try {
      setList((await apiFetch('/api/outages')).outages)
    } catch {
      // The next minute tries again.
    }
  }, [])

  useEffect(() => {
    const onVisible = () => document.visibilityState === 'visible' && refresh()
    document.addEventListener('visibilitychange', onVisible)
    const first = setTimeout(refresh, 0)
    const timer = setInterval(refresh, EVERY)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      clearTimeout(first)
      clearInterval(timer)
    }
  }, [refresh])

  /** Throws with the server's message on failure, for the caller to show. */
  async function act(id, action, body, method = 'POST') {
    const path = action ? `/api/outages/${id}/${action}` : `/api/outages/${id}`
    setList((await apiFetch(path, { method, body })).outages)
  }

  return { list, refresh, act }
}
