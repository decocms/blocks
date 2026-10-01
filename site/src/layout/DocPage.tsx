import { useEffect } from 'react'
import type { ManifestPage } from '~/build/manifest'
import { mdxComponents } from '~/components/mdx'
import { getLoadedPage } from '~/src/lib/content'
import { breadcrumbFor, pagerFor, railFor, sidebarFor } from '~/src/lib/nav'
import { DocsShell } from './DocsShell'

/**
 * One MDX page in the docs shell: sidebar of its kind, breadcrumb, article, pager, rail.
 * `indexable: false` keeps a duplicate (a version index showing its first page) out of search.
 */
export function DocPage({ page, indexable = true }: { page: ManifestPage; indexable?: boolean }) {
  const mod = getLoadedPage(page)
  const Content = mod.default
  // A deep link to a heading inside a closed <details> opens it, so the target can be seen.
  useEffect(() => {
    const id = decodeURIComponent(location.hash.slice(1))
    const target = id ? document.getElementById(id) : null
    for (let d = target?.closest('details'); d; d = d.parentElement?.closest('details')) d.open = true
  }, [page.file])
  return (
    <DocsShell nav={sidebarFor(page.version, page.kind, page)} crumbs={breadcrumbFor(page)} pager={pagerFor(page)} rail={railFor(mod.headings)}>
      <article className="doc-section doc-page" data-pagefind-body={indexable ? '' : undefined} data-version={page.version} key={page.file}>
        <p className="eyebrow">{page.eyebrow}</p>
        <Content components={mdxComponents} />
      </article>
    </DocsShell>
  )
}
