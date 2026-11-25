// Client entry point: loads the styles and starts the React app.

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import './styles/theme.css' // color and size variables; must load before the files that use them
import './index.css'
import { Analytics } from '@vercel/analytics/react'
import App from './App.jsx'
import { applyTheme } from './lib/theme.js'

// The page already has its theme (a small script in index.html sets it before anything is
// drawn). This sets it again with the app's own code, and loading theme.js starts it following
// the computer's setting.
applyTheme()

// StrictMode runs extra checks in development only (it has no effect in the production build).
// BrowserRouter reads the address bar, so App can show the page that matches it.
// Analytics counts page views on the live site (no cookies); it sends nothing in development.
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
    <Analytics />
  </StrictMode>,
)
