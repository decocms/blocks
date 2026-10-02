import { createFileRoute } from '@tanstack/react-router'
import RoadmapPage from '~/components/roadmap/RoadmapPage'
import { roadmapDocumentTitle } from '~/components/roadmap/sections'

/** /roadmap/: the Roadmap's overview (version-less: it's about the next major). */
export const Route = createFileRoute('/roadmap/')({
  staticData: { chrome: { layout: 'docs', tab: 'roadmap', version: 'next' } },
  head: () => ({
    meta: [{ title: roadmapDocumentTitle('roadmap') }],
  }),
  component: () => <RoadmapPage section="roadmap" />,
})
