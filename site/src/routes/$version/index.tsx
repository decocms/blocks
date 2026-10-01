import { createFileRoute } from '@tanstack/react-router'
import { versionEntry } from '~/src/lib/content'
import { docHead, loadDocRoute } from '~/src/lib/docRoute'
import { DocPage } from '~/src/layout/DocPage'

/**
 * A version's index, /next/ or /v7/: its content/<version>/index.mdx, or, without one, its first
 * page (rendered here too, so the URL works as a stable entry point for the version select).
 */
export const Route = createFileRoute('/$version/')({
  loader: ({ params }) => loadDocRoute(params.version, ''),
  head: ({ loaderData }) => docHead(loaderData),
  component: VersionIndex,
})

function VersionIndex() {
  const { version } = Route.useLoaderData()
  const page = versionEntry(version)!
  return <DocPage page={page} indexable={page.slug === ''} />
}
