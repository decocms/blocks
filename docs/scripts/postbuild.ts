/**
 * Runs after `vite build` (which prerenders every page into dist/client):
 *
 *  0. 404.html: GitHub Pages serves it for any unknown path. It's rendered by the built server
 *     handler for a URL no route matches, so it is exactly the root's not-found state, which is
 *     what the browser hydrates it as (prerendering a /404 route would hydrate with a mismatch).
 *  1. Link check: every internal link (href starting with the base path) must reach a page, and
 *     its #fragment, if any, an id on that page. All failures are listed; the build fails on any.
 *     DOCS_LINKS=warn reports them without failing (handy while pages are still being ported).
 *  2. Size budget: the JS every page loads (the chunks all pages reference) stays under a gzip
 *     budget, and carries none of the Roadmap's data (which belongs in the Roadmap's route chunk);
 *     no page's prerendered HTML goes over its own gzip budget (utility classes live in it).
 *  3. Search index: Pagefind indexes the prerendered HTML (only elements marked
 *     data-pagefind-body, i.e. doc articles and whatever else opts in) and writes
 *     dist/client/pagefind/. Result URLs are the real routes (/next/quickstart, not
 *     next/quickstart.html); the Pagefind client prepends the base path it's served under.
 *  4. Redirects: a removed or merged page keeps its old URL working through a small page that
 *     sends the reader on (GitHub Pages has no server-side redirects). Written last, so the link
 *     check, size budget and search index never see them; the build fails if a target is missing.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import path from 'node:path'
import * as pagefind from 'pagefind'
import { BASE, OUT_DIR, SITE_ROOT, fileFor, htmlFiles, redirectFor, routeOf } from './site-files.ts'

// ---------------------------------------------------------------- 0. 404.html
{
  const server = (await import(path.join(SITE_ROOT, 'dist', 'server', 'server.js'))) as { default: { fetch: (r: Request) => Promise<Response> } }
  const res = await server.default.fetch(new Request(`http://localhost${BASE}__not-found__`))
  if (res.status !== 404) throw new Error(`404 page: expected status 404, got ${res.status}`)
  writeFileSync(path.join(OUT_DIR, '404.html'), await res.text())
}

const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')

const files = htmlFiles()
if (!files.length) throw new Error(`No HTML in ${OUT_DIR}; run vite build first`)

// ---------------------------------------------------------------- 1. links
const idsByFile = new Map<string, Set<string>>()
const htmlByFile = new Map<string, string>()
for (const f of files) {
  const html = readFileSync(f, 'utf8')
  htmlByFile.set(f, html)
  idsByFile.set(f, new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => decode(m[1]))))
}

const broken: string[] = []
for (const [file, html] of htmlByFile) {
  const from = BASE.replace(/\/$/, '') + routeOf(file)
  for (const m of html.matchAll(/<a\b[^>]*?\shref="([^"]*)"/g)) {
    const href = decode(m[1])
    if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) continue
    let target = file
    let frag = ''
    if (href.startsWith('#')) frag = href.slice(1)
    else if (href.startsWith('/')) {
      if (!href.startsWith(BASE)) {
        broken.push(`${from}: ${href} (outside the base path ${BASE})`)
        continue
      }
      const [p, h = ''] = href.slice(BASE.length - 1).split('#')
      // A directory without its slash: Pages redirects to the slash form, so follow it.
      const redirect = redirectFor(p)
      const f = fileFor(redirect ?? p)
      if (!f || path.basename(f) === '404.html') {
        broken.push(`${from}: ${href} (no such page)`)
        continue
      }
      target = f
      frag = h
    } else continue // relative links aren't used by the app
    if (frag && frag !== 'main' && !idsByFile.get(target)?.has(decodeURIComponent(frag))) broken.push(`${from}: ${href} (no #${frag} on that page)`)
  }
}
const uniq = [...new Set(broken)]
if (uniq.length) {
  const strict = process.env.DOCS_LINKS !== 'warn'
  console[strict ? 'error' : 'warn'](`\n${uniq.length} broken link${uniq.length === 1 ? '' : 's'}:\n${uniq.map((b) => `  - ${b}`).join('\n')}\n`)
  if (strict) process.exit(1)
} else console.log(`links: ok (${files.length} pages)`)

// ---------------------------------------------------------------- 2. size budget
{
  const BUDGET_GZIP = 160 * 1024
  // The heaviest page (/roadmap/features) is ~40KB gzipped; repeated markup that needs a long
  // class string belongs in a named class (src/styles/components/docs.css), not inline.
  const HTML_BUDGET_GZIP = 48 * 1024
  // Strings only the Roadmap's data and views contain.
  const ROADMAP_MARKERS = ['No feature matches both filters', 'Studio builds its forms']
  const scriptsOf = (html: string) =>
    new Set([...html.matchAll(/<(?:script|link)\b[^>]*?\s(?:src|href)="([^"]+\.js)"/g)].map((m) => decode(m[1])))
  const pages = [...htmlByFile].filter(([f]) => path.basename(f) !== '404.html').map(([, html]) => scriptsOf(html))
  const shared = [...pages[0]].filter((src) => pages.every((p) => p.has(src)))
  let gz = 0
  const problems: string[] = []
  for (const src of shared) {
    const f = path.join(OUT_DIR, src.slice(BASE.length))
    if (!f.startsWith(OUT_DIR) || !statSync(f, { throwIfNoEntry: false })?.isFile()) continue
    const code = readFileSync(f)
    gz += gzipSync(code).length
    const text = code.toString('utf8')
    for (const m of ROADMAP_MARKERS) if (text.includes(m)) problems.push(`${src} (loaded by every page) contains Roadmap data ("${m}")`)
  }
  if (!shared.length) problems.push('found no script every page loads (did the HTML change shape?)')
  if (gz > BUDGET_GZIP) problems.push(`the JS every page loads is ${(gz / 1024).toFixed(0)}KB gzipped, over the ${BUDGET_GZIP / 1024}KB budget`)
  let heaviest = { file: '', gz: 0 }
  for (const [file, html] of htmlByFile) {
    const size = gzipSync(html).length
    if (size > heaviest.gz) heaviest = { file: path.relative(OUT_DIR, file), gz: size }
    if (size > HTML_BUDGET_GZIP)
      problems.push(`${path.relative(OUT_DIR, file)} is ${(size / 1024).toFixed(0)}KB gzipped, over the ${HTML_BUDGET_GZIP / 1024}KB page budget`)
  }
  if (problems.length) {
    console.error(`\nsize: ${problems.join('\n  ')}\n`)
    process.exit(1)
  }
  console.log(
    `size: ok (${shared.length} shared scripts, ${(gz / 1024).toFixed(0)}KB gzipped; heaviest page ${heaviest.file}, ${(heaviest.gz / 1024).toFixed(0)}KB gzipped)`,
  )
}

// ---------------------------------------------------------------- 3. search index
// Index what the reader sees in the content, not the chrome around it: code-panel headers and copy
// buttons, heading permalinks, the inline "On this page" outline (it repeats the headings), and
// the Roadmap's metadata/chips/counts (the old app.js search left out the same things). The Roadmap
// marks those with data-pagefind-ignore in its markup (components/roadmap/SectionViews.tsx).
const EXCLUDE = ['.toc-inline', '.code-head', '.copy-button', '.code-lang', '.heading-anchor']
const { index, errors } = await pagefind.createIndex({ forceLanguage: 'en', excludeSelectors: EXCLUDE })
if (!index) throw new Error(`pagefind: ${errors.join(', ')}`)
let indexed = 0
for (const [file, content] of htmlByFile) {
  if (path.basename(file) === '404.html') continue
  // Without the base path: Pagefind's client prepends its own location's parent ("/blocks/").
  const url = routeOf(file)
  const res = await index.addHTMLFile({ url, content })
  if (res.errors.length) throw new Error(`pagefind ${url}: ${res.errors.join(', ')}`)
  indexed++
}
const written = await index.writeFiles({ outputPath: path.join(OUT_DIR, 'pagefind') })
if (written.errors.length) throw new Error(`pagefind: ${written.errors.join(', ')}`)
await pagefind.close()
console.log(`search: indexed ${indexed} pages -> ${path.relative(process.cwd(), path.join(OUT_DIR, 'pagefind'))}/`)

// ---------------------------------------------------------------- 4. redirects
// Old path -> new path, both without the base path, in the form pages are served at
// (`/next/x`, written as next/x.html; a path ending in `/` is written as <path>/index.html).
const REDIRECTS: Record<string, string> = {
  '/next/caching-and-observability': '/next/caching',
}
for (const [from, to] of Object.entries(REDIRECTS)) {
  if (!fileFor(to)) throw new Error(`redirect ${from} -> ${to}: no page at ${to}`)
  if (fileFor(from)) throw new Error(`redirect ${from} -> ${to}: a page still exists at ${from}`)
  const href = BASE.replace(/\/$/, '') + to
  const out = from.endsWith('/') ? path.join(OUT_DIR, from, 'index.html') : path.join(OUT_DIR, `${from}.html`)
  mkdirSync(path.dirname(out), { recursive: true })
  writeFileSync(
    out,
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Moved</title><link rel="canonical" href="${href}"><meta name="robots" content="noindex"><meta http-equiv="refresh" content="0; url=${href}"><script>location.replace(${JSON.stringify(href)} + location.hash)</script></head><body><p>This page moved to <a href="${href}">${href}</a>.</p></body></html>`,
  )
}
console.log(`redirects: ${Object.keys(REDIRECTS).length} written`)
