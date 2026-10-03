import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { Icon } from '~/components/ui/Icon'
import type { Crumb, NavGroup, PagerLink, RailItem } from '~/src/lib/nav'
import { cx, prefersReducedMotion } from '~/src/lib/ui'
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
 * · "On this page" rail. Used by the doc pages, the Roadmap and the 404. The page's route chrome
 * should be `layout: 'docs'` (the header and drawer follow it).
 *
 * Width: the sidebar sits at the shell's left edge and the rail at its right edge; the middle
 * column takes the rest. The shell fills the window up to 1920px (max-w-shell), then centres.
 * Everything in main shares one reading column (text, code, tables, callouts, pager):
 * max-w-article (720px), max-w-article-wide (800px) from 1600px, centred in the middle column.
 */
export function DocsShell({ nav, crumbs, pager, rail, children }: DocsShellProps) {
  return (
    <RailContext.Provider value={rail}>
      <div
        className="relative mx-auto max-w-shell nav:grid nav:grid-cols-[256px_minmax(0,1fr)] rail:grid-cols-[256px_minmax(0,1fr)_224px] xl:grid-cols-[280px_minmax(0,1fr)_248px] print:block"
        id="shell"
      >
        <Sidebar groups={nav} />
        <main
          id="main"
          tabIndex={-1}
          className={cx(
            'block min-w-0 px-14 pt-10 pb-24 outline-none max-xl:px-10 max-nav:px-6 max-nav:pt-6 max-nav:pb-18 max-sm:px-4 max-sm:pt-5 max-sm:pb-16 print:p-0',
            '*:mx-auto *:max-w-article wide:*:max-w-article-wide print:*:max-w-none',
          )}
        >
          <div className="mb-9 print:hidden">
            <div className="flex min-h-8 items-center justify-between gap-4 max-md:items-start max-sm:items-center">
              <Breadcrumb crumbs={crumbs} />
              <PageTools />
            </div>
          </div>
          {children}
          <Pager {...pager} />
          <footer className="mt-12 flex items-center justify-between gap-4 text-13 leading-5 text-muted-fg print:hidden">
            <span>Deco CMS</span>
            <button
              type="button"
              className="inline-flex items-center gap-1.5 border-0 bg-transparent px-0 py-1 text-13 text-muted-fg transition-colors hover:text-fg"
              id="back-to-top"
              onClick={() => {
                window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
                document.querySelector<HTMLElement>('#main h1')?.focus({ preventScroll: true })
              }}
            >
              Back to top
              <Icon name="arrow-up" className="size-3.5" />
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
      <div className="relative" id="shell">
        <Sidebar groups={nav} />
        <main id="main" tabIndex={-1} className="block min-w-0 outline-none">
          {children}
        </main>
      </div>
      {footer}
    </>
  )
}

export function Breadcrumb({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb">
      <ol id="breadcrumb" className="m-0 flex list-none flex-wrap items-center gap-x-0 gap-y-1 p-0 text-13 leading-5 text-muted-fg">
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1
          return (
            <li
              key={`${i}-${c.label}`}
              className={cx(
                'inline-flex items-center',
                // The chevron between crumbs (a mask of --chev, tinted --faint).
                i > 0 && "before:mx-2 before:size-3 before:flex-none before:bg-faint before:content-[''] before:[mask:var(--chev)_center/12px_no-repeat]",
              )}
            >
              {c.to && !last ? (
                // PlainLink: no aria-current="page" when the crumb's target is the current page
                // (the Roadmap's overview, the first Docs page), which would style it as current.
                <PlainLink to={c.to} className="rounded-sm text-muted-fg no-underline transition-colors hover:text-fg">
                  {c.label}
                </PlainLink>
              ) : (
                <span aria-current={last ? 'page' : undefined} className={last ? 'text-fg' : undefined}>
                  {c.label}
                </span>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

const pagerCard =
  'flex min-w-0 flex-col gap-1.5 rounded-2xl border border-border bg-surface px-6 pt-5 pb-[22px] text-fg no-underline [transition:border-color_.4s_var(--ease-out-quart),box-shadow_.5s_var(--ease-out-quart),translate_.5s_var(--ease-out-quart)] hover:-translate-y-[3px] hover:border-border-strong hover:shadow-lift'
const pagerDir = 'inline-flex items-center gap-1.5 leading-4 eyebrow-label'
const pagerTitle = 'text-21 leading-7 font-normal tracking-heading'
const pagerSub = 'text-13 leading-5 text-muted-fg'

export function Pager({ prev, next }: { prev?: PagerLink; next?: PagerLink }) {
  const nav = 'mt-18 grid grid-cols-2 gap-4 border-t border-hairline pt-8 max-md:grid-cols-1 print:hidden'
  if (!prev && !next) return <nav className={nav} id="pager" aria-label="Previous and next page" hidden />
  return (
    <nav className={nav} id="pager" aria-label="Previous and next page">
      {prev && (
        <Link to={prev.to} hash={prev.hash} className={pagerCard}>
          <span className={pagerDir}>
            <Icon name="arrow-left" className="size-3.5" />
            <span>Previous</span>
          </span>
          <span className={pagerTitle}>{prev.title}</span>
          <span className={pagerSub}>{prev.sub}</span>
        </Link>
      )}
      {next && (
        <Link to={next.to} hash={next.hash} className={cx(pagerCard, 'col-start-2 items-end text-right max-md:col-start-1')}>
          <span className={pagerDir}>
            <span>Next</span>
            <Icon name="arrow-right" className="size-3.5" />
          </span>
          <span className={pagerTitle}>{next.title}</span>
          <span className={pagerSub}>{next.sub}</span>
        </Link>
      )}
    </nav>
  )
}
