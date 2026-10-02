import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { PlainLink } from './PlainLink'
import { Icon } from '~/components/ui/Icon'
import { Wordmark } from '~/components/ui/Brand'
import { useChrome, type Tab } from '~/src/lib/chrome'
import { equivalentPath, findPage, kindEntry, versionEntry } from '~/src/lib/content'
import { homeFor, VERSIONS } from '~/src/lib/versions'
import { cx, openSearch } from '~/src/lib/ui'
import { ThemeToggle } from './ThemeToggle'
import { useMenu } from './Menu'

export const GITHUB_URL = 'https://github.com/decocms/blocks'

/** Round icon buttons (theme, GitHub, menu, drawer close); `onBand` = the landing's white-on-forest header. */
const iconButtonBase =
  'size-[38px] flex-none place-items-center rounded-full border-0 bg-transparent no-underline transition-[color,background-color] duration-300'
/** `display` is left to the caller's `display` argument (the menu button is hidden from 900px). */
export const iconButton = (onBand = false, display = 'inline-grid') =>
  cx(iconButtonBase, display, onBand ? 'text-white/86 hover:bg-white/10 hover:text-white' : 'text-muted-fg hover:bg-muted hover:text-fg')

/**
 * The four site tabs: in the header (from 768px; 860px on the landing) and in the drawer below that.
 * The drawer's nav keeps the `drawer-tabs` class: Menu.tsx focuses its first link.
 */
export function SiteTabs({ where, label }: { where: 'header' | 'drawer'; label: string }) {
  const { tab, version, layout } = useChrome()
  const landing = layout === 'landing'
  const onBand = landing && where === 'header'
  const docs = kindEntry(version, 'docs')?.path ?? versionEntry(version)?.path ?? '/'
  const internals = kindEntry(version, 'internals')?.path ?? docs
  const tabs: { id: Tab; label: string; to: string }[] = [
    { id: 'home', label: 'Home', to: homeFor(version) },
    { id: 'docs', label: 'Docs', to: docs },
    { id: 'internals', label: 'Under the hood', to: internals },
    { id: 'roadmap', label: 'Roadmap', to: '/roadmap/' },
  ]
  const navClass =
    where === 'drawer'
      ? cx('drawer-tabs hidden flex-none flex-wrap gap-x-0 gap-y-1 border-b border-hairline px-2 py-3', landing ? 'max-hdr-sm:flex' : 'max-md:flex')
      : cx(
          'ml-7 flex items-center gap-1',
          landing
            ? 'max-hdr-sm:hidden min-hdr-sm:max-hdr:ml-4 min-home-lg:absolute min-home-lg:left-1/2 min-home-lg:m-0 min-home-lg:-translate-x-1/2'
            : 'max-md:hidden',
        )
  return (
    <nav className={navClass} aria-label={label}>
      {tabs.map((t) => {
        const current = tab === t.id
        return (
          <PlainLink
            key={t.id}
            to={t.to}
            data-tab={t.id}
            aria-current={current ? 'page' : undefined}
            className={cx(
              'inline-flex h-[34px] items-center whitespace-nowrap rounded-full text-14 leading-5 font-normal no-underline transition-[color,background-color] duration-350',
              where === 'drawer' ? 'px-2.5 max-[390px]:px-2' : 'px-3.5',
              onBand ? (current ? 'bg-white/14 text-white' : 'text-white/82 hover:text-white') : current ? 'pill-on' : 'text-muted-fg hover:text-fg',
            )}
          >
            {t.label}
          </PlainLink>
        )
      })}
    </nav>
  )
}

/**
 * Switches docs version: on a home page, the other version's home (`/` ↔ `/next/`); elsewhere the
 * page's declared counterpart (COUNTERPARTS in versions.ts), else the same page in the other version
 * if it has one, else its index.
 *
 * A mouse or touch pick navigates at once. Arrow keys on a closed select change its value on
 * Windows and Linux, so a keyboard change only takes effect on Enter or when focus leaves the
 * select (WCAG 3.2.2): browsing the options never navigates by itself.
 */
