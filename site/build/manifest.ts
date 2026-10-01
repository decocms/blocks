/**
 * The content manifest: every MDX page under content/<version>/, described by its frontmatter.
 *
 * Read at build time (Node/Bun) by:
 *   - the `virtual:content-manifest` Vite module (contentManifestPlugin below), which the app
 *     uses for the sidebar, breadcrumb, pager, version select and tabs;
 *   - vite.config.ts, which turns it into the list of pages to prerender;
 *   - scripts/check-content.ts.
 *
 * Only the frontmatter is parsed here (YAML), never the MDX body, so this stays cheap.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { Plugin, ViteDevServer } from 'vite'
import { VERSIONS } from '../src/lib/versions.ts'

export type PageKind = 'docs' | 'internals'

/** What a page's frontmatter may contain. See ARCHITECTURE.md › Frontmatter. */
export interface PageFrontmatter {
  /** Plain text of the page's `# Title` (the h1). Used for <title>, search and the pager. */
  title: string
  /** Sidebar label (the old `data-nav`). Defaults to `title`. */
  nav?: string
  /** Sidebar group, e.g. "Getting started". Groups appear in the order of their first page. */
  group: string
  /** `docs` (the Docs tab) or `internals` (the Under the hood tab). Defaults to `docs`. */
  kind?: PageKind
  /** Position in the version's reading order (sidebar + pager). Unique per version and kind. */
  order: number
  /** The small uppercase label above the title. Defaults to `group`. */
  eyebrow?: string
  /** <meta name="description">. Optional. */
  description?: string
}

export interface ManifestPage {
  version: string
  /** File name without `.mdx`; `''` for `index.mdx` (the version's index page). */
  slug: string
  /** Router path without the base path: `/next/quickstart`, `/v7/`. */
  path: string
  /** Path relative to the site root, e.g. `content/next/quickstart.mdx`. */
  file: string
  title: string
  nav: string
  group: string
  kind: PageKind
  order: number
  eyebrow: string
  description: string | null
}

export interface ManifestGroup {
  title: string
  kind: PageKind
  pages: string[] // slugs, in order
}

export interface VersionManifest {
  id: string
  /** Pages in reading order: all `docs` pages by `order`, then all `internals` pages by `order`. */
  pages: ManifestPage[]
  groups: ManifestGroup[]
}

export interface Manifest {
  versions: Record<string, VersionManifest>
}

const KINDS: PageKind[] = ['docs', 'internals']

export function readFrontmatter(source: string, file: string): Record<string, unknown> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(source)
  if (!m) throw new Error(`${file}: missing YAML frontmatter (--- … ---) at the top of the file`)
  const data = parseYaml(m[1])
  if (!data || typeof data !== 'object') throw new Error(`${file}: frontmatter is not a YAML mapping`)
  return data as Record<string, unknown>
}

function str(fm: Record<string, unknown>, key: string, file: string, required: boolean): string | undefined {
  const v = fm[key]
  if (v === undefined || v === null) {
    if (required) throw new Error(`${file}: frontmatter \`${key}\` is required`)
    return undefined
  }
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${file}: frontmatter \`${key}\` must be a non-empty string`)
  return v.trim()
}

const ALLOWED_KEYS = new Set(['title', 'nav', 'group', 'kind', 'order', 'eyebrow', 'description'])

