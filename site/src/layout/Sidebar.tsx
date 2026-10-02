import { useEffect, useId, useRef, type KeyboardEvent } from 'react'
import { Link } from '@tanstack/react-router'
import { Icon } from '~/components/ui/Icon'
import type { NavGroup } from '~/src/lib/nav'
import { useChrome } from '~/src/lib/chrome'
import { cx, openSearch } from '~/src/lib/ui'
import { GITHUB_URL, SiteTabs, VersionSelect, iconButton } from './Header'
import { ThemeToggle } from './ThemeToggle'
import { useMenu } from './Menu'

/**
 * The left sidebar (≥ 900px) and mobile drawer (< 900px): drawer head, the site tabs and tools
 * (drawer only), then the navigation groups.
 */
export function Sidebar({ groups, label = 'Documentation navigation' }: { groups: NavGroup[]; label?: string }) {
  const menu = useMenu()
  const landing = useChrome().layout === 'landing'
  const toc = useRef<HTMLElement>(null)
  const uid = useId()

  // Edge fades where the list continues past the top or bottom (the more-above / more-below
  // classes switch #toc's mask), and the current link kept in view.
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

  const drawerLink =
    'inline-flex h-10 min-w-0 flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-full border border-border bg-transparent px-3.5 text-14 leading-5 text-fg no-underline transition-[background-color,border-color] duration-300 hover:border-transparent hover:bg-hover'
  return (
    // A <div> with an explicit role, not an <aside>: it's a complementary landmark normally and a
    // modal dialog while it's the open drawer, and role="dialog" isn't allowed on <aside>.
    <div
      className={cx(
        'sticky top-header flex h-[calc(100dvh-var(--header-h))] flex-col overflow-hidden border-r border-hairline print:hidden',
        // Below 900px: the drawer, off-canvas on the right until body.nav-open.
        'max-nav:invisible max-nav:fixed max-nav:inset-y-0 max-nav:right-0 max-nav:left-auto max-nav:z-70 max-nav:h-full max-nav:w-[min(340px,88vw)] max-nav:translate-x-[102%] max-nav:border-r-0 max-nav:border-l max-nav:bg-bg-subtle max-nav:shadow-lg',
        'max-nav:[transition:translate_.45s_var(--ease-out-expo),visibility_0s_linear_.45s]',
        'nav-open:max-nav:visible nav-open:max-nav:translate-x-0 nav-open:max-nav:[transition:translate_.45s_var(--ease-out-expo)]',
        landing
          ? 'nav:hidden'
          : // Past the shell's 1920px cap, the sidebar's tint runs on to the window's left edge (a
            // shadow spread left of the box; body's overflow-x: clip keeps it from scrolling).
            'bg-bg-subtle min-[1921px]:shadow-[-50vw_0_0_50vw_var(--bg-subtle)]',
      )}
      id="sidebar"
      aria-label={label}
      role={menu.open ? 'dialog' : 'complementary'}
      aria-modal={menu.open ? true : undefined}
      onKeyDown={trap}
    >
      <div className="hidden h-[58px] flex-none items-center justify-between border-b border-hairline pr-3 pl-6 max-nav:flex">
        <span className="eyebrow-label">Menu</span>
        <button className={iconButton()} type="button" id="menu-close" aria-label="Close navigation" onClick={() => menu.close(true)}>
          <Icon name="x" className="size-[18px]" />
        </button>
      </div>
      <SiteTabs where="drawer" label="Site sections (menu)" />
      {/* The version select shows here below 900px (the header has it above). Landing: search,
          theme and GitHub too, below 480px, when the header has handed them over. */}
      <div className="hidden flex-none gap-2 border-b border-hairline p-4 max-nav:grid">
        <button
          className={cx(
            'h-11 items-center gap-2.5 rounded-full border border-border bg-surface px-4 text-left text-15 leading-5 text-muted-fg transition-[border-color,color] duration-300 hover:border-border-strong hover:text-fg',
            landing ? 'hidden max-xs:flex' : 'hidden',
          )}
          type="button"
          data-search-open
          onClick={openSearch}
        >
          <Icon name="search" className="size-[17px]" />
          <span>Search docs…</span>
        </button>
        <VersionSelect id="version-select-drawer" where="drawer" />
        <div className={landing ? 'hidden gap-2 max-xs:flex' : 'hidden'}>
          <a className={drawerLink} href={GITHUB_URL} rel="noopener">
            <Icon name="github" />
            GitHub
          </a>
          <ThemeToggle className={drawerLink} withLabel />
        </div>
      </div>
      <nav
        id="toc"
        ref={toc}
        aria-label="Documentation sections"
        className={cx(
          'flex-1 overflow-y-auto overscroll-contain scroll-pt-8 scroll-pb-14 pt-7 pr-4 pb-6 pl-5 scrollbar-thin [--scrollbar-thumb:var(--border)] max-nav:pt-5',
          '[&.more-above]:[--toc-t:28px] [&.more-below]:[--toc-b:48px]',
          '[&:is(.more-above,.more-below)]:[mask-image:linear-gradient(to_bottom,transparent,#000_var(--toc-t,0px),#000_calc(100%_-_var(--toc-b,0px)),transparent)]',
        )}
      >
        {groups.map((g, gi) => (
          <div className={gi > 0 ? 'mt-[26px]' : undefined} key={g.title}>
            <p className="mb-1.5 flex items-center gap-2 px-3.5 leading-[18px] eyebrow-label" id={`nav-group-${uid}-${gi}`}>
              {g.title}
            </p>
            <ul className="m-0 list-none p-0" aria-labelledby={`nav-group-${uid}-${gi}`}>
              {g.items.map((item) => (
                <li className="my-px" key={item.to + (item.hash ?? '')}>
                  <Link
                    to={item.to}
                    hash={item.hash}
                    className={cx(
                      'nav-link', // src/styles/components/docs.css
                      // `active` is also a hook: the sidebar and Menu.tsx find the current link by it.
                      item.active
                        ? "active bg-nav-active-bg font-medium text-nav-active-fg after:ml-auto after:size-1.5 after:flex-none after:rounded-full after:bg-nav-bar after:content-['']"
                        : 'text-muted-fg hover:bg-hover hover:text-fg',
                    )}
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
