import { createFileRoute, notFound } from '@tanstack/react-router'
import RoadmapPage from '~/components/roadmap/RoadmapPage'
import { roadmapDocumentTitle, sectionForSlug } from '~/components/roadmap/sections'

/** /roadmap/blockers, /roadmap/api, …: one Roadmap section per page (components/roadmap/sections.ts). */
export const Route = createFileRoute('/roadmap/$section')({
  staticData: { chrome: { layout: 'docs', tab: 'roadmap', version: 'next' } },
  loader: ({ params }) => {
    const id = sectionForSlug(params.section)
    if (!id) throw notFound()
    return { id }
  },
  head: ({ loaderData }) => ({
    meta: loaderData ? [{ title: roadmapDocumentTitle(loaderData.id) }] : [],
  }),
  component: RoadmapSection,
})

function RoadmapSection() {
  const { id } = Route.useLoaderData()
  return <RoadmapPage section={id} />
}
