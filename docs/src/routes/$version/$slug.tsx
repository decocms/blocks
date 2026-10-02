import { createFileRoute } from '@tanstack/react-router'
import { findPage } from '~/src/lib/content'
import { docHead, loadDocRoute } from '~/src/lib/docRoute'
import { DocPage } from '~/src/layout/DocPage'

/** A doc page: /next/quickstart → content/next/quickstart.mdx. */
export const Route = createFileRoute('/$version/$slug')({
  loader: ({ params }) => loadDocRoute(params.version, params.slug),
  head: ({ loaderData }) => docHead(loaderData),
  component: DocRoute,
})

function DocRoute() {
  const { version, slug } = Route.useLoaderData()
  return <DocPage page={findPage(version, slug)!} />
}
