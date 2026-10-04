/**
 * Content at runtime: the manifest (from frontmatter, built by build/manifest.ts) and the MDX page
 * modules, loaded on demand (one JS chunk per page).
 *
 * A page module must be loaded before its route renders, so rendering never suspends:
 *   - the $version/$slug route's loader awaits `loadPage()` (server render and client navigation);
 *   - the router's `hydrate` hook (src/router.tsx) awaits `preloadForPath()` before hydrating.
 * Then `getLoadedPage()` returns it synchronously.
 */
import type { ComponentType } from 'react'
import type { MDXComponents } from 'mdx/types'
import manifest from 'virtual:content-manifest'
import type { ManifestPage, VersionManifest } from '~/build/manifest'
import type { DocHeading } from '~/build/rehype-docs'
import { counterpartSlug, DEFAULT_VERSION, hasHomeAtIndex, homeFor, VERSIONS } from './versions'

export { manifest }
export type { ManifestPage, VersionManifest, DocHeading }

export interface PageModule {
  default: ComponentType<{ components?: MDXComponents }>
  headings: DocHeading[]
}

const modules = import.meta.glob<PageModule>('/content/*/*.mdx')
const loaded = new Map<string, PageModule>()

export const getVersion = (version: string): VersionManifest | undefined => manifest.versions[version]

export function findPage(version: string, slug: string): ManifestPage | undefined {
  return manifest.versions[version]?.pages.find((p) => p.slug === slug)
}

export async function loadPage(page: ManifestPage): Promise<PageModule> {
  const hit = loaded.get(page.file)
  if (hit) return hit
  const load = modules[`/${page.file}`]
  if (!load) throw new Error(`No module for ${page.file}`)
  const mod = await load()
  loaded.set(page.file, mod)
  return mod
}

export function getLoadedPage(page: ManifestPage): PageModule {
  const mod = loaded.get(page.file)
  if (!mod) throw new Error(`${page.file} was rendered before it was loaded`)
  return mod
}

/** Strips the router base path ("/blocks/") from a pathname. */
export function stripBase(pathname: string): string {
  const base = import.meta.env.BASE_URL.replace(/\/$/, '')
  return base && pathname.startsWith(base) ? pathname.slice(base.length) || '/' : pathname
}

/**
 * A URL slug as written -> the page slug: GitHub Pages also serves `/next/quickstart` as
 * `/next/quickstart.html` (and a version index as `/next/index.html`), so both name the same page.
 */
export const normalizeSlug = (slug: string): string => slug.replace(/\.html$/, '').replace(/^index$/, '')

/** The page a version's index (`/next/`) shows: its index.mdx, else its first page. */
export function versionEntry(version: string): ManifestPage | undefined {
  const v = manifest.versions[version]
  return v?.pages.find((p) => p.slug === '') ?? v?.pages[0]
}

/** The page a route shows for (version, slug): the same resolution as the $version routes' loader. */
export function resolvePage(version: string, slug: string): ManifestPage | undefined {
  const s = normalizeSlug(slug)
  return s === '' ? versionEntry(version) : findPage(version, s)
}

/**
 * Finds the content page for a router path (`/next/quickstart`, `/next/quickstart.html`, `/v7/`,
 * `/v7`), if any. A version index that is the version's home page (`/next/`) has none.
 */
export function pageForPath(pathname: string): ManifestPage | undefined {
  const m = /^\/([^/]+)(?:\/([^/]*))?\/?$/.exec(pathname)
  if (!m) return undefined
  const slug = decodeURIComponent(m[2] ?? '')
  if (normalizeSlug(slug) === '' && hasHomeAtIndex(m[1])) return undefined
  return resolvePage(m[1], slug)
}

export async function preloadForPath(pathname: string): Promise<void> {
  const page = pageForPath(stripBase(pathname))
  if (page) await loadPage(page)
}

/** The first page of a kind ("docs" / "internals") in a version, falling back to the default version. */
export function kindEntry(version: string, kind: 'docs' | 'internals'): ManifestPage | undefined {
  const inVersion = manifest.versions[version]?.pages.find((p) => p.kind === kind)
  if (inVersion) return inVersion
  if (kind === 'docs') return versionEntry(version)
  return manifest.versions[DEFAULT_VERSION]?.pages.find((p) => p.kind === kind)
}

/**
 * Where the version select goes: from a home page, the other version's home; from a doc page, its
 * declared counterpart in the other version (COUNTERPARTS in versions.ts, which may add a #hash),
 * else the page with the same slug if it exists, else the other version's index.
 */
export function equivalentPath(slug: string | undefined, toVersion: string, fromHome = false, fromVersion?: string): string {
  if (fromHome) return homeFor(toVersion)
  const counterpart = slug !== undefined ? counterpartSlug(fromVersion, toVersion, slug) : undefined
  if (counterpart !== undefined) {
    const [target, hash] = counterpart.split('#')
    const page = findPage(toVersion, target)
    if (page) return hash ? `${page.path}#${hash}` : page.path
  }
  const same = slug !== undefined ? findPage(toVersion, slug) : undefined
  return (same ?? versionEntry(toVersion))?.path ?? `/${toVersion}/`
}

export const versionIds = VERSIONS.map((v) => v.id)
