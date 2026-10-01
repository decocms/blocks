import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { Icon } from '~/components/ui/Icon'
import type { Crumb, NavGroup, PagerLink, RailItem } from '~/src/lib/nav'
import { prefersReducedMotion } from '~/src/lib/ui'
import { Sidebar } from './Sidebar'
import { Rail, RailContext } from './Rail'
import { PageTools } from './PageTools'
import { PlainLink } from './PlainLink'

export interface DocsShellProps {
  /** Sidebar groups (the current page's item has `active: true`). */
  nav: NavGroup[]
  /** Breadcrumb trail; the last crumb is the current page. */
  crumbs: Crumb[]
  /** Previous/next cards under the article. */
  pager?: { prev?: PagerLink; next?: PagerLink }
  /** "On this page" entries (first = Overview, the top of the article). Also feeds <TocInline/>. */
  rail: RailItem[]
  /** The article, normally <article className="doc-section doc-page">…</article>. */
  children: ReactNode
}

/**
 * The three-column docs layout: sidebar · main (breadcrumb, page tools, article, pager, footer)
 * · "On this page" rail. Used by the doc pages and meant for the Roadmap too. Expects the page's
 * route chrome to be `layout: 'docs'` (body[data-layout="docs"] switches the CSS grid on).
 */
export function DocsShell({ nav, crumbs, pager, rail, children }: DocsShellProps) {
  return (
    <RailContext.Provider value={rail}>
      <div className="shell" id="shell">
        <Sidebar groups={nav} />
        <main id="main" tabIndex={-1}>
          <div className="doc-top">
            <div className="doc-top-row">
              <Breadcrumb crumbs={crumbs} />
              <PageTools />
            </div>
          </div>
          {children}
          <Pager {...pager} />
          <footer className="doc-footer">
            <span>Deco Blocks</span>
            <button
              type="button"
              className="back-top"
              id="back-to-top"
              onClick={() => {
                window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
                document.querySelector<HTMLElement>('#main h1')?.focus({ preventScroll: true })
              }}
            >
              Back to top
              <Icon name="arrow-up" />
            </button>
          </footer>
        </main>
        <Rail items={rail} />
      </div>
    </RailContext.Provider>
  )
}

/**
 * The landing layout: no grid, no rail; the sidebar exists only as the mobile drawer (it shows
 * `nav`, normally the Docs groups). `footer` renders after the shell (the site footer).
 */
export function LandingShell({ nav, children, footer }: { nav: NavGroup[]; children: ReactNode; footer?: ReactNode }) {
  return (
    <>
      <div className="shell" id="shell">
        <Sidebar groups={nav} />
        <main id="main" tabIndex={-1}>
          {children}
        </main>
      </div>
      {footer}
    </>
  )
}

export function Breadcrumb({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <nav className="breadcrumb" aria-label="Breadcrumb">
      <ol id="breadcrumb">
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1
          return (
            <li key={`${i}-${c.label}`}>
              {c.to && !last ? (
                // PlainLink: no aria-current="page" when the crumb's target is the current page
                // (the Roadmap's overview, the first Docs page), which would style it as current.
                <PlainLink to={c.to}>{c.label}</PlainLink>
              ) : (
                <span aria-current={last ? 'page' : undefined}>{c.label}</span>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

export function Pager({ prev, next }: { prev?: PagerLink; next?: PagerLink }) {
  if (!prev && !next) return <nav className="pager" id="pager" aria-label="Previous and next page" hidden />
  return (
    <nav className="pager" id="pager" aria-label="Previous and next page">
      {prev && (
        <Link to={prev.to} hash={prev.hash} className="pg-prev">
          <span className="pg-dir">
            <Icon name="arrow-left" />
            <span>Previous</span>
          </span>
          <span className="pg-title">{prev.title}</span>
          <span className="pg-sub">{prev.sub}</span>
        </Link>
      )}
      {next && (
        <Link to={next.to} hash={next.hash} className="pg-next">
          <span className="pg-dir">
            <span>Next</span>
            <Icon name="arrow-right" />
          </span>
          <span className="pg-title">{next.title}</span>
          <span className="pg-sub">{next.sub}</span>
        </Link>
      )}
    </nav>
  )
}
