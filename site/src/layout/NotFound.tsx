import { useEffect } from 'react'
import { Link } from '@tanstack/react-router'
import { versionEntry } from '~/src/lib/content'
import { DEFAULT_VERSION } from '~/src/lib/versions'
import { sidebarFor } from '~/src/lib/nav'
import { DocsShell } from './DocsShell'

/** The 404 page (also prerendered to /404.html, which GitHub Pages serves for unknown paths). */
export function NotFound() {
  const docs = versionEntry(DEFAULT_VERSION)
  useEffect(() => {
    document.title = 'Page not found — Deco Blocks'
  }, [])
  return (
    <DocsShell nav={sidebarFor(DEFAULT_VERSION, 'docs')} crumbs={[{ label: 'Page not found' }]} rail={[]}>
      <article className="doc-section doc-page" data-pagefind-ignore="all">
        <p className="eyebrow">404</p>
        <h1 tabIndex={-1}>Page not found</h1>
        <p>There's no page at this address. It may have moved when the docs were split into versions.</p>
        <ul>
          <li>
            <Link to="/">Home</Link>
          </li>
          {docs && (
            <li>
              <Link to={docs.path}>Documentation</Link>
            </li>
          )}
          <li>
            <Link to="/roadmap/">Roadmap</Link>
          </li>
        </ul>
      </article>
    </DocsShell>
  )
}
