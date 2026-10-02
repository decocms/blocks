/**
 * Documentation versions. Each one is a folder under content/ and a URL prefix (/v7/…, /next/…).
 * The header's version select lists them in this order. Adding a version = adding an entry here
 * and a content/<id>/ folder (with at least an index.mdx).
 */
export interface DocsVersion {
  /** URL segment and content folder name. */
  id: string
  /** What the version select shows. */
  label: string
  /** Shown as a note under the select's label for screen readers and as its title. */
  description: string
  /**
   * The version's landing page, if it has one: `/` for the current release, `/next/` for the next
   * major (which then replaces the version index there). On a home page the version select goes to
   * the other version's home. See components/home/.
   */
  home?: string
}

export const VERSIONS: readonly DocsVersion[] = [
  { id: 'v7', label: 'v7 (current)', description: 'The current released version', home: '/' },
  { id: 'next', label: 'next', description: 'The proposed API for the next version (unreleased)', home: '/next/' },
]

/** The version the header tabs, "Get started" and the not-found page point at outside a version. */
export const DEFAULT_VERSION = 'v7'

export const isVersion = (id: string): boolean => VERSIONS.some((v) => v.id === id)

/** A version's home page path (`/`, `/next/`), else its docs index (`/<id>/`). */
export const homeFor = (id: string): string => VERSIONS.find((v) => v.id === id)?.home ?? `/${id}/`

/** True when `/<id>/` is the version's home page rather than its docs index. */
export const hasHomeAtIndex = (id: string): boolean => VERSIONS.find((v) => v.id === id)?.home === `/${id}/`

/**
 * Pages that cover the same topic under different slugs, per version pair: from-version →
 * to-version → from-slug → to-slug. A to-slug may carry a `#hash`. The version select checks this
 * before looking for the same slug in the other version (see equivalentPath in content.ts).
 */
const APPS_TO_CLIENTS = ['apps', 'vtex', 'shopify', 'wake', 'magento', 'algolia', 'resend', 'salesforce', 'apps-commerce', 'apps-website']

export const COUNTERPARTS: Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, string>>>>>> = {
  v7: {
    next: {
      architecture: 'how-it-works',
      model: 'blocks',
      releases: 'releases-and-deployment',
      variants: 'matchers-and-variants',
      walkthrough: 'how-resolution-works',
      studio: 'how-it-works#studio',
      preview: 'releases-and-drafts',
      caching: 'caching-and-observability',
      observability: 'caching-and-observability',
      ...Object.fromEntries(APPS_TO_CLIENTS.map((slug) => [slug, 'upstream-clients'])),
      configuration: 'api-reference',
      tanstack: 'tanstack-start-descriptors',
      'quickstart-nextjs': 'nextjs',
      'nextjs-from-start': 'renames-and-migrations',
      'upgrade-from-start': 'renames-and-migrations',
      'migrate-from-fresh': 'renames-and-migrations',
      glossary: 'how-it-works#key-terms',
    },
  },
  next: {
    v7: {
      'how-it-works': 'architecture',
      blocks: 'model',
      'releases-and-deployment': 'releases',
      'matchers-and-variants': 'variants',
      'how-resolution-works': 'walkthrough',
      'studio-compatibility': 'studio',
      'content-protocol': 'studio',
      'releases-and-drafts': 'preview',
      'caching-and-observability': 'caching',
      'upstream-clients': 'apps',
      'api-reference': 'configuration',
      'tanstack-start-descriptors': 'tanstack',
      'renames-and-migrations': 'upgrade-from-start',
    },
  },
}

/** The counterpart slug (possibly with a `#hash`) of `slug` in `toVersion`, if one is declared. */
export const counterpartSlug = (fromVersion: string | undefined, toVersion: string, slug: string): string | undefined =>
  fromVersion ? COUNTERPARTS[fromVersion]?.[toVersion]?.[slug] : undefined
