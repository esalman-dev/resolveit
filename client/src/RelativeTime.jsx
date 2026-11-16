// Relative time: shows a date as "2 hours ago", with the exact date and time on hover.

/** The steps from seconds up to years, each with how many seconds it holds. */
const UNITS = [
  ['year', 365 * 24 * 60 * 60],
  ['month', 30 * 24 * 60 * 60],
  ['week', 7 * 24 * 60 * 60],
  ['day', 24 * 60 * 60],
  ['hour', 60 * 60],
  ['minute', 60],
]

// Intl.RelativeTimeFormat is built into the browser, so no date library is needed.
// numeric: 'auto' gives "yesterday" instead of "1 day ago".
const format = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

/**
 * Turns a date into words relative to now.
 * @example timeAgo(ticket.created_at) // "3 hours ago"
 */
function timeAgo(date) {
  const seconds = (new Date(date).getTime() - Date.now()) / 1000 // negative = in the past
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit)
  }
  return 'just now'
}

/**
 * A <time> element that reads "2 hours ago" and shows the full date as a tooltip.
 *
 * Note: the words are worked out when the page draws, so they don't tick forward while the
 * page stays open. A refresh updates them.
 */
function RelativeTime({ date }) {
  return (
    <time dateTime={new Date(date).toISOString()} title={new Date(date).toLocaleString()}>
      {timeAgo(date)}
    </time>
  )
}

export default RelativeTime
