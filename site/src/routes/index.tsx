import type { ComponentType } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { LandingShell } from '~/src/layout/DocsShell'
import { sidebarFor } from '~/src/lib/nav'
import { VERSIONS } from '~/src/lib/versions'

/**
 * Home (/): the landing of the version whose `home` is `/` (the current release; the next major's
 * is at /next/, see src/routes/$version/index.tsx). The page itself is owned by components/home/:
 * its index.tsx default export renders everything inside <main> plus the site footer for a version
 * (see ARCHITECTURE.md › Home). Until it exists, a placeholder shows.
 */
const homeModules = import.meta.glob<{ default: ComponentType<{ version: string }> }>('/components/home/index.tsx', { eager: true })
const Home = Object.values(homeModules)[0]?.default
const ROOT_VERSION = VERSIONS.find((v) => v.home === '/')?.id ?? VERSIONS[0].id

export const Route = createFileRoute('/')({
  staticData: { chrome: { layout: 'landing', tab: 'home', version: ROOT_VERSION } },
  head: () => ({
    meta: [
      { title: 'Deco Blocks — Sections in code, pages in Studio' },
      {
        name: 'description',
        content:
          'Deco Blocks is the framework behind Deco sites and storefronts: React sections in TypeScript, pages composed in Deco Studio, served from TanStack Start on Cloudflare Workers or from Next.js.',
      },
    ],
  }),
  component: HomeRoute,
})

function HomeRoute() {
  if (Home) return <Home version={ROOT_VERSION} />
  return (
    <LandingShell nav={sidebarFor(ROOT_VERSION, 'docs')}>
      <section className="min-h-[60vh] bg-forest pt-40 pb-20 text-band-fg">
        <div className="mx-auto w-full max-w-landing px-10 max-sm:px-4">
          <h1 className="text-hero leading-[1.05] font-normal tracking-display">Deco Blocks</h1>
          <p className="text-band-muted">The home page is being ported (components/home/).</p>
        </div>
      </section>
    </LandingShell>
  )
}
