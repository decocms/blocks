import { createContext, useContext, useEffect, useRef, useState, type MouseEvent } from 'react'
import { Icon } from '~/components/ui/Icon'
import type { RailItem } from '~/src/lib/nav'
import { cx, prefersReducedMotion } from '~/src/lib/ui'
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
    <aside
      className="sticky top-header flex max-h-[calc(100vh-var(--header-h))] flex-col self-start overflow-y-auto pt-11 pr-6 pb-8 pl-2 scrollbar-none max-rail:hidden print:hidden"
      id="rail"
      aria-label="On this page"
    >
      <nav
        className="-ml-2 min-h-0 overflow-y-auto overscroll-contain pl-2 scrollbar-thin"
        id="rail-nav"
        ref={nav}
        aria-labelledby="rail-title"
        hidden={items.length < 2}
      >
        <p className="sticky top-0 z-1 m-0 flex items-center gap-2 bg-bg pb-3.5 leading-4 eyebrow-label" id="rail-title">
          <Icon name="list" className="size-3.5" />
          On this page
        </p>
        <div className="relative border-l border-hairline">
          <span
            className={cx(
              'absolute top-0 -left-0.5 h-0 w-[3px] rounded-[3px] bg-brand shadow-[0_0_0_1px_var(--indicator-ring)]',
              '[transition:transform_.45s_var(--ease-out-quart),height_.45s_var(--ease-out-quart),opacity_.3s]',
              indicator ? 'opacity-100' : 'opacity-0',
            )}
            id="rail-indicator"
            aria-hidden="true"
            style={indicator ? { transform: `translateY(${indicator.top}px)`, height: indicator.height } : undefined}
          />
          <ul className="m-0 list-none p-0" id="rail-list" ref={list}>
            {items.map((item, i) => (
              <li key={item.id ?? '_top'}>
                <a
                  href={hrefOf(item)}
                  className={cx(
                    // toc-link (src/styles/components/docs.css): the look shared with <TocInline/>.
                    'toc-link py-1.5 pr-0 text-13 leading-[19px]',
                    item.depth === 3 ? 'pl-[30px]' : 'pl-4',
                    'has-[>.gx-n]:pl-[38px]',
                    // `active` is a hook too (Menu.tsx looks for the current link).
                    i === current ? 'active font-medium text-nav-active-fg' : 'text-muted-fg hover:text-fg',
                  )}
                  aria-current={i === current ? 'location' : undefined}
                  onClick={(e) => onRailClick(item, e)}
                  dangerouslySetInnerHTML={{ __html: item.html }}
                />
              </li>
            ))}
          </ul>
        </div>
      </nav>
      <div className={cx('grid flex-none gap-0.5', items.length >= 2 && 'mt-6 border-t border-hairline pt-4')}>
        <PageActions />
      </div>
    </aside>
  )
}

