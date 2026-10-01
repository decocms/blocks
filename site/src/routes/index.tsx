import type { ComponentType } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { LandingShell } from '~/src/layout/DocsShell'
import { sidebarFor } from '~/src/lib/nav'
import { DEFAULT_VERSION } from '~/src/lib/versions'

/**
 * Home. The page itself is owned by components/home/: its index.tsx default export renders
 * everything inside <main> plus the site footer (see ARCHITECTURE.md › Home). Until it exists, a
 * placeholder shows.
 */
const homeModules = import.meta.glob<{ default: ComponentType }>('/components/home/index.tsx', { eager: true })
const Home = Object.values(homeModules)[0]?.default

export const Route = createFileRoute('/')({
  staticData: { chrome: { layout: 'landing', tab: 'home' } },
  head: () => ({ meta: [{ title: 'Deco Blocks — The AI-native headless CMS' }] }),
  component: HomeRoute,
})

function HomeRoute() {
  if (Home) return <Home />
  return (
    <LandingShell nav={sidebarFor(DEFAULT_VERSION, 'docs')}>
      <section className="hero band" style={{ minHeight: '60vh' }}>
        <div className="container">
          <h1 style={{ color: '#fff', fontWeight: 400 }}>Deco Blocks</h1>
          <p style={{ color: 'rgba(255,255,255,.7)' }}>The home page is being ported (components/home/).</p>
        </div>
      </section>
    </LandingShell>
  )
}
