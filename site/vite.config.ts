import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import mdx from '@mdx-js/rollup'
import remarkGfm from 'remark-gfm'
import remarkFrontmatter from 'remark-frontmatter'
import remarkMdxFrontmatter from 'remark-mdx-frontmatter'
import rehypeDocs from './build/rehype-docs.ts'
import { contentManifestPlugin, loadManifest, manifestPaths } from './build/manifest.ts'
import { ROADMAP_PATHS } from './components/roadmap/sections.ts'

const root = path.dirname(fileURLToPath(import.meta.url))

/**
 * Base path the site is served under. GitHub Pages serves this repo's site under /blocks/, so CI
 * builds with BASE_PATH=/blocks/. Defaults to "/". Always starts and ends with "/".
 */
const base = `/${(process.env.BASE_PATH ?? '/').replace(/^\/+|\/+$/g, '')}/`.replace(/^\/\/$/, '/')

export default defineConfig(() => {
  const manifest = loadManifest(root)
  // Every page is listed explicitly (the content ones from the manifest), so a page no link
  // reaches is still built, and no crawling is needed.
  const pages = [
    { path: '/' },
    // The Roadmap: /roadmap/ (overview) and one page per section (/roadmap/blockers, …).
    ...ROADMAP_PATHS.map((p) => ({ path: p })),
    // Each version's index (/next/, /v7/), whether or not it has an index.mdx.
    ...[...new Set([...Object.keys(manifest.versions).map((v) => `/${v}/`), ...manifestPaths(manifest)])].map((p) => ({ path: p })),
  ]
  return {
    base,
    resolve: { alias: { '~': root } },
    server: { port: 3000 },
    plugins: [
      contentManifestPlugin(root),
      {
        enforce: 'pre' as const,
        ...mdx({
          remarkPlugins: [remarkGfm, remarkFrontmatter, [remarkMdxFrontmatter, { name: 'frontmatter' }]],
          rehypePlugins: [rehypeDocs],
        }),
      },
      tailwindcss(),
      tanstackStart({
        prerender: {
          enabled: true,
          // Every page is listed above, so crawling would only re-request them (and `/x#hash` variants).
          // Broken links are reported by scripts/postbuild.ts instead.
          crawlLinks: false,
          // /next/quickstart -> next/quickstart.html (GitHub Pages serves it without a redirect);
          // /v7/ -> v7/index.html.
          autoSubfolderIndex: false,
          failOnError: true,
          // The prerenderer fetches each page from its own localhost server with a 10s connect
          // timeout; on a loaded machine that can time out. Fewer requests at once, and a retry.
          concurrency: 4,
          retryCount: 3,
          retryDelay: 1000,
        },
        pages,
      }),
      viteReact({ include: /\.(mdx|[jt]sx?)$/ }),
    ],
  }
})
