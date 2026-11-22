// Paging helpers for lists the server sends one page at a time (see components/Pagination.jsx).

/**
 * The page numbers to show: always the first and last, the current one and its neighbours,
 * and '…' for the gaps. At most 7 entries.
 * @example pageList(2, 52) // [1, 2, 3, 4, 5, '…', 52]
 * @example pageList(26, 52) // [1, '…', 25, 26, 27, '…', 52]
 */
export function pageList(page, last) {
  if (last <= 7) return Array.from({ length: last }, (_, i) => i + 1)
  if (page <= 4) return [1, 2, 3, 4, 5, '…', last]
  if (page >= last - 3) return [1, '…', last - 4, last - 3, last - 2, last - 1, last]
  return [1, '…', page - 1, page, page + 1, '…', last]
}

/**
 * The words above a list: "8 tickets" when it all fits on one page, otherwise
 * "Showing 26–50 of 1,284 tickets".
 * @param {[string, string]} nouns the word for one and for many, e.g. ['ticket', 'tickets']
 */
export function showingText(page, perPage, total, [one, many]) {
  const noun = total === 1 ? one : many
  if (total <= perPage) return `${total.toLocaleString()} ${noun}`
  const from = (page - 1) * perPage + 1
  const to = Math.min(page * perPage, total)
  return `Showing ${from.toLocaleString()}–${to.toLocaleString()} of ${total.toLocaleString()} ${noun}`
}
