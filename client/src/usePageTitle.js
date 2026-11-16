// Page title: sets the heading in the app shell's header and the browser tab's title.

import { useEffect } from 'react'
import { useOutletContext } from 'react-router'

/**
 * Sets the current page's title. Call it at the top of every page inside the app shell.
 *
 * Why: the header belongs to the shell, but only the page knows its own title (a ticket page
 * will show "#12 Wi-Fi won't connect"). The shell hands down `setTitle` through the Outlet.
 *
 * @example
 * usePageTitle('Users') // header shows "Users", the browser tab "Users · ResolveIT"
 */
export function usePageTitle(title) {
  const { setTitle } = useOutletContext()

  useEffect(() => {
    setTitle(title)
    document.title = `${title} · ResolveIT`
    return () => { document.title = 'ResolveIT' } // leaving the page, e.g. on log out
  }, [title, setTitle])
}
