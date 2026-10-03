/**
 * The Roadmap's pages and URLs. Pure TS with no imports, so vite.config.ts (the prerender list)
 * and the check scripts can use it as well as the app.
 *
 * The old single page showed one Roadmap section at a time; each section is now its own page:
 *
 *   roadmap            -> /roadmap/            (the overview)
 *   roadmap-blockers   -> /roadmap/blockers
 *   roadmap-api        -> /roadmap/api          … and so on: the section id minus "roadmap-".
 *
 * Every id inside a section keeps its old value and becomes a #fragment of that section's page:
 *
 *   #roadmap-api--add-a-revision-handle  -> /roadmap/api#roadmap-api--add-a-revision-handle
 *   #roadmap--release-readiness          -> /roadmap/#roadmap--release-readiness
 *   #roadmap-f-<feature>                 -> /roadmap/features#roadmap-f-<feature>
 *   #roadmap-features--<category>        -> /roadmap/features#roadmap-features--<category>
 */

/** The sections, in reading order. data/roadmap.json's `sections` must list exactly these. */
export const SECTION_IDS = [
  'roadmap',
  'roadmap-blockers',
  'roadmap-studio-new',
  'roadmap-studio-legacy',
  'roadmap-api',
  'roadmap-cli',
  'roadmap-platform',
  'roadmap-docs',
  'roadmap-later',
  'roadmap-storefront',
  'roadmap-blog',
  'roadmap-faststore',
  'roadmap-features',
] as const
export type SectionId = (typeof SECTION_IDS)[number]

/** The sidebar groups (the old app.js `groupsByPage.roadmap`). */
export const SECTION_GROUPS: readonly { title: string; ids: readonly SectionId[] }[] = [
  { title: 'Overview', ids: ['roadmap'] },
  { title: 'Release blockers', ids: ['roadmap-blockers'] },
  { title: 'Studio support', ids: ['roadmap-studio-new', 'roadmap-studio-legacy'] },
  { title: 'Work items', ids: ['roadmap-api', 'roadmap-cli', 'roadmap-platform', 'roadmap-docs'] },
  { title: 'After the first release', ids: ['roadmap-later'] },
  { title: 'Site migrations', ids: ['roadmap-storefront', 'roadmap-blog', 'roadmap-faststore'] },
  { title: 'Feature readiness', ids: ['roadmap-features'] },
]

/**
 * Each section's sidebar label (data/roadmap.json `sections[].nav`). Kept here as well, so a route's
 * head() can build the document title without importing the Roadmap data (which would put all of it
 * in the entry chunk every page loads). scripts/check-roadmap.ts checks the two agree.
 */
export const SECTION_NAV: Record<SectionId, string> = {
  roadmap: 'Overview',
  'roadmap-blockers': 'The ten blockers',
  'roadmap-studio-new': 'On a next-major site',
  'roadmap-studio-legacy': 'With legacy content',
  'roadmap-api': 'API additions',
  'roadmap-cli': 'CLI and manifest',
  'roadmap-platform': 'Studio and Deco API',
  'roadmap-docs': 'Docs fixes',
  'roadmap-later': 'Follow-ups',
  'roadmap-storefront': 'TanStack storefront',
  'roadmap-blog': 'TanStack blog',
  'roadmap-faststore': 'Next.js storefront',
  'roadmap-features': 'Every feature',
}

/** "Release blockers — Deco CMS"; the overview is "Roadmap — Deco CMS". */
export function roadmapDocumentTitle(id: SectionId): string {
  const nav = SECTION_NAV[id]
  return `${nav === 'Overview' ? 'Roadmap' : nav} — Deco CMS`
}

export const ROADMAP_ROOT = '/roadmap/'

/** "roadmap-api" -> "api"; "roadmap" -> "" (the overview). */
export const sectionSlug = (id: SectionId): string => (id === 'roadmap' ? '' : id.slice('roadmap-'.length))

/** The router path of a section's page (no base path): "/roadmap/", "/roadmap/api". */
export const sectionPath = (id: SectionId): string => ROADMAP_ROOT + sectionSlug(id)

/**
 * "/roadmap/api" or "api" -> "roadmap-api"; "" -> "roadmap". Undefined for an unknown slug. The
 * file names GitHub Pages also serves ("api.html", "index.html") name the same pages.
 */
export function sectionForSlug(slug: string): SectionId | undefined {
  const s = slug
    .replace(/^\/?roadmap\/?/, '')
    .replace(/\/$/, '')
    .replace(/\.html$/, '')
    .replace(/^index$/, '')
  return SECTION_IDS.find((id) => sectionSlug(id) === s)
}

/** Every Roadmap page's router path, for the prerender list. */
export const ROADMAP_PATHS: string[] = SECTION_IDS.map(sectionPath)

/**
 * The section an element id lives in, from the id alone (all ids on the Roadmap follow the
 * pattern above). Undefined if the id isn't a Roadmap id.
 */
export function sectionOfId(id: string): SectionId | undefined {
  if (id === 'roadmap' || id.startsWith('roadmap--') || id === 'roadmap-title') return 'roadmap'
  if (id.startsWith('roadmap-f-')) return 'roadmap-features'
  // Longest match first: "roadmap-studio-new" before a hypothetical "roadmap-studio".
  const hits = SECTION_IDS.filter((s) => s !== 'roadmap' && (id === s || id.startsWith(`${s}--`) || id === `${s}-title`))
  return hits.sort((a, b) => b.length - a.length)[0]
}

/**
 * Where a Roadmap id lives: `{ to, hash }` (router path without base; `hash` without "#", omitted
 * for a whole section). Undefined if the id isn't a Roadmap id.
 */
export function roadmapTarget(id: string): { to: string; hash?: string } | undefined {
  const sec = sectionOfId(id)
  if (!sec) return undefined
  return id === sec ? { to: sectionPath(sec) } : { to: sectionPath(sec), hash: id }
}

/** "/roadmap/api#roadmap-api--x" for an id (no base path). */
export function roadmapHref(id: string): string | undefined {
  const t = roadmapTarget(id)
  return t && t.to + (t.hash ? `#${t.hash}` : '')
}

/** The docs version the Roadmap links into (it's about the next major). */
export const DOCS_VERSION = 'next'

/**
 * An old docs id -> its page in the next major: "studio-compatibility" -> "/next/studio-compatibility",
 * "releases-and-deployment--publishing" -> "/next/releases-and-deployment#publishing" (the old ids were "<section>--<slug>").
 */
export function docsHref(id: string): string {
  const i = id.indexOf('--')
  return i < 0 ? `/${DOCS_VERSION}/${id}` : `/${DOCS_VERSION}/${id.slice(0, i)}#${id.slice(i + 2)}`
}
