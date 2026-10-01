import { notFound } from '@tanstack/react-router'
import type { Chrome } from './chrome'
import { loadPage, resolvePage } from './content'
import { documentTitle } from './nav'
import { isVersion } from './versions'

/** Shared loader for /$version/$slug and /$version/ (slug ''). Throws notFound() for unknown pages. */
export async function loadDocRoute(version: string, slug: string) {
  if (!isVersion(version)) throw notFound()
  const page = resolvePage(version, slug)
  if (!page) throw notFound()
  await loadPage(page)
  const chrome: Chrome = { layout: 'docs', tab: page.kind, version, slug: page.slug }
  // The page's own URL: /next/ shows /next/architecture, and /next/quickstart.html is /next/quickstart.
  const canonical = `${import.meta.env.BASE_URL}${page.path.replace(/^\//, '')}`
  return { file: page.file, version, slug: page.slug, chrome, title: documentTitle(page), description: page.description, canonical }
}

export function docHead(data: Awaited<ReturnType<typeof loadDocRoute>> | undefined) {
  if (!data) return {}
  return {
    meta: [{ title: data.title }, ...(data.description ? [{ name: 'description', content: data.description }] : [])],
    links: [{ rel: 'canonical', href: data.canonical }],
  }
}
