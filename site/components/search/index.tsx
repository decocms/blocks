/**
 * ⌘K search: the dialog, on top of Pagefind's index of the prerendered pages.
 *
 * - Mounted once, globally (src/layout/GlobalUi.tsx picks up this default export). Opens on the
 *   `docs:search-open` window event (the header's search button, the drawer's, ⌘K / Ctrl+K and
 *   `/`); ⌘K again, Esc, the Esc button or a click on the backdrop close it.
 * - Searches the current docs version, the Roadmap and Home. Each page tags itself with a
 *   `scope` Pagefind filter (rendered below, in the prerendered HTML): the version id on doc
 *   pages, `roadmap`, `home`. So /v7/ pages never show up while reading /next/ and vice versa.
 * - A result is a page or one of its headings (Pagefind sub-results), shown with its context
 *   ("Docs › Core concepts", "Docs › Quickstart"), the matched title and an excerpt. Outside the
 *   Roadmap, docs results come first and Roadmap ones follow (at least three kept), as before.
 * - Combobox pattern: focus stays in the input, ↑/↓ move the active option
 *   (aria-activedescendant), Enter opens it; Tab also reaches the links themselves (and ↑/↓ from
 *   a link return to the input).
 *
 * Markup and classes are the old site's (#search-dialog, .search-head, .search-results, .sr-*).
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useRouter } from '@tanstack/react-router'
import { Icon } from '~/components/ui/Icon'
import { useChrome } from '~/src/lib/chrome'
import { findPage, getVersion, pageForPath, stripBase, type ManifestPage } from '~/src/lib/content'
import { KIND_LABELS } from '~/src/lib/nav'
import { closeMenu, SEARCH_OPEN_EVENT } from '~/src/lib/ui'
import { excerptParts, loadPagefind, decodeEntities, tidyExcerpt, type Pagefind, type PagefindData, type PagefindSubResult } from './pagefind'

const BASE = import.meta.env.BASE_URL
const MAX_ROWS = 20
/** Pages whose data is fetched per query (each is one small request). */
const MAX_PAGES = 24
/** Headings shown per page, best matches first. */
const MAX_SUBS = 3
const SUGGESTIONS = ['quickstart', 'model', 'routing', 'preview', 'standalone', 'nextjs', 'walkthrough', 'troubleshooting']

type Area = 'docs' | 'roadmap' | 'home'

interface Row {
  key: string
  /** Router path without the base path, e.g. /next/quickstart. */
  to: string
  hash?: string
  /** heading = a section inside a page (hash icon), page = the page itself (file icon). */
  kind: 'page' | 'heading'
  path: string
  title: string
  excerpt?: string
  area: Area
}

const toHref = (to: string, hash?: string) => `${BASE.replace(/\/$/, '')}${to}${hash ? `#${hash}` : ''}`

/** A page as a result: the pager's title rule, and "Docs › Group" when the group adds anything. */
function pageRow(page: ManifestPage, excerpt?: string): Row {
  const kindLabel = KIND_LABELS[page.kind]
  const group = page.group !== kindLabel && page.group !== page.nav ? ` › ${page.group}` : ''
  return {
    key: page.path,
    to: page.path,
    kind: 'page',
    path: kindLabel + group,
    title: page.group === page.nav ? page.title : page.nav,
    excerpt,
    area: 'docs',
  }
}

/** Heading results ranked by how strongly they match (Pagefind lists them in page order). */
function bestSubs(subs: PagefindSubResult[]): PagefindSubResult[] {
  const weight = (s: PagefindSubResult) =>
    s.weighted_locations?.reduce((sum, l) => sum + l.balanced_score, 0) ?? s.locations?.length ?? 0
  return subs
    .map((s, i) => ({ s, i, w: weight(s) }))
    .sort((a, b) => b.w - a.w || a.i - b.i)
    .slice(0, MAX_SUBS)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.s)
}

function rowsFor(data: PagefindData): Row[] {
  const [rawPath] = data.url.split('#')
  const to = stripBase(rawPath).replace(/\.html$/, '') || '/'
  const page = pageForPath(to)
  const area: Area = page ? 'docs' : to === '/roadmap' || to.startsWith('/roadmap/') ? 'roadmap' : 'home'
  const label = page ? KIND_LABELS[page.kind] : area === 'roadmap' ? 'Roadmap' : 'Home'
  const pageTitle = decodeEntities(data.meta.title ?? '')
  const subs = bestSubs(data.sub_results ?? [])
  const rows: Row[] = []
  for (const sub of subs.length ? subs : [{ title: pageTitle, url: data.url, excerpt: data.excerpt }]) {
    const hash = sub.url.split('#')[1]
    if (!hash || sub.anchor?.element === 'h1') {
      // The top of the page.
      const base: Row = page
        ? pageRow(page)
        : { key: to, to, kind: 'page', path: label, title: area === 'home' ? 'Overview' : pageTitle, area }
      rows.push({ ...base, key: `${to}#`, excerpt: tidyExcerpt(sub.excerpt, sub.anchor?.element === 'h1' ? sub.title : undefined) })
    } else {
      rows.push({
        key: `${to}#${hash}`,
        to,
        hash: decodeURIComponent(hash),
        kind: 'heading',
        path: page ? `${label} › ${page.nav}` : label,
        title: decodeEntities(sub.title),
        excerpt: tidyExcerpt(sub.excerpt, sub.title),
        area,
      })
    }
  }
  const seen = new Set<string>()
  return rows.filter((r) => !seen.has(r.key) && !!seen.add(r.key))
}

