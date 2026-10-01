/**
 * The Roadmap: the to-do list for the next major, one page per section (see sections.ts for the
 * URLs). Rendered from data/roadmap.json (model.ts checks it; SectionViews.tsx renders it); the routes
 * are src/routes/roadmap/index.tsx (/roadmap/, the overview) and src/routes/roadmap/$section.tsx.
 */
export { default } from './RoadmapPage'
export { roadmapDocumentTitle, roadmapHref, roadmapTarget, sectionForSlug, sectionPath, ROADMAP_PATHS, ROADMAP_ROOT } from './sections'
