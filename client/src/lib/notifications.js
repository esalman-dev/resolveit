// Notifications: the bell's data. Checked once a minute while the tab is visible, and at once
// when you come back to it, like online status (lib/presence.js). No live connection: the free
// server sleeps when idle, and a minute's delay is fine for "Sam replied on #12".

import { useCallback, useEffect, useState } from 'react'
import { apiFetch } from './api.js'

const EVERY = 60 * 1000 // one minute

/**
 * The bell's notifications for the app shell.
 * Returns { items, unread, refresh, markRead(id), markAllRead() }. `unread` is null until the
 * first check answers.
 */
export function useNotifications() {
  const [state, setState] = useState({ items: [], unread: null })

  const refresh = useCallback(async () => {
    if (document.visibilityState !== 'visible') return
    try {
      const data = await apiFetch('/api/notifications')
      setState({ items: data.notifications, unread: data.unread })
    } catch {
      // Not important enough to show an error: the next minute tries again.
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

  /** Marks one read on screen straight away, then tells the server. */
  function markRead(id) {
    setState((s) => {
      const target = s.items.find((n) => n.id === id)
      if (!target || target.read_at) return s
      const now = new Date().toISOString()
      return { items: s.items.map((n) => (n.id === id ? { ...n, read_at: now } : n)), unread: Math.max(0, s.unread - 1) }
    })
    apiFetch(`/api/notifications/${id}/read`, { method: 'POST' }).catch(() => {})
  }

  /** Marks everything read, on screen and on the server. */
  async function markAllRead() {
    const now = new Date().toISOString()
    setState((s) => ({ items: s.items.map((n) => ({ ...n, read_at: n.read_at ?? now })), unread: 0 }))
    await apiFetch('/api/notifications/read-all', { method: 'POST' }).catch(() => {})
  }

  return { ...state, refresh, markRead, markAllRead }
}

/**
 * The one line a notification shows, without the ticket's title.
 * @example notificationText({ kind: 'reply', ticket_id: 12, actor_name: 'Sam' }) // "Sam replied on #12"
 */
export function notificationText({ kind, ticket_id: id, actor_name: actor }) {
  const who = actor ?? 'Someone' // an account deleted since
  switch (kind) {
    case 'assigned':
      return actor ? `${actor} assigned #${id} to you` : `#${id} was assigned to you automatically`
    case 'reply':
      return `${who} replied on #${id}`
    case 'internal_note':
      return `${who} added an internal note on #${id}`
    case 'resolved':
      return `#${id} was resolved`
    case 'reopened':
      return `#${id} was reopened`
    case 'overdue_reply':
      return `#${id} is overdue (reply)`
    case 'overdue_fix':
      return `#${id} is overdue (fix)`
    default:
      return `Something changed on #${id}`
  }
}
