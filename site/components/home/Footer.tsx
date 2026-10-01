import { MdxLink } from '~/components/mdx/MdxLink'
import { WordmarkLime } from '~/components/ui/Brand'
import { d } from './Hero'

export function FinalCta() {
  return (
    <div className="final" role="group" aria-labelledby="final-title">
      <div className="container final-inner">
        <h2 id="final-title" className="reveal">
          Start with one function. <span className="dim">Ship it from Git.</span>
        </h2>
        <div className="cta reveal" style={d('120ms')}>
          <MdxLink className="btn btn-primary" href="/next/quickstart">
            Read the quickstart →
          </MdxLink>
          <MdxLink className="btn btn-white" href="/next/architecture">
            How it works
          </MdxLink>
        </div>
        <p className="final-note reveal" style={d('120ms')}>
          The quickstart runs in plain Node, no framework. Or read the <MdxLink href="/next/standalone">API reference</MdxLink> ·{' '}
          <MdxLink href="/next/internals">Under the hood</MdxLink>.
        </p>
      </div>
    </div>
  )
}

const COLUMNS: { title: string; links: [string, string][] }[] = [
  {
    title: 'Docs',
    links: [
      ['/next/architecture', 'How it works'],
      ['/next/quickstart', 'Quickstart'],
      ['/next/model', 'Blocks'],
      ['/next/content', 'Content & loaders'],
      ['/next/preview', 'Preview'],
      ['/next/standalone', 'API reference'],
    ],
  },
  {
    title: 'Guides',
    links: [
      ['/next/nextjs', 'Next.js App Router'],
      ['/next/tanstack-data', 'TanStack Start'],
      ['/next/routing', 'Routing'],
      ['/next/releases', 'Releases & deployment'],
      ['/next/troubleshooting', 'Troubleshooting'],
    ],
  },
  {
    title: 'Under the hood',
    links: [
      ['/next/internals', 'Overview'],
      ['/next/walkthrough', 'How resolution works'],
      ['/next/loader-internals', 'Loader internals'],
      ['/next/router-internals', 'Router internals'],
      ['/next/decisions', 'Design decisions'],
    ],
  },
  {
    title: 'Project',
    links: [
      ['https://github.com/decocms/blocks', 'GitHub'],
      ['/next/internals#contributing', 'Contributing'],
      ['/next/adoption', 'Renaming & migrating'],
      ['/roadmap', 'Roadmap'],
    ],
  },
]

/** The landing's site footer (legacy.css hides .site-footer outside the landing layout). */
export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="footer-panel">
        <div className="container">
          <div className="footer-grid">
            {COLUMNS.map((col) => (
              <nav className="footer-col" aria-label={col.title} key={col.title}>
                <p>{col.title}</p>
                {col.links.map(([href, label]) => (
                  <MdxLink href={href} key={href}>
                    {label}
                  </MdxLink>
                ))}
              </nav>
            ))}
          </div>
        </div>
        <div className="footer-mark" aria-hidden="true">
          <WordmarkLime />
        </div>
      </div>
    </footer>
  )
}
