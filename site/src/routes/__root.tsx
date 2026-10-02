/// <reference types="vite/client" />
import type { ReactNode } from 'react'
import { preconnect } from 'react-dom'
import { HeadContent, Outlet, ScriptOnce, Scripts, createRootRoute } from '@tanstack/react-router'
import appCss from '~/src/styles/app.css?url'
import { THEME_INIT_SCRIPT } from '~/src/lib/theme'
import { Header } from '~/src/layout/Header'
import { MenuProvider, useMenu } from '~/src/layout/Menu'
import { GlobalUi } from '~/src/layout/GlobalUi'
import { NotFound } from '~/src/layout/NotFound'

const BASE = import.meta.env.BASE_URL

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { name: 'color-scheme', content: 'light dark' },
      { name: 'theme-color', content: '#07401A' },
      { title: 'Deco Blocks — Documentation' },
      {
        name: 'description',
        content:
          'Deco Blocks: headless for developers, editable for humans, native for AI. Quickstart, blocks, schema generation, preview, SDK reference, routing, and Next.js and TanStack Start guides.',
      },
    ],
    links: [
      { rel: 'icon', href: `${BASE}favicon.svg`, type: 'image/svg+xml' },
      { rel: 'stylesheet', href: 'https://api.fontshare.com/v2/css?f[]=switzer@1,2&display=swap' },
      { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400..600&display=swap' },
      { rel: 'stylesheet', href: appCss },
    ],
  }),
  shellComponent: RootDocument,
  component: () => <Outlet />,
  notFoundComponent: NotFound,
})

function RootDocument({ children }: { children: ReactNode }) {
  // Through React's resource API, not <link> tags in head(): React writes these at the very top
  // of <head>, before the (render-blocking) font stylesheets it hoists, so the connections start first.
  preconnect('https://api.fontshare.com', { crossOrigin: 'anonymous' })
  preconnect('https://cdn.fontshare.com', { crossOrigin: 'anonymous' })
  preconnect('https://fonts.googleapis.com')
  preconnect('https://fonts.gstatic.com', { crossOrigin: 'anonymous' })
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Runs before first paint (no theme flash); removes itself, so hydration never sees it. */}
        <ScriptOnce>{THEME_INIT_SCRIPT}</ScriptOnce>
        <HeadContent />
      </head>
      <MenuProvider>
        <Body>{children}</Body>
      </MenuProvider>
    </html>
  )
}

function Body({ children }: { children: ReactNode }) {
  const menu = useMenu()
  return (
    <body>
      <a
        className="fixed -top-16 left-4 z-100 inline-flex h-10 items-center rounded-full bg-brand px-4.5 text-14 font-medium text-brand-ink no-underline transition-[top] duration-200 ease-out-quart focus:top-3 print:hidden"
        href="#main"
        onClick={(e) => {
          e.preventDefault()
          const target = document.querySelector<HTMLElement>('#main h1') ?? document.getElementById('main')
          target?.focus()
        }}
      >
        Skip to content
      </a>
      <Header />
      {/* The scrim behind the open drawer (below 900px). */}
      <div
        className="max-nav:pointer-events-none max-nav:fixed max-nav:inset-0 max-nav:z-65 max-nav:bg-[rgba(14,26,16,.34)] max-nav:opacity-0 max-nav:transition-opacity max-nav:duration-300 nav-open:max-nav:pointer-events-auto nav-open:max-nav:opacity-100 print:hidden"
        id="mobile-overlay"
        aria-hidden="true"
        onClick={() => menu.close(true)}
      />
      {children}
      <GlobalUi />
      <Scripts />
    </body>
  )
}
