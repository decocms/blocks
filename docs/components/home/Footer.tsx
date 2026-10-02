import { MdxLink } from '~/components/mdx/MdxLink'
import { WordmarkLime } from '~/components/ui/Brand'
import { btnOutline, btnPrimary, container, cta, d, Dim, H2, reveal } from './ui'

const noteLink = 'text-inherit underline decoration-1 underline-offset-2 rounded-[2px] transition-colors hover:text-fg'

export function FinalCta() {
  return (
    <div className="py-28 bg-bg text-center max-sm:py-20" role="group" aria-labelledby="final-title">
      <div className={`${container} flex flex-col items-center`}>
        <H2 id="final-title" className={`max-w-[620px] mx-auto ${reveal}`}>
          Start with one function. <Dim>Ship it from Git.</Dim>
        </H2>
        <div className={`${cta} justify-center ${reveal}`} style={d('120ms')}>
          <MdxLink className={btnPrimary} href="/next/quickstart">
            Read the quickstart →
          </MdxLink>
          <MdxLink className={btnOutline} href="/next/architecture">
            How it works
          </MdxLink>
        </div>
        <p className={`mt-4 mx-auto max-w-[560px] text-13 leading-5 text-quiet ${reveal}`} style={d('120ms')}>
          The quickstart runs in plain Node, no framework. Or read the{' '}
          <MdxLink className={noteLink} href="/next/standalone">
            API reference
          </MdxLink>
          , or{' '}
          <MdxLink className={noteLink} href="/next/internals">
            what's under the hood
          </MdxLink>
          .
        </p>
      </div>
    </div>
  )
}

export interface FooterColumn {
  title: string
  /** [href, label] */
  links: [string, string][]
}

/** The next major's footer columns (its home is /next/). The current release's are in v7/columns.ts. */
export const NEXT_COLUMNS: FooterColumn[] = [
  {
    title: 'Docs',
    links: [
      ['/next/architecture', 'How it works'],
      ['/next/quickstart', 'Quickstart'],
      ['/next/model', 'Blocks'],
      ['/next/content', 'Content'],
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
      ['/next/adoption', 'Renames & migrations'],
      ['/roadmap', 'Roadmap'],
    ],
  },
]

/**
 * The landing's site footer, with the columns of the home's version. `site-footer` is the hook
 * Menu.tsx uses to make it inert under the open drawer.
 */
export function SiteFooter({ columns }: { columns: FooterColumn[] }) {
  return (
    <footer className="site-footer p-2 bg-footer-bg max-sm:p-1.5 [&_:where(:focus-visible)]:outline-lime">
      <div className="relative overflow-hidden pt-32 rounded-2xl bg-footer-panel text-[#E7E5E4] max-sm:pt-16">
        <div className={container}>
          <div className="grid grid-cols-4 gap-10 max-md:grid-cols-2 max-md:gap-x-6 max-md:gap-y-9">
            {columns.map((col) => (
              <nav aria-label={col.title} key={col.title}>
                <p className="mb-2 text-18 leading-[1.625] font-medium text-lime">{col.title}</p>
                {col.links.map(([href, label]) => (
                  <MdxLink
                    className="block w-fit py-2 text-16 leading-6 text-[#E7E5E4] no-underline rounded-[3px] transition-colors duration-300 hover:text-[rgba(208,236,26,.85)]"
                    href={href}
                    key={href}
                  >
                    {label}
                  </MdxLink>
                ))}
              </nav>
            ))}
          </div>
        </div>
        <div className="max-w-[1296px] mt-14 mx-auto px-10 aspect-[1296/250] overflow-hidden max-sm:px-4 max-sm:mt-10 [&_.wm]:w-full [&_.wm]:h-auto" aria-hidden="true">
          <WordmarkLime />
        </div>
      </div>
    </footer>
  )
}