function suggestionRows(version: string): Row[] {
  const picked = SUGGESTIONS.map((slug) => findPage(version, slug)).filter((p): p is ManifestPage => !!p)
  const pages = picked.length >= 4 ? picked : (getVersion(version)?.pages ?? []).slice(0, 8)
  return pages.map((p) => pageRow(p))
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function Highlight({ text, words }: { text: string; words: string[] }) {
  if (!words.length) return <>{text}</>
  const re = new RegExp(`(${words.map(escapeRe).join('|')})`, 'gi')
  return <>{text.split(re).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part))}</>
}

type Status = { kind: 'idle' } | { kind: 'loading' } | { kind: 'results'; rows: Row[]; label: string } | { kind: 'empty' } | { kind: 'unavailable' }

export default function SearchDialog() {
  const chrome = useChrome()
  const router = useRouter()
  const scope = chrome.tab === 'home' ? 'home' : chrome.tab === 'roadmap' ? 'roadmap' : chrome.tab === 'none' ? null : chrome.version
  const dialogRef = useRef<HTMLDialogElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const resultsRef = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [active, setActive] = useState(0)
  const seq = useRef(0)
  const pagefind = useRef<Pagefind | null | undefined>(undefined)

  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
  const rows = !words.length ? suggestionRows(chrome.version) : status.kind === 'results' ? status.rows : []

  const run = useCallback(
    async (q: string) => {
      const id = ++seq.current
      if (!q.trim()) {
        setStatus({ kind: 'idle' })
        setActive(0)
        return
      }
      if (pagefind.current === undefined) setStatus({ kind: 'loading' })
      const pf = await loadPagefind()
      pagefind.current = pf
      if (id !== seq.current) return
      if (!pf) return setStatus({ kind: 'unavailable' })
      // A short pause first, so a fast typist doesn't fetch results for every letter.
      await new Promise((r) => setTimeout(r, 80))
      if (id !== seq.current) return
      const res = await pf.search(q, { filters: { scope: { any: [chrome.version, 'roadmap', 'home'] } } })
      if (id !== seq.current) return
      const datas = await Promise.all(res.results.slice(0, MAX_PAGES).map((r) => r.data()))
      if (id !== seq.current) return
      let all = datas.flatMap(rowsFor)
      // Home results go last; outside the Roadmap, its many sections follow the docs.
      const by = (a: Area) => all.filter((r) => r.area === a)
      if (chrome.tab !== 'roadmap') {
        const docs = by('docs')
        const roadmap = by('roadmap')
        const mine = docs.slice(0, MAX_ROWS - Math.min(3, roadmap.length))
        all = [...mine, ...roadmap.slice(0, MAX_ROWS - mine.length), ...by('home')]
      } else all = [...by('roadmap'), ...by('docs'), ...by('home')]
      all = all.slice(0, MAX_ROWS)
      setActive(0)
      if (!all.length) return setStatus({ kind: 'empty' })
      const label = `${all.length}${all.length === 1 ? ' result' : ' results'}${all.length === MAX_ROWS ? ', best matches first' : ''}`
      setStatus({ kind: 'results', rows: all, label })
    },
    [chrome.version, chrome.tab],
  )

  const close = useCallback(() => {
    const d = dialogRef.current
    if (d?.open) d.close()
  }, [])

  // Open (or, from ⌘K while open, close) on the shell's event.
  useEffect(() => {
    const onOpen = () => {
      const d = dialogRef.current
      if (!d) return
      if (d.open) return d.close()
      closeMenu()
      setQuery('')
      seq.current++
      setStatus({ kind: 'idle' })
      setActive(0)
      d.showModal()
      inputRef.current?.focus()
      void loadPagefind() // warm it up while the reader types
    }
    window.addEventListener(SEARCH_OPEN_EVENT, onOpen)
    return () => window.removeEventListener(SEARCH_OPEN_EVENT, onOpen)
  }, [])

  // Keep the active option in view.
  useEffect(() => {
    resultsRef.current?.querySelector<HTMLElement>(`#search-opt-${active}`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const go = useCallback(
    async (row: Row) => {
      close()
      closeMenu()
      await router.navigate({ to: row.to, hash: row.hash } as never)
      // After the page renders: open any <details> around the target, then bring it into view.
      requestAnimationFrame(() => {
        const target = row.hash ? document.getElementById(row.hash) : null
        if (!target) return
        for (let d = target.closest('details'); d; d = d.parentElement?.closest('details') ?? null) d.open = true
        target.scrollIntoView({ block: 'start' })
      })
    },
    [close, router],
  )

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDialogElement>) => {
    const links = [...(resultsRef.current?.querySelectorAll<HTMLAnchorElement>('a[role="option"]') ?? [])]
    if (event.key === 'Escape') {
      event.preventDefault()
      return close()
    }
    if (!links.length) return
    const last = links.length - 1
    const current = Math.min(active, last)
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setActive(event.key === 'ArrowDown' ? Math.min(last, current + 1) : Math.max(0, current - 1))
      if (document.activeElement !== inputRef.current) inputRef.current?.focus()
    } else if (event.key === 'Enter' && document.activeElement === inputRef.current) {
      event.preventDefault()
      links[current]?.click()
    }
  }

  const statusText =
    status.kind === 'results' ? `${status.label}.` : status.kind === 'empty' ? 'No results.' : status.kind === 'unavailable' ? 'Search is not available.' : ''
  const hasOptions = rows.length > 0

  return (
    <>
      {/* The page's search scope, read by Pagefind when it indexes the built HTML. */}
      {scope && <span hidden data-pagefind-filter={`scope:${scope}`} />}
      <dialog
        id="search-dialog"
        aria-label="Search documentation"
        ref={dialogRef}
        onKeyDown={onKeyDown}
        onClick={(event) => {
          // A click on the backdrop (outside the dialog box) closes it.
          if (event.target !== event.currentTarget) return
          const r = event.currentTarget.getBoundingClientRect()
          if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) close()
        }}
      >
        <div className="search-head">
          <Icon name="search" />
          <input
            ref={inputRef}
            id="search-input"
            type="search"
            placeholder="Search concepts, APIs, frameworks…"
            aria-label="Search docs"
            autoComplete="off"
            spellCheck={false}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={hasOptions}
            aria-controls="search-results"
            aria-activedescendant={hasOptions ? `search-opt-${Math.min(active, rows.length - 1)}` : undefined}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              void run(e.target.value)
            }}
          />
          <button className="search-close" id="search-close" type="button" aria-label="Esc: close search" onClick={close}>
            Esc
          </button>
        </div>
        <div className="search-results" id="search-results" role="listbox" aria-label="Search results" ref={resultsRef}>
          {!words.length && rows.length > 0 && (
            <p className="search-label" aria-hidden="true">
              Suggested
            </p>
          )}
          {words.length > 0 && status.kind === 'results' && (
            <p className="search-label" aria-hidden="true">
              {status.label}
            </p>
          )}
          {words.length > 0 && status.kind === 'loading' && (
            <p className="search-empty" aria-hidden="true">
              Loading the search index…
            </p>
          )}
          {words.length > 0 && status.kind === 'empty' && (
            <p className="search-empty" aria-hidden="true">
              No matching sections. Try “schema”, “rollback”, or “TanStack”.
            </p>
          )}
          {words.length > 0 && status.kind === 'unavailable' && (
            <p className="search-empty">
              Search works on the built site. Run <code>bun run build</code>, then <code>bun run preview</code>.
            </p>
          )}
          {rows.map((row, i) => {
            const on = i === Math.min(active, rows.length - 1)
            return (
              <a
                key={row.key}
                id={`search-opt-${i}`}
                role="option"
                aria-selected={on}
                className={on ? 'is-active' : undefined}
                href={toHref(row.to, row.hash)}
                onMouseMove={() => !on && setActive(i)}
                onClick={(event) => {
                  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
                  event.preventDefault()
                  void go(row)
                }}
              >
                <span className="sr-icon">
                  <Icon name={row.kind === 'heading' ? 'hash' : 'file'} />
                </span>
                <span className="sr-body">
                  <span className="sr-path">{row.path}</span>
                  <span className="sr-title">
                    <Highlight text={row.title} words={words} />
                  </span>
                  {words.length > 0 && row.excerpt && (
                    <span className="sr-snip">
                      {excerptParts(row.excerpt).map((p, j) => (p.mark ? <mark key={j}>{p.text}</mark> : p.text))}
                    </span>
                  )}
                </span>
                <span className="sr-enter">
                  <Icon name="corner" />
                </span>
              </a>
            )
          })}
        </div>
        <p className="sr-only" id="search-status" role="status">
          {statusText}
        </p>
        <div className="search-hint">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> to move
          </span>
          <span>
            <kbd>↵</kbd> to open
          </span>
          <span className="sh-note">Searches all documentation, including code examples.</span>
        </div>
      </dialog>
    </>
  )
}
