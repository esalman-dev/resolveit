// Keyboard shortcuts for staff: one key listener for the whole app.
//
// Each screen that has shortcuts registers its keys while it's on screen (useShortcuts, or the
// <Shortcuts> component). Why one listener and not one per screen: "g" then "k" is "go to the
// Knowledge base", but "k" alone moves up the ticket list. With separate listeners both would
// run; here the listener knows the "k" finished "g k" and stops there.
//
// Keys are written as KeyboardEvent.key gives them: 'j', '?', '/', 'Escape'. A two-key shortcut
// is 'g t': press g, then t within a second.

import { useEffect, useLayoutEffect, useRef } from 'react'

const SEQUENCE_MS = 1000 // how long after "g" the second key still counts

const registered = [] // the key maps of every screen with shortcuts on show, newest last
let waitingSince = 0 // when "g" was pressed, or 0
let listening = false

// Inputs where letters are typed. A tick box or a button isn't typing, so shortcuts still
// work after clicking one.
const TEXT_INPUTS = ['text', 'search', 'email', 'password', 'number', 'url', 'tel', 'date']

/** True when the key press is someone typing, so it must reach the box, not a shortcut. */
function isTyping(target) {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return true
  return target.tagName === 'INPUT' && TEXT_INPUTS.includes(target.type)
}

/**
 * The handler for a key. If two screens ever used the same key, the one registered last would
 * win; today they don't overlap (app-wide: ? and g…; pages: letters and Escape).
 */
function findHandler(key) {
  for (let i = registered.length - 1; i >= 0; i--) {
    const handler = registered[i].current[key]
    if (handler) return handler
  }
  return null
}

function onKeyDown(event) {
  if (event.ctrlKey || event.altKey || event.metaKey || isTyping(event.target)) return
  // An "Are you sure?" box or the shortcuts panel is open: its own keys (Escape) apply.
  if (document.querySelector('dialog[open]')) return

  let handler
  if (waitingSince && Date.now() - waitingSince < SEQUENCE_MS) {
    waitingSince = 0
    handler = findHandler(`g ${event.key}`)
    if (!handler) return // "g" then an unknown key: nothing, and the key isn't used alone
  } else if (event.key === 'g' && findHandler('g t')) {
    waitingSince = Date.now()
    return
  } else {
    waitingSince = 0
    handler = findHandler(event.key)
  }
  if (!handler) return

  // Why: stops the key doing its usual job too, e.g. "/" typing a slash into the search box
  // it just jumped to.
  event.preventDefault()
  handler(event)
}

/**
 * Turns on these shortcuts while the component is on screen.
 * @param keys e.g. { j: next, k: previous, 'g t': () => navigate('/tickets') }
 */
export function useShortcuts(keys) {
  const latest = useRef(keys)
  // The newest handlers, so they always see the current page state without re-registering.
  useLayoutEffect(() => {
    latest.current = keys
  })

  useEffect(() => {
    if (!listening) {
      document.addEventListener('keydown', onKeyDown)
      listening = true
    }
    registered.push(latest)
    return () => {
      registered.splice(registered.indexOf(latest), 1)
    }
  }, [])
}

/**
 * The same as useShortcuts, as a component: render it (staff only) where a page's handlers are
 * ready, even below an early "Loading…" return, where a hook can't go.
 */
export function Shortcuts({ keys }) {
  useShortcuts(keys)
  return null
}
