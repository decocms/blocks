/**
 * Content checks that don't need a build (`bun run check` runs them after tsc):
 *
 *  - every content/<version>/*.mdx has valid frontmatter (build/manifest.ts throws otherwise);
 *  - each page has exactly one `# ` h1, and its text equals the frontmatter `title`;
 *  - links to other doc pages (`](/next/x#y)`, `href="/next/x#y"` or `<Hosted to="/next/x#y">`) point at a page that exists,
 *    and the #fragment at one of its headings (Roadmap links are checked by scripts/check-roadmap.ts, and every fragment after the build,
 *    by scripts/postbuild.ts, which checks every link in the rendered HTML);
 *  - nothing that must not be published: local filesystem paths.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { loadManifest, manifestPaths } from '../build/manifest.ts'
import { createSlugger } from '../build/slugify.ts'
import { ROADMAP_PATHS } from '../components/roadmap/sections.ts'
import { SITE_ROOT } from './site-files.ts'

const manifest = loadManifest(SITE_ROOT)
const pages = Object.values(manifest.versions).flatMap((v) => v.pages)
const known = new Set(['/', '/roadmap', ...ROADMAP_PATHS, ...manifestPaths(manifest), ...Object.keys(manifest.versions).map((v) => `/${v}/`)])
const problems: string[] = []

/** Heading text as the slugger sees it: Markdown inline syntax stripped. */
const plain = (md: string) =>
  md
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()

const idsByPath = new Map<string, Set<string>>()
const sources = new Map<string, string>()
for (const p of pages) {
  const src = readFileSync(path.join(SITE_ROOT, p.file), 'utf8')
  sources.set(p.file, src)
  const body = src.replace(/^---[\s\S]*?---\r?\n/, '').replace(/```[\s\S]*?```/g, '')
  const h1s = [...body.matchAll(/^# (.+)$/gm)].map((m) => plain(m[1]))
  if (h1s.length !== 1) problems.push(`${p.file}: expected exactly one "# Title" line, found ${h1s.length}`)
  else if (h1s[0] !== p.title) problems.push(`${p.file}: h1 "${h1s[0]}" differs from frontmatter title "${p.title}"`)
  const slug = createSlugger()
  const ids = new Set<string>()
  for (const m of body.matchAll(/<h[1-3][^>]*\sid="([^"]+)"/g)) ids.add(slug('', m[1]))
  for (const m of body.matchAll(/^(#{1,3}) (.+)$/gm)) ids.add(slug(plain(m[2])))
  idsByPath.set(p.path, ids)
}

for (const p of pages) {
  const src = sources.get(p.file)!
  // Links inside fenced code are example code (an href in a JSX snippet), not doc links.
  const prose = src.replace(/```[\s\S]*?```/g, '')
  const links = [...prose.matchAll(/\]\((\/[^)\s]*)\)/g), ...prose.matchAll(/href="(\/[^"]*)"/g), ...prose.matchAll(/<Hosted\b[^>]*?\bto="(\/[^"]*)"/g)].map((m) => m[1])
  for (const href of links) {
    const [route, frag] = href.split('#')
    if (!known.has(route)) {
      problems.push(`${p.file}: link to ${href}: no such page`)
      continue
    }
    if (frag && !route.startsWith('/roadmap') && route !== '/' && !idsByPath.get(route)?.has(frag))
      problems.push(`${p.file}: link to ${href}: no heading with id "${frag}" on ${route}`)
  }
  if (/(?:\/Users\/|\/home\/[a-z]|[A-Z]:\\Users\\)/.test(src)) problems.push(`${p.file}: contains a local filesystem path`)
}

const unique = [...new Set(problems)]
if (unique.length) {
  console.error(`${unique.length} content problem${unique.length === 1 ? '' : 's'}:\n${unique.map((p) => `  - ${p}`).join('\n')}`)
  process.exit(1)
}
console.log(`content: ok (${pages.length} pages in ${Object.keys(manifest.versions).length} versions)`)
