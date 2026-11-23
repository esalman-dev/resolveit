// Account menu: your name in the header, and the panel it opens (Theme, Profile, Log out).
//
// The theme choice is saved in this browser (lib/theme.js) and shows at once. Escape or a click
// outside closes the panel.

import { useRef, useState } from 'react'
import { Link } from 'react-router'
import { getThemeChoice, setThemeChoice } from '../lib/theme.js'
import { useDismiss } from '../lib/useDismiss.js'
import './AccountMenu.css'

const THEMES = [
  ['system', 'System'],
  ['light', 'Light'],
  ['dark', 'Dark'],
]

/** The name button and its panel, for everyone. */
function AccountMenu({ user, onLogout }) {
  const [open, setOpen] = useState(false)
  const [theme, setTheme] = useState(getThemeChoice) // which of the three buttons is pressed
  const wrapper = useRef(null)
  const button = useRef(null)
  useDismiss(open, setOpen, wrapper, button)

  /** Saves and shows the theme. The panel stays open, so people can try each one. */
  function pickTheme(choice) {
    setThemeChoice(choice)
    setTheme(choice)
  }

  return (
    <div className="account" ref={wrapper}>
      <button
        ref={button}
        type="button"
        className="account__button"
        aria-expanded={open}
        aria-controls="account-panel"
        onClick={() => setOpen(!open)}
      >
        {user.name} <span className="account__role">({user.role})</span>
        <span className="account__arrow" aria-hidden="true">▾</span>
      </button>

      {open && (
        <section id="account-panel" className="account__panel" aria-label="Account">
          <div className="account__who">
            <strong>{user.name}</strong>
            {(user.job_title || user.department) && (
              <span className="account__work">{[user.job_title, user.department].filter(Boolean).join(' · ')}</span>
            )}
            <span className="account__role">{user.role}</span>
          </div>

          <div className="account__section" role="group" aria-labelledby="account-theme">
            <span id="account-theme" className="account__label">Theme</span>
            {/* Why buttons with aria-pressed, not a dropdown: all three choices show at once,
                and screen readers announce the chosen one as "pressed". */}
            <div className="account__themes">
              {THEMES.map(([value, label]) => (
                <button key={value} type="button" aria-pressed={theme === value} onClick={() => pickTheme(value)}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="account__section">
            {/* A link, since it goes to a page; it closes the menu on the way. */}
            <Link className="button-link account__profile" to="/profile" onClick={() => setOpen(false)}>
              Profile
            </Link>
          </div>

          <div className="account__section">
            <button type="button" className="account__logout" onClick={onLogout}>Log out</button>
          </div>
        </section>
      )}
    </div>
  )
}

export default AccountMenu
