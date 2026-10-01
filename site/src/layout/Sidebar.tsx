import { useEffect, useId, useRef, type KeyboardEvent } from 'react'
import { Link } from '@tanstack/react-router'
import { Icon } from '~/components/ui/Icon'
import type { NavGroup } from '~/src/lib/nav'
import { openSearch } from '~/src/lib/ui'
import { GITHUB_URL, SiteTabs, VersionSelect } from './Header'
import { ThemeToggle } from './ThemeToggle'
import { useMenu } from './Menu'

/**
 * The left sidebar (≥ 900px) and mobile drawer (< 900px): drawer head, the site tabs and tools
 * (drawer only), then the navigation groups.
 */
export function Sidebar({ groups, label = 'Documentation navigation' }: { groups: NavGroup[]; label?: string }) {
  const menu = useMenu()
  const toc = useRef<HTMLElement>(null)
  const uid = useId()

  // Edge fades where the list continues past the top or bottom, and the current link kept in view.
  useEffect(() => {
    const el = toc.current
    if (!el) return
    const fade = () => {
      const max = el.scrollHeight - el.clientHeight
      el.classList.toggle('more-above', el.scrollTop > 1)
      el.classList.toggle('more-below', max > 1 && el.scrollTop < max - 1)
    }
    const active = el.querySelector<HTMLElement>('a.active')
    if (active) {
      const box = el.getBoundingClientRect()
      const r = active.getBoundingClientRect()
      if ((r.top < box.top + 28 && el.scrollTop > 0) || r.bottom > box.bottom - 48) el.scrollTop += r.top - box.top - box.height / 3
    }
    fade()
    el.addEventListener('scroll', fade, { passive: true })
    window.addEventListener('resize', fade)
    return () => {
      el.removeEventListener('scroll', fade)
      window.removeEventListener('resize', fade)
    }
  }, [groups])

  // Focus stays inside the drawer while it's open.
  const trap = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Tab' || !menu.open) return
    const focusables = [...event.currentTarget.querySelectorAll<HTMLElement>('a[href], button, select')].filter((el) => el.offsetParent !== null)
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    // A <div> with an explicit role, not an <aside>: it's a complementary landmark normally and a
    // modal dialog while it's the open drawer, and role="dialog" isn't allowed on <aside>.
    <div className="sidebar" id="sidebar" aria-label={label} role={menu.open ? 'dialog' : 'complementary'} aria-modal={menu.open ? true : undefined} onKeyDown={trap}>
      <div className="drawer-head">
        <span className="drawer-title">Menu</span>
        <button className="icon-btn" type="button" id="menu-close" aria-label="Close navigation" onClick={() => menu.close(true)}>
          <Icon name="x" />
        </button>
      </div>
      <SiteTabs className="drawer-tabs" label="Site sections (menu)" />
      <div className="drawer-tools">
        <button className="drawer-search" type="button" data-search-open onClick={openSearch}>
          <Icon name="search" />
          <span>Search docs…</span>
        </button>
        <VersionSelect id="version-select-drawer" />
        <div className="drawer-row">
          <a className="drawer-link" href={GITHUB_URL} rel="noopener">
            <Icon name="github" />
            GitHub
          </a>
          <ThemeToggle className="drawer-link theme-btn" withLabel />
        </div>
      </div>
      <nav id="toc" ref={toc} aria-label="Documentation sections">
        {groups.map((g, gi) => (
          <div className="nav-group" key={g.title}>
            <p className="nav-label" id={`nav-group-${uid}-${gi}`}>
              {g.title}
            </p>
            <ul className="nav-list" aria-labelledby={`nav-group-${uid}-${gi}`}>
              {g.items.map((item) => (
                <li key={item.to + (item.hash ?? '')}>
                  <Link
                    to={item.to}
                    hash={item.hash}
                    className={item.active ? 'active' : undefined}
                    aria-current={item.active ? 'page' : undefined}
                    activeOptions={{ exact: true, includeHash: true }}
                    activeProps={{}}
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
    </div>
  )
}