export function VersionSelect({ id, where }: { id: string; where: 'header' | 'drawer' }) {
  const { version, slug, layout, tab } = useChrome()
  const navigate = useNavigate()
  const onBand = layout === 'landing' && where === 'header'
  const [pending, setPending] = useState<string | null>(null)
  const fromKeyboard = useRef(false)
  useEffect(() => setPending(null), [version])
  const go = (to: string) => {
    setPending(null)
    if (to === version) return
    const [path, hash] = equivalentPath(slug, to, layout === 'landing' && tab === 'home', version).split('#')
    void navigate({ to: path, hash })
  }
  return (
    <label
      className={cx(
        'relative flex-none items-center print:hidden',
        where === 'drawer' ? 'inline-flex w-full' : layout === 'landing' ? 'ml-3 inline-flex max-nav:hidden min-nav:max-hdr:ml-1' : 'ml-3 inline-flex max-nav:hidden',
      )}
    >
      <span className="sr-only">Documentation version</span>
      <select
        id={id}
        className={cx(
          'm-0 cursor-pointer appearance-none rounded-full border pr-[30px] pl-3 font-sans font-normal leading-4 tracking-ui transition-[border-color,background-color] duration-300 focus-visible:outline-offset-2',
          onBand
            ? // White on the landing's forest band; the options keep the page's colours.
              'border-white/22 bg-white/8 text-white hover:border-white/40 hover:bg-white/12 [&>option]:bg-surface [&>option]:text-fg'
            : 'border-border bg-bg-subtle text-fg hover:border-border-strong',
          where === 'drawer' ? 'h-10 w-full text-14' : 'h-8 text-13',
        )}
        value={pending ?? version}
        title={VERSIONS.find((v) => v.id === version)?.description}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && pending !== null) {
            e.preventDefault()
            go(pending)
          } else if (e.key !== 'Tab' && e.key !== 'Enter' && e.key !== 'Escape') {
            // A change caused by this key fires before the timeout; a later pick in an open
            // popup (macOS) doesn't, and navigates at once like a mouse pick.
            fromKeyboard.current = true
            setTimeout(() => (fromKeyboard.current = false), 0)
          }
        }}
        onChange={(e) => {
          if (fromKeyboard.current) setPending(e.target.value)
          else go(e.target.value)
        }}
        onBlur={() => pending !== null && go(pending)}
      >
        {VERSIONS.map((v) => (
          <option key={v.id} value={v.id}>
            {v.label}
          </option>
        ))}
      </select>
      <Icon name="chevron-down" className={cx('pointer-events-none absolute right-2.5 size-3.5', onBand ? 'text-white/70' : 'text-muted-fg')} />
    </label>
  )
}

