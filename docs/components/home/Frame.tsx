import type { ReactNode } from 'react'
import cobogoDefs from '~/assets/cobogo-defs.svg?raw'
import { LandingShell } from '~/src/layout/DocsShell'
import { sidebarFor } from '~/src/lib/nav'
import { SiteFooter, type FooterColumn } from './Footer'
import { useReveal } from './useReveal'

const COBOGO_DEFS = cobogoDefs.trim()

/** The landing frame both homes share: drawer nav and footer of `version`, the cobogó pattern defs, the indexed section. */
export function HomeFrame({ version, columns, children }: { version: string; columns: FooterColumn[]; children: ReactNode }) {
  const ref = useReveal<HTMLElement>()
  return (
    <LandingShell nav={sidebarFor(version, 'docs')} footer={<SiteFooter columns={columns} />}>
      {/* The cobogó <pattern>s (#cb-lg, #cb-sm) that the hero and stability bands fill with. */}
      <span
        className="contents [&>svg]:absolute [&>svg]:size-0 [&>svg]:overflow-hidden [&>svg]:pointer-events-none"
        dangerouslySetInnerHTML={{ __html: COBOGO_DEFS }}
      />
      <section id="home" aria-labelledby="home-title" data-pagefind-body="" ref={ref}>
        {children}
      </section>
    </LandingShell>
  )
}

