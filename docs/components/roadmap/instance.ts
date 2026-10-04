/** The app's Roadmap model: data/roadmap.json with the next major's docs pages from the content manifest. */
import data from '~/data/roadmap.json'
import { manifest } from '~/src/lib/content'
import { createRoadmap, docLabelsFromManifest, type RoadmapData } from './model'

export const roadmap = createRoadmap(data as unknown as RoadmapData, {
  docs: docLabelsFromManifest(manifest),
  base: import.meta.env.BASE_URL,
})
