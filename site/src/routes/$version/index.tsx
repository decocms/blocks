import type { ComponentType } from 'react'
import { createFileRoute, notFound } from '@tanstack/react-router'
import { versionEntry } from '~/src/lib/content'
import type { Chrome } from '~/src/lib/chrome'
import { docHead, loadDocRoute } from '~/src/lib/docRoute'
import { hasHomeAtIndex, isVersion } from '~/src/lib/versions'
import { DocPage } from '~/src/layout/DocPage'

/**
 * A version's index, /next/ or /v7/. A version whose home page lives here (the next major's, see
 * `home` in src/lib/versions.ts) shows that landing; any other shows its content/<version>/index.mdx,
 * or, without one, its first page (rendered here too, so the URL works as a stable entry point for
 * the version select).
 */
const homeModules = import.meta.glob<{ default: ComponentType<{ version: string }> }>('/components/home/index.tsx', { eager: true })
const Home = Object.values(homeModules)[0]?.default

const HOME_TITLES: Record<string, string> = {
  next: 'Deco Blocks next major — The AI-native headless CMS',
}

export const Route = createFileRoute('/$version/')({
  loader: async ({ params }) => {
    const { version } = params
    // No reference to Home here: the loader stays in the entry chunk, the component is split out.
    if (isVersion(version) && hasHomeAtIndex(version)) {
      const chrome: Chrome = { layout: 'landing', tab: 'home', version }
      return { home: true as const, version, chrome, title: HOME_TITLES[version] ?? `Deco Blocks ${version}` }
    }
    if (!isVersion(version)) throw notFound()
    return { home: false as const, ...(await loadDocRoute(version, '')) }
  },
  head: ({ loaderData }) => {
    if (!loaderData) return {}
    if (loaderData.home) {
      return { meta: [{ title: loaderData.title }], links: [{ rel: 'canonical', href: `${import.meta.env.BASE_URL}${loaderData.version}/` }] }
    }
    return docHead(loaderData)
  },
  component: VersionIndex,
})

function VersionIndex() {
  const data = Route.useLoaderData()
  if (data.home) return Home ? <Home version={data.version} /> : null
  const page = versionEntry(data.version)!
  return <DocPage page={page} indexable={page.slug === ''} />
}