export function Header() {
  const { layout, version } = useChrome()
  const menu = useMenu()
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    let raf = 0
    const on = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        setScrolled(window.scrollY > 4)
      })
    }
    on()
    window.addEventListener('scroll', on, { passive: true })
    return () => window.removeEventListener('scroll', on)
  }, [])
  // "Get started" goes to the current version's Quickstart (the home's version on a home page).
  const getStarted: string = findPage(version, 'quickstart')?.path ?? kindEntry(version, 'docs')?.path ?? '/'
  const landing = layout === 'landing'
  return (
    <header
      className={cx(
        'z-50 transition-[background-color,border-color] duration-500 ease-out-quart print:hidden',
        landing
          ? // Floats over the hero band: transparent until scrolled, then the inner row becomes a dark pill.
            'pointer-events-none fixed inset-x-0 top-0 px-10 pt-6 max-nav:px-4 max-nav:pt-4 [&_:focus-visible]:outline-brand'
          : 'sticky top-0 h-header border-b border-hairline bg-bg/86 backdrop-blur-[16px] backdrop-saturate-[1.4]',
      )}
      id="site-header"
    >
      <div
        className={cx(
          'relative mx-auto flex items-center gap-2 max-2xs:gap-0.5',
          landing
            ? cx(
                'pointer-events-auto max-w-landing-header rounded-full pr-4 pl-7 max-nav:h-14 max-nav:pr-2 max-nav:pl-3 max-2xs:pr-1.5 max-2xs:pl-2.5',
                '[transition:background-color_.5s_var(--ease-out-quart),box-shadow_.5s_var(--ease-out-quart),height_.45s_var(--ease-out-quart)]',
                scrolled ? 'h-15 bg-hdr-pill shadow-float backdrop-blur-[60px] backdrop-saturate-[1.2]' : 'h-18',
              )
            : // The docs row spans the shell (max-w-shell): logo over the sidebar, actions over the rail.
              'h-full max-w-shell px-6 max-nav:pr-4 max-nav:pl-5 max-sm:pr-2 max-sm:pl-4 max-2xs:pr-1.5 max-2xs:pl-3',
        )}
      >
        <Link className={cx('group inline-flex h-10 flex-none items-center gap-2 rounded-lg no-underline', landing ? 'text-white/86' : 'text-fg')} to="/" aria-label="Deco Blocks home">
          <Wordmark
            className="h-[22px] w-auto transition-opacity duration-300 group-hover:opacity-80"
            light={landing ? 'hidden' : 'inline-block dark:hidden'}
            dark={landing ? 'inline-block' : 'hidden dark:inline-block'}
          />
          <svg className={cx('h-6 w-3', landing ? 'text-white/30' : 'text-border-strong')} viewBox="0 0 12 24" aria-hidden="true" focusable="false">
            <path d="M8.5 4 3.5 20" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
          </svg>
          <span className={cx('text-15 leading-6 font-medium tracking-snug max-sm:text-14', landing && 'text-white')}>Blocks</span>
        </Link>
        <SiteTabs where="header" label="Site sections" />
        <VersionSelect id="version-select" where="header" />
        <div className={cx('ml-auto flex items-center gap-1', landing ? 'nav:max-hdr:gap-4 min-hdr:gap-6' : 'max-2xs:gap-0')}>
          <button
            className={cx(
              'flex h-[38px] items-center gap-2.5 rounded-full border text-left text-14 leading-5 transition-[border-color,color,background-color] duration-300',
              landing
                ? // Always the compact icon on the landing.
                  'mr-1 w-[38px] justify-center border-transparent bg-transparent p-0 text-white/86 hover:bg-white/10 hover:text-white nav:-mx-2.5 max-[380px]:hidden'
                : 'mr-2 w-60 border-border bg-bg-subtle pr-1.5 pl-3.5 text-muted-fg hover:border-border-strong hover:text-fg max-xl:w-52 max-lg:mr-1 max-lg:w-[38px] max-lg:justify-center max-lg:border-transparent max-lg:bg-transparent max-lg:p-0 max-lg:hover:border-border-strong',
            )}
            type="button"
            data-search-open
            onClick={openSearch}
            aria-label="Search docs (⌘K)"
            title="Search docs (⌘K)"
          >
            <Icon name="search" className={landing ? 'size-[18px]' : 'max-lg:size-[18px]'} />
            <span className={landing ? 'hidden' : 'flex-1 max-lg:hidden'}>Search docs…</span>
            <kbd className={landing ? 'hidden' : 'inline-flex h-[26px] items-center rounded-full bg-surface px-[9px] text-muted-fg shadow-[inset_0_0_0_1px_var(--border)] max-lg:hidden'}>⌘K</kbd>
          </button>
          <ThemeToggle className={cx(iconButton(landing), landing && 'nav:-mx-2.5 max-[430px]:hidden')} iconClassName="size-[18px]" id="theme-button" />
          <a
            className={cx(
              landing
                ? // On the landing (from 900px) the GitHub link is a text link.
                  // Hidden from 900 to 980px, where the version select takes its room.
                  cx(iconButtonBase, 'inline-grid text-white/82 hover:text-white nav:h-10 nav:w-auto nav:rounded-sm nav:p-0 nav:text-14 nav:leading-5 max-xs:hidden nav:max-hdr:hidden')
                : iconButton(),
            )}
            href={GITHUB_URL}
            rel="noopener"
            aria-label="Deco Blocks on GitHub"
          >
            <Icon name="github" className={cx('size-[18px]', landing && 'nav:hidden')} />
            <span className={landing ? 'hidden nav:inline' : 'hidden'} aria-hidden="true">
              GitHub
            </span>
          </a>
          <Link
            className={
              landing
                ? 'inline-flex h-10 items-center whitespace-nowrap rounded-full bg-white px-6 text-14 font-medium text-[#282524] no-underline [transition:opacity_.35s_ease,scale_.25s_var(--ease-out-quart),background-color_.35s_ease,color_.35s_ease] hover:bg-[#EEF1F2] active:scale-[.97] max-nav:ml-1 max-nav:h-9 max-nav:px-4 max-2xs:px-3'
                : 'hidden'
            }
            to={getStarted}
          >
            Get started
          </Link>
        </div>
        <button
          className={cx(iconButton(landing, 'hidden max-nav:inline-grid'), 'max-nav:-mr-1.5 max-nav:ml-0.5 max-2xs:m-0')}
          type="button"
          id="menu-button"
          ref={menu.buttonRef}
          aria-controls="sidebar"
          aria-expanded={menu.open}
          aria-label="Open navigation"
          onClick={() => (menu.open ? menu.close(true) : menu.openMenu())}
        >
          <Icon name="menu" className="size-[18px]" />
        </button>
      </div>
    </header>
  )
}
