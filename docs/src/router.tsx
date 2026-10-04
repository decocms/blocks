import { createRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'
import { preloadForPath } from './lib/content'
import { NotFound } from './layout/NotFound'

/**
 * GitHub Pages also serves a page under its file name (/next/quickstart.html, /next/index.html).
 * Before the router reads the URL, show the page's own URL instead, which is also the URL its
 * HTML was prerendered for, so hydration matches it.
 */
function canonicalizeFileUrl() {
  if (typeof window === 'undefined') return
  const { pathname, search, hash } = window.location
  const clean = pathname.replace(/\/index\.html$/, '/').replace(/\.html$/, '')
  if (clean !== pathname) window.history.replaceState(window.history.state, '', clean + search + hash)
}

export function getRouter() {
  canonicalizeFileUrl()
  return createRouter({
    routeTree,
    basepath: import.meta.env.BASE_URL,
    trailingSlash: 'preserve',
    scrollRestoration: true,
    defaultPreload: 'intent',
    defaultNotFoundComponent: NotFound,
    // Load the current page's MDX chunk before hydrating, so the first client render matches the
    // prerendered HTML without suspending (see src/lib/content.ts).
    hydrate: async () => {
      await preloadForPath(window.location.pathname)
    },
  })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
