import type { FooterColumn } from '../Footer'

/** The current release's footer columns (the home at /). */
export const V7_COLUMNS: FooterColumn[] = [
  {
    title: 'Docs',
    links: [
      ['/v7/architecture', 'How it works'],
      ['/v7/quickstart', 'Quickstart'],
      ['/v7/model', 'Blocks & sections'],
      ['/v7/content', 'The decofile'],
      ['/v7/loaders', 'Loaders & actions'],
      ['/v7/studio', 'Studio'],
    ],
  },
  {
    title: 'Guides',
    links: [
      ['/v7/tanstack', 'TanStack Start'],
      ['/v7/nextjs', 'Next.js'],
      ['/v7/releases', 'Deploying & Fast Deploy'],
      ['/v7/caching', 'Caching'],
      ['/v7/troubleshooting', 'Troubleshooting'],
    ],
  },
  {
    title: 'Apps',
    links: [
      ['/v7/apps', 'Overview'],
      ['/v7/vtex', 'VTEX'],
      ['/v7/shopify', 'Shopify'],
      ['/v7/blog', 'Blog'],
      ['/v7/apps-website', 'Website'],
    ],
  },
  {
    title: 'More',
    links: [
      ['/v7/upgrade-from-start', 'Upgrading from 6.x'],
      ['/v7/cli', 'CLI reference'],
      ['/next/', 'Next major'],
      ['/roadmap', 'Roadmap'],
    ],
  },
]
