/**
 * Navigation models shared by every docs-style page (doc pages, the Roadmap):
 * sidebar groups, breadcrumb, pager and the "On this page" rail. The shell components in
 * src/layout render these; pages build them (doc pages from the manifest, the Roadmap from its data).
 */
import type { ManifestPage } from '~/build/manifest'
import type { DocHeading } from '~/build/rehype-docs'
import { getVersion, kindEntry } from './content'

/** `to` is a router path without the base path (TanStack's <Link> adds it). */
export interface NavItem {
  label: string
  to: string
  hash?: string
  /** Marks the current page (bold, dot, aria-current="page"). */
  active?: boolean
}
export interface NavGroup {
  title: string
  items: NavItem[]
}
export interface Crumb {
  label: string
  to?: string
}
export interface PagerLink {
  to: string
  hash?: string
  title: string
  /** The small line under the title, e.g. "Docs › Core concepts". */
  sub: string
}
export interface RailItem {
  /** Element id to scroll to and spy on. `null` = the top of the article ("Overview"). */
  id: string | null
  /** Label markup (may contain <code>). */
  html: string
  depth: 1 | 2 | 3
}

export const KIND_LABELS = { docs: 'Docs', internals: 'Under the hood' } as const

export const ROADMAP_PAGER: PagerLink = { to: '/roadmap/', title: 'Roadmap to the next major', sub: 'Roadmap' }

export function sidebarFor(version: string, kind: 'docs' | 'internals', current?: ManifestPage): NavGroup[] {
  const v = getVersion(version)
  if (!v) return []
  return v.groups
    .filter((g) => g.kind === kind)
    .map((g) => ({
      title: g.title,
      items: g.pages
        .map((slug) => v.pages.find((p) => p.slug === slug)!)
        .map((p) => ({ label: p.nav, to: p.path, active: current?.file === p.file })),
    }))
}

export function breadcrumbFor(page: ManifestPage): Crumb[] {
  const kindLabel = KIND_LABELS[page.kind]
  const entry = kindEntry(page.version, page.kind)
  const crumbs: Crumb[] = [{ label: kindLabel, to: entry?.path }]
  if (page.group !== kindLabel && page.group !== page.nav) crumbs.push({ label: page.group })
  crumbs.push({ label: page.nav })
  return crumbs
}

export function pagerCard(p: ManifestPage): PagerLink {
  const kindLabel = KIND_LABELS[p.kind]
  // A page alone in a group of its own name goes by its title, where the label alone says little.
  const title = p.group === p.nav ? p.title : p.nav
  const sub = p.group !== kindLabel && p.group !== p.nav ? `${kindLabel} › ${p.group}` : kindLabel
  return { to: p.path, title, sub }
}

/** Reading order: Docs pages, then Under the hood; the next major's last page leads to the Roadmap. */
export function pagerFor(page: ManifestPage): { prev?: PagerLink; next?: PagerLink } {
  const pages = getVersion(page.version)?.pages ?? []
  const i = pages.findIndex((p) => p.file === page.file)
  const prev = i > 0 ? pagerCard(pages[i - 1]) : undefined
  let next = i >= 0 && i < pages.length - 1 ? pagerCard(pages[i + 1]) : undefined
  if (!next && page.version === 'next') next = ROADMAP_PAGER
  return { prev, next }
}

export function railFor(headings: DocHeading[]): RailItem[] {
  return [{ id: null, html: 'Overview', depth: 1 as const }, ...headings.map((h) => ({ id: h.id, html: h.html, depth: h.depth }))]
}

/**
 * The document title the old site used: "<nav> — Deco Blocks", or the tab name for an "Overview".
 * A version's own index.mdx (e.g. "Deco Blocks v7") goes by its title, which names the version.
 */
export function documentTitle(page: ManifestPage): string {
  if (page.slug === '') return `${page.title} — Documentation`
  return `${page.nav === 'Overview' ? KIND_LABELS[page.kind] : page.nav} — Deco Blocks`
}
