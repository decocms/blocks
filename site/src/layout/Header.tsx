import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { PlainLink } from './PlainLink'
import { Icon } from '~/components/ui/Icon'
import { Wordmark } from '~/components/ui/Brand'
import { useChrome, type Tab } from '~/src/lib/chrome'
import { equivalentPath, findPage, kindEntry, versionEntry } from '~/src/lib/content'
import { DEFAULT_VERSION, VERSIONS } from '~/src/lib/versions'
import { openSearch } from '~/src/lib/ui'
import { ThemeToggle } from './ThemeToggle'
import { useMenu } from './Menu'

export const GITHUB_URL = 'https://github.com/decocms/blocks'

/** The four site tabs, in the header and (on small screens) in the drawer. */
export function SiteTabs({ className, label }: { className: string; label: string }) {
  const { tab, version } = useChrome()
  const docs = kindEntry(version, 'docs')?.path ?? versionEntry(version)?.path ?? '/'
  const internals = kindEntry(version, 'internals')?.path ?? docs
  const tabs: { id: Tab; label: string; to: string }[] = [
    { id: 'home', label: 'Home', to: '/' },
    { id: 'docs', label: 'Docs', to: docs },
    { id: 'internals', label: 'Under the hood', to: internals },
    { id: 'roadmap', label: 'Roadmap', to: '/roadmap/' },
  ]
  return (
    <nav className={className} aria-label={label}>
      {tabs.map((t) => (
        <PlainLink key={t.id} to={t.to} data-tab={t.id} aria-current={tab === t.id ? 'page' : undefined}>
          {t.label}
        </PlainLink>
      ))}
    </nav>
  )
}

/**
 * Switches docs version: the same page in the other version if it has one, else its index.
 *
 * A mouse or touch pick navigates at once. Arrow keys on a closed select change its value on
 * Windows and Linux, so a keyboard change only takes effect on Enter or when focus leaves the
 * select (WCAG 3.2.2): browsing the options never navigates by itself.
 */
export function VersionSelect({ id }: { id: string }) {
  const { version, slug } = useChrome()
  const navigate = useNavigate()
  const [pending, setPending] = useState<string | null>(null)
  const fromKeyboard = useRef(false)
  useEffect(() => setPending(null), [version])
  const go = (to: string) => {
    setPending(null)
    if (to !== version) void navigate({ to: equivalentPath(slug, to) })
  }
  return (
    <label className="version-select">
      <span className="sr-only">Documentation version</span>
      <select
        id={id}
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
      <Icon name="chevron-down" />
    </label>
  )
}

export function Header() {
  const { layout } = useChrome()
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
  // "Get started" goes to the default version's Quickstart, like the old site's #quickstart.
  const getStarted: string = findPage(DEFAULT_VERSION, 'quickstart')?.path ?? kindEntry(DEFAULT_VERSION, 'docs')?.path ?? '/'
  return (
    <header className={`site-header${layout === 'landing' ? ' on-band' : ''}${scrolled ? ' is-scrolled' : ''}`} id="site-header">
      <div className="hdr-inner">
        <Link className="logo" to="/" aria-label="Deco Blocks home">
          <Wordmark />
          <svg className="slash" viewBox="0 0 12 24" aria-hidden="true" focusable="false">
            <path d="M8.5 4 3.5 20" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
          </svg>
          <span className="product">Blocks</span>
        </Link>
        <SiteTabs className="tabs" label="Site sections" />
        <VersionSelect id="version-select" />
        <div className="hdr-actions">
          <button className="search-trigger" type="button" data-search-open onClick={openSearch} aria-label="Search docs (⌘K)" title="Search docs (⌘K)">
            <Icon name="search" />
            <span className="st-label">Search docs…</span>
            <kbd>⌘K</kbd>
          </button>
          <ThemeToggle className="icon-btn theme-btn" id="theme-button" />
          <a className="icon-btn gh-link" href={GITHUB_URL} rel="noopener" aria-label="Deco Blocks on GitHub">
            <Icon name="github" />
            <span className="gh-label" aria-hidden="true">
              GitHub
            </span>
          </a>
          <Link className="hdr-cta" to={getStarted}>
            Get started
          </Link>
        </div>
        <button
          className="icon-btn menu-btn"
          type="button"
          id="menu-button"
          ref={menu.buttonRef}
          aria-controls="sidebar"
          aria-expanded={menu.open}
          aria-label="Open navigation"
          onClick={() => (menu.open ? menu.close(true) : menu.openMenu())}
        >
          <Icon name="menu" />
        </button>
      </div>
    </header>
  )
}
