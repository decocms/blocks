/**
 * Serves dist/client the way GitHub Pages does: under the base path, `/x` -> x or x.html, `/x/` ->
 * x/index.html, `/x` -> 301 `/x/` for a directory, and 404.html (status 404) for anything else. `bun run preview`, then open the URL.
 * PORT=… to change the port (default 4173).
 */
import { existsSync } from 'node:fs'
import { BASE, OUT_DIR, fileFor, redirectFor } from './site-files.ts'

if (!existsSync(OUT_DIR)) {
  console.error(`${OUT_DIR} doesn't exist; run \`bun run build\` first`)
  process.exit(1)
}

const port = Number(process.env.PORT ?? 4173)
const server = Bun.serve({
  port,
  fetch(req) {
    const url = new URL(req.url)
    if (BASE !== '/' && (url.pathname === BASE.slice(0, -1))) return Response.redirect(`${BASE}${url.search}`, 301)
    if (!url.pathname.startsWith(BASE)) return new Response('Not found (outside the base path)', { status: 404 })
    const sitePath = url.pathname.slice(BASE.length - 1)
    const file = fileFor(sitePath)
    if (file) return new Response(Bun.file(file))
    const redirect = redirectFor(sitePath)
    if (redirect) return Response.redirect(`${BASE.slice(0, -1)}${redirect}${url.search}`, 301)
    const notFound = fileFor('/404.html')
    return notFound ? new Response(Bun.file(notFound), { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } }) : new Response('Not found', { status: 404 })
  },
})
console.log(`Serving ${OUT_DIR} at http://localhost:${server.port}${BASE}`)
