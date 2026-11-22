// Theme: light or dark mode, and the person's choice of System, Light or Dark.
//
// The choice is saved in this browser (localStorage), not the account, so it works on the login
// page too. The theme being shown goes on the page as <html data-theme="light"> or "dark", and
// theme.css picks its colors from that.

const STORAGE_KEY = 'resolveit_theme'
const CHOICES = ['system', 'light', 'dark']

// Asks the browser whether the computer is set to dark mode. It also tells us when that changes.
const computerDark = window.matchMedia('(prefers-color-scheme: dark)')

/** The saved choice: 'system', 'light' or 'dark'. 'system' when nothing (or nonsense) is saved. */
export function getThemeChoice() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    return CHOICES.includes(saved) ? saved : 'system'
  } catch {
    return 'system' // storage blocked (some private windows): fall back to the default
  }
}

/**
 * Turns a choice into the theme to actually show.
 *
 * @param {'system' | 'light' | 'dark'} choice
 * @returns {'light' | 'dark'}
 */
export function resolveTheme(choice) {
  if (choice === 'system') {
    return computerDark.matches ? 'dark' : 'light'
  }
  return choice
}

/** Puts the theme to show on the page, as <html data-theme="...">. */
export function applyTheme() {
  document.documentElement.dataset.theme = resolveTheme(getThemeChoice())
}

/** Saves a new choice and shows it at once. */
export function setThemeChoice(choice) {
  try {
    localStorage.setItem(STORAGE_KEY, choice)
  } catch {
    // Storage blocked: the theme still changes, it just isn't remembered next time.
  }
  applyTheme()
}

// Why: on "System", the app follows the computer even when it switches while the app is open
// (some computers go dark at sunset). On "Light" or "Dark", applyTheme changes nothing.
computerDark.addEventListener('change', applyTheme)