export function loadManifest(siteRoot: string): Manifest {
  const contentDir = path.join(siteRoot, 'content')
  const versions: Record<string, VersionManifest> = {}
  for (const v of VERSIONS) {
    const dir = path.join(contentDir, v.id)
    let files: string[] = []
    try {
      if (statSync(dir).isDirectory()) files = readdirSync(dir).filter((f) => f.endsWith('.mdx'))
    } catch {
      files = []
    }
    const pages: ManifestPage[] = files.map((f) => {
      const rel = `content/${v.id}/${f}`
      const fm = readFrontmatter(readFileSync(path.join(dir, f), 'utf8'), rel)
      for (const k of Object.keys(fm)) if (!ALLOWED_KEYS.has(k)) throw new Error(`${rel}: unknown frontmatter key \`${k}\``)
      const slug = f === 'index.mdx' ? '' : f.slice(0, -4)
      if (slug && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error(`${rel}: file names must be kebab-case`)
      const title = str(fm, 'title', rel, true)!
      const group = str(fm, 'group', rel, true)!
      const kind = (str(fm, 'kind', rel, false) ?? 'docs') as PageKind
      if (!KINDS.includes(kind)) throw new Error(`${rel}: \`kind\` must be one of ${KINDS.join(', ')}`)
      const order = fm.order
      if (typeof order !== 'number' || !Number.isFinite(order)) throw new Error(`${rel}: frontmatter \`order\` must be a number`)
      return {
        version: v.id,
        slug,
        path: `/${v.id}/${slug}`,
        file: rel,
        title,
        nav: str(fm, 'nav', rel, false) ?? title,
        group,
        kind,
        order,
        eyebrow: str(fm, 'eyebrow', rel, false) ?? group,
        description: str(fm, 'description', rel, false) ?? null,
      }
    })
    pages.sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || a.order - b.order)
    const groups: ManifestGroup[] = []
    const seenOrder = new Map<string, string>()
    for (const p of pages) {
      const key = `${p.kind}:${p.order}`
      if (seenOrder.has(key)) throw new Error(`${p.file}: \`order: ${p.order}\` is also used by ${seenOrder.get(key)}`)
      seenOrder.set(key, p.file)
      const last = groups[groups.length - 1]
      if (last && last.title === p.group && last.kind === p.kind) last.pages.push(p.slug)
      else {
        if (groups.some((g) => g.title === p.group && g.kind === p.kind))
          throw new Error(`${p.file}: group "${p.group}" is split by another group; give its pages adjacent \`order\` values`)
        groups.push({ title: p.group, kind: p.kind, pages: [p.slug] })
      }
    }
    versions[v.id] = { id: v.id, pages, groups }
  }
  return { versions }
}

/** Every route path that has a page: `/next/quickstart`, `/v7/`, … (no base path). */
export function manifestPaths(manifest: Manifest): string[] {
  return Object.values(manifest.versions).flatMap((v) => v.pages.map((p) => p.path))
}

const VIRTUAL_ID = 'virtual:content-manifest'
const RESOLVED_ID = `\0${VIRTUAL_ID}`

/** Serves `virtual:content-manifest` and reloads the page when content files are added/removed/edited. */
export function contentManifestPlugin(siteRoot: string): Plugin {
  const contentDir = path.join(siteRoot, 'content')
  return {
    name: 'deco-docs:content-manifest',
    resolveId(id) {
      if (id === VIRTUAL_ID) return RESOLVED_ID
    },
    load(id) {
      if (id !== RESOLVED_ID) return
      const manifest = loadManifest(siteRoot)
      for (const v of Object.values(manifest.versions)) for (const p of v.pages) this.addWatchFile(path.join(siteRoot, p.file))
      return `export default ${JSON.stringify(manifest)};`
    },
    configureServer(server: ViteDevServer) {
      const onChange = (file: string) => {
        if (!file.startsWith(contentDir) || !file.endsWith('.mdx')) return
        for (const env of Object.values(server.environments)) {
          const mod = env.moduleGraph.getModuleById(RESOLVED_ID)
          if (mod) env.moduleGraph.invalidateModule(mod)
        }
        server.ws.send({ type: 'full-reload' })
      }
      server.watcher.add(contentDir)
      server.watcher.on('add', onChange)
      server.watcher.on('unlink', onChange)
      server.watcher.on('change', (file) => {
        // Body edits hot-reload through MDX; only frontmatter changes need the manifest rebuilt,
        // but telling them apart costs more than just invalidating.
        if (file.startsWith(contentDir) && file.endsWith('.mdx')) {
          for (const env of Object.values(server.environments)) {
            const mod = env.moduleGraph.getModuleById(RESOLVED_ID)
            if (mod) env.moduleGraph.invalidateModule(mod)
          }
        }
      })
    },
  }
}
