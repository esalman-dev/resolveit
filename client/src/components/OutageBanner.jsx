// Outage banner: "Known issue: Wi-Fi down in Building B · We're working on it" at the top of
// every page, one line per confirmed outage. Suspected ones (staff only) never show here.

import './OutageBanner.css'

/** @param outages the open outages from useOutages (lib/outages.js) */
function OutageBanner({ outages }) {
  const confirmed = outages.filter((o) => o.status === 'confirmed')
  if (confirmed.length === 0) return null

  return (
    // role="status": screen readers announce it politely when it appears.
    <div className="outage-banner" role="status">
      {confirmed.map((o) => (
        // app-shell__column lines the text up with the page below.
        <p key={o.id} className="app-shell__column outage-banner__line">
          <span aria-hidden="true">⚠ </span>
          {/* The staff message may or may not end in a full stop, so "·" separates the parts. */}
          <strong>Known issue:</strong> {o.message} · We're working on it
          <span className="outage-banner__since">
            {' '}· since {new Date(o.confirmed_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
          </span>
        </p>
      ))}
    </div>
  )
}

export default OutageBanner
