// Client entry point: loads the styles and starts the React app.

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import './styles/theme.css' // color and size variables; must load before the files that use them
import './index.css'
import App from './App.jsx'

// StrictMode runs extra checks in development only (it has no effect in the production build).
// BrowserRouter reads the address bar, so App can show the page that matches it.
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
