// Paging: reading "which page" from a request, for lists the database sends one page at a time.
//
// The client asks with ?page=2&per_page=25 and gets back { page, per_page, total } with the rows,
// so it can show "Showing 26–50 of 1,284" and the page numbers.

const DEFAULT_PER_PAGE = 25;
const MAX_PER_PAGE = 100; // so one request can't ask for the whole table

/**
 * The page and page size asked for, with sensible fallbacks for missing or odd values.
 * @example readPaging({ page: '3', per_page: '50' }) // { page: 3, perPage: 50 }
 */
export function readPaging(query) {
  const page = Number.parseInt(query.page, 10);
  const perPage = Number.parseInt(query.per_page, 10);
  return {
    page: Number.isInteger(page) && page > 0 ? page : 1,
    perPage: Number.isInteger(perPage) && perPage > 0 ? Math.min(perPage, MAX_PER_PAGE) : DEFAULT_PER_PAGE,
  };
}

/**
 * The page to actually show: a page past the end (the list got shorter since the link was
 * made) becomes the last page.
 * @returns {{ page: number, offset: number }} offset: rows to skip
 */
export function clampPage(page, perPage, total) {
  const last = Math.max(1, Math.ceil(total / perPage));
  const shown = Math.min(page, last);
  return { page: shown, offset: (shown - 1) * perPage };
}

/** Turns typed text into a LIKE pattern that matches it anywhere, with % and _ taken literally. */
export const containsPattern = (text) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
