/**
 * One Roadmap page (a section of the old single Roadmap page) in the docs shell: the Roadmap's
 * sidebar, breadcrumb, the section's article, pager and "On this page" rail.
 *
 * Behaviour carried over from the old page script:
 *  - links inside the article (plain <a href>, see SectionViews.tsx) navigate client-side;
 *  - Feature readiness has a status/site filter; a site plan's "See where the N features it uses
 *    stand" presets the site filter; a link to a row the filter hides clears the filter first, so
 *    the row can be scrolled to (on click, and on back/forward);
 *  - the rail follows the filter (only the categories still shown).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { useRouter, useRouterState } from '@tanstack/react-router'
import { getVersion } from '~/src/lib/content'
import { DocsShell } from '~/src/layout/DocsShell'
import { pagerCard, type Crumb, type NavGroup, type PagerLink } from '~/src/lib/nav'
import { prefersReducedMotion } from '~/src/lib/ui'
import { roadmap as rm } from './instance'
import { plain } from './model'
import { TocInline } from '~/components/mdx/TocInline'
import { NO_FILTER, sectionView, TocSlot, type FeatureFilter } from './SectionViews'
import { DOCS_VERSION, ROADMAP_ROOT, roadmapTarget, SECTION_GROUPS, SECTION_IDS, sectionPath, type SectionId } from './sections'

const BASE = import.meta.env.BASE_URL
const groupOf = (id: SectionId) => SECTION_GROUPS.find((g) => g.ids.includes(id))!.title

function sidebar(current: SectionId): NavGroup[] {
  return SECTION_GROUPS.map((g) => ({
    title: g.title,
    items: g.ids.map((id) => ({ label: rm.SEC[id].nav, to: sectionPath(id), active: id === current })),
  }))
}

function crumbs(id: SectionId): Crumb[] {
  const nav = rm.SEC[id].nav
  const group = groupOf(id)
  return [{ label: 'Roadmap', to: ROADMAP_ROOT }, ...(group !== 'Roadmap' && group !== nav ? [{ label: group }] : []), { label: nav }]
}

/** A section's pager card: a section alone in a group of its name goes by its title ("Overview" says little). */
function card(id: SectionId): PagerLink {
  const nav = rm.SEC[id].nav
  const group = groupOf(id)
  return {
    to: sectionPath(id),
    title: group === nav ? plain(rm.SEC[id].title) : nav,
    sub: group !== 'Roadmap' && group !== nav ? `Roadmap › ${group}` : 'Roadmap',
  }
}

/** One reading order: the next major's docs, then Under the hood, then the Roadmap's sections. */
function pager(id: SectionId): { prev?: PagerLink; next?: PagerLink } {
  const i = SECTION_IDS.indexOf(id)
  const docs = getVersion(DOCS_VERSION)?.pages ?? []
  const prev = i > 0 ? card(SECTION_IDS[i - 1]) : docs.length ? pagerCard(docs[docs.length - 1]) : undefined
  const next = i < SECTION_IDS.length - 1 ? card(SECTION_IDS[i + 1]) : undefined
  return { prev, next }
}

const stripBase = (pathname: string) => (pathname.startsWith(BASE) ? `/${pathname.slice(BASE.length)}` : pathname)

/** The filter survives moving between Roadmap pages (as it did on the old single page). */
let lastFilter: FeatureFilter = NO_FILTER

export default function RoadmapPage({ section }: { section: SectionId }) {
  const router = useRouter()
  const hash = useRouterState({ select: (s) => s.location.hash })
  const [filter, setFilterState] = useState<FeatureFilter>(lastFilter)
  const setFilter = (f: FeatureFilter) => {
    lastFilter = f
    setFilterState(f)
  }

  const view = useMemo(() => sectionView(rm, section, filter, setFilter), [section, filter])

  // A row hidden by the filter can't be scrolled to: clear the filter first.
  const hiddenTarget = (id: string) => {
    const el = id ? document.getElementById(id) : null
    return Boolean(el && el.closest('.gx-sec') && el.closest('[hidden]'))
  }
  const scrollTo = useRef<string | null>(null)
  useEffect(() => {
    const id = decodeURIComponent(hash || '')
    // An old single-page fragment (/roadmap#roadmap-api--x) whose target now lives on another
    // section's page: go there (/roadmap/api#roadmap-api--x), replacing the history entry.
    const target = section === 'roadmap' && id ? roadmapTarget(id) : undefined
    if (target && target.to !== ROADMAP_ROOT) {
      router.navigate({ to: target.to as never, hash: target.hash, replace: true })
      return
    }
    if (section === 'roadmap-features' && hiddenTarget(id)) {
      scrollTo.current = id
      setFilter(NO_FILTER)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hash, section])
  useEffect(() => {
    const id = scrollTo.current
    if (!id) return
    scrollTo.current = null
    document.getElementById(id)?.scrollIntoView({ block: 'start', behavior: 'auto' })
  }, [filter])

  useEffect(() => {
    // Capture phase: runs before the router's own link handling and before a same-hash click
    // (which fires no navigation) is ignored, so the target is visible by the time it scrolls.
    const onCapture = (event: MouseEvent) => {
      const a = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
      if (!a || a.origin !== location.origin || a.pathname !== location.pathname || !a.hash) return
      if (hiddenTarget(decodeURIComponent(a.hash.slice(1)))) flushSync(() => setFilter(NO_FILTER))
    }
    // Bubble phase: links in the article navigate client-side.
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const a = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
      if (!a || !a.closest('.gx-sec') || a.classList.contains('heading-anchor') || a.target || a.origin !== location.origin) return
      if (!(a.pathname === BASE.replace(/\/$/, '') || a.pathname.startsWith(BASE))) return
      const site = a.getAttribute('data-gx-site')
      // "See where the N features it uses stand": preset the site filter, then go.
      if (site) setFilter({ v: '', s: site })
      event.preventDefault()
      const to = stripBase(a.pathname)
      const h = a.hash ? decodeURIComponent(a.hash.slice(1)) : undefined
      if (!h && to === stripBase(location.pathname)) window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
      router.navigate({ to: to as never, hash: h })
    }
    document.addEventListener('click', onCapture, true)
    document.addEventListener('click', onClick)
    return () => {
      document.removeEventListener('click', onCapture, true)
      document.removeEventListener('click', onClick)
    }
  }, [router])

  return (
    <DocsShell nav={sidebar(section)} crumbs={crumbs(section)} pager={pager(section)} rail={view.rail}>
      <TocSlot.Provider value={<TocInline />}>{view.article}</TocSlot.Provider>
    </DocsShell>
  )
}
