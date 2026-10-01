import { createContext, useContext, useEffect, useRef, useState, type MouseEvent } from 'react'
import { Icon } from '~/components/ui/Icon'
import type { RailItem } from '~/src/lib/nav'
import { prefersReducedMotion } from '~/src/lib/ui'
import { PageActions } from './PageTools'

/** The current page's outline, shared by the right rail and the inline outline (TocInline). */
export const RailContext = createContext<RailItem[]>([])
export const useRailItems = () => useContext(RailContext)

const hrefOf = (item: RailItem) => (item.id ? `#${item.id}` : '#main')

/** "Overview" goes to the top of the article, like the old site, not to the h1's scroll offset. */
export function onRailClick(item: RailItem, event: MouseEvent<HTMLAnchorElement>) {
  if (item.id) return
  event.preventDefault()
  window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
  history.replaceState(history.state, '', location.pathname + location.search)
}

/**
 * Scroll-spy: the last heading whose top has passed a line just under the header is current; at
 * the very bottom of the page, the last heading on screen wins (the last ones can't reach the line).
 */
function useScrollSpy(items: RailItem[]): number {
  const [current, setCurrent] = useState(0)
  useEffect(() => {
    let raf = 0
    const update = () => {
      raf = 0
      const header = document.getElementById('site-header')
      const line = (header?.offsetHeight ?? 64) + 40
      let cur = 0
      for (let i = 1; i < items.length; i++) {
        const el = items[i].id ? document.getElementById(items[i].id!) : null
        if (el && el.getBoundingClientRect().top <= line) cur = i
      }
      const doc = document.documentElement
      if (scrollY > 0 && doc.scrollHeight > innerHeight + 8 && innerHeight + scrollY >= doc.scrollHeight - 2) {
        for (let i = items.length - 1; i > 0; i--) {
          const el = items[i].id ? document.getElementById(items[i].id!) : null
          if (el && el.getBoundingClientRect().top < innerHeight) {
            cur = i
            break
          }
        }
      }
      setCurrent(cur)
    }
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(update)
    }
    update()
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
    }
  }, [items])
  return current
}

/** The right-hand "On this page" column (≥ 1200px): outline with scroll-spy, then page actions. */
export function Rail({ items }: { items: RailItem[] }) {
  const current = useScrollSpy(items)
  const nav = useRef<HTMLElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const [indicator, setIndicator] = useState<{ top: number; height: number } | null>(null)

  useEffect(() => {
    const a = list.current?.querySelectorAll<HTMLAnchorElement>('a')[current]
    if (!a || !a.offsetParent) return
    setIndicator({ top: a.offsetTop, height: a.offsetHeight })
    // A long outline scrolls inside the rail; keep the current entry in view, clear of the edges.
    const n = nav.current
    if (n && n.scrollHeight > n.clientHeight + 1) {
      const box = n.getBoundingClientRect()
      const r = a.getBoundingClientRect()
      if (r.top < box.top + 40 || r.bottom > box.bottom - 24) n.scrollTop += r.top - box.top - box.height / 3
    }
  }, [current, items])

  return (
    <aside className="rail" id="rail" aria-label="On this page">
      <nav className="rail-nav" id="rail-nav" ref={nav} aria-labelledby="rail-title" hidden={items.length < 2}>
        <p className="rail-title" id="rail-title">
          <Icon name="list" />
          On this page
        </p>
        <div className="rail-track">
          <span
            className={`rail-indicator${indicator ? ' on' : ''}`}
            id="rail-indicator"
            aria-hidden="true"
            style={indicator ? { transform: `translateY(${indicator.top}px)`, height: indicator.height } : undefined}
          />
          <ul id="rail-list" ref={list}>
            {items.map((item, i) => (
              <li key={item.id ?? '_top'} className={item.depth === 3 ? 'is-sub' : undefined}>
                <a
                  href={hrefOf(item)}
                  className={i === current ? 'active' : undefined}
                  aria-current={i === current ? 'location' : undefined}
                  onClick={(e) => onRailClick(item, e)}
                  dangerouslySetInnerHTML={{ __html: item.html }}
                />
              </li>
            ))}
          </ul>
        </div>
      </nav>
      <div className="rail-foot">
        <PageActions />
      </div>
    </aside>
  )
}

/** The collapsible outline under the title and lede, shown below 1200px instead of the rail. */
export function TocInlineView({ items }: { items: RailItem[] }) {
  const ref = useRef<HTMLDetailsElement>(null)
  if (items.length < 2) return null
  return (
    <details className="toc-inline" id="toc-inline" ref={ref}>
      <summary>
        <Icon name="list" />
        <span>On this page</span>
        <Icon name="chevron-down" />
      </summary>
      <ul id="toc-inline-list">
        {items.map((item) => (
          <li key={item.id ?? '_top'} className={item.depth === 1 ? 'is-top' : item.depth === 3 ? 'is-sub' : undefined}>
            <a
              href={hrefOf(item)}
              onClick={(e) => {
                if (ref.current) ref.current.open = false
                onRailClick(item, e)
              }}
              dangerouslySetInnerHTML={{ __html: item.html }}
            />
          </li>
        ))}
      </ul>
    </details>
  )
}
