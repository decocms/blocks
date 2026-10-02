/**
 * "Chrome" = what the root layout needs to know about the current page before rendering it:
 * the layout (landing or docs), which header tab is current, and the docs version (for the version
 * select). A route declares it in `staticData.chrome`, or returns it from its loader as
 * `{ chrome }` when it depends on the URL (the doc pages do). The root reads the deepest match.
 */
import { useRouterState } from '@tanstack/react-router'
import { DEFAULT_VERSION } from './versions'

export type Tab = 'home' | 'docs' | 'internals' | 'roadmap' | 'none'

export interface Chrome {
  /** `landing`: full-bleed page, floating header over a dark band. `docs`: three-column docs shell. */
  layout: 'landing' | 'docs'
  /** The header tab marked current. */
  tab: Tab
  /** Docs version shown in the version select (defaults to DEFAULT_VERSION). */
  version?: string
  /** Current page slug inside the version, so switching versions can keep the page. */
  slug?: string
}

declare module '@tanstack/react-router' {
  interface StaticDataRouteOption {
    chrome?: Chrome
  }
}

const FALLBACK: Chrome = { layout: 'docs', tab: 'none' }

export function useChrome(): Chrome & { version: string } {
  const chrome = useRouterState({
    select: (s) => {
      for (let i = s.matches.length - 1; i >= 0; i--) {
        const m = s.matches[i]
        const fromLoader = (m.loaderData as { chrome?: Chrome } | undefined)?.chrome
        if (fromLoader) return fromLoader
        if (m.staticData?.chrome) return m.staticData.chrome
      }
      return FALLBACK
    },
  })
  return { ...chrome, version: chrome.version ?? DEFAULT_VERSION }
}
