// Pagination: the page bar (← Prev · 1 2 3 … 52 · Next →) under a list the server sends one
// page at a time. The "Showing 26–50 of 1,284" line is showingText in lib/paging.js.
//
// The page number lives in the address (?page=2), so the screen using this decides how to
// change it; this component only draws the buttons. Hidden when everything fits on one page.

import { pageList } from '../lib/paging.js'
import './Pagination.css'

/**
 * The page bar.
 * @param onPage called with the page number to go to
 */
function Pagination({ page, perPage, total, onPage }) {
  const last = Math.max(1, Math.ceil(total / perPage))
  if (last === 1) return null

  return (
    <nav className="pagination" aria-label="Pages">
      <button type="button" onClick={() => onPage(page - 1)} disabled={page === 1}>
        ← Prev
      </button>
      <ol className="pagination__numbers">
        {pageList(page, last).map((n, i) =>
          n === '…' ? (
            <li key={`gap-${i}`} className="pagination__gap" aria-hidden="true">…</li>
          ) : (
            <li key={n}>
              <button
                type="button"
                onClick={() => onPage(n)}
                aria-current={n === page ? 'page' : undefined}
                aria-label={`Page ${n}`}
              >
                {n}
              </button>
            </li>
          )
        )}
      </ol>
      {/* Phones show this instead of the numbers. */}
      <span className="pagination__where">Page {page} of {last}</span>
      <button type="button" onClick={() => onPage(page + 1)} disabled={page === last}>
        Next →
      </button>
    </nav>
  )
}

export default Pagination
