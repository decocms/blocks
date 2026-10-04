/**
 * Shared helpers for the post-build scripts: where the static site is, how a URL maps to a file
 * (the same lookup and trailing-slash redirect GitHub Pages does), and the base path.
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const SITE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** What `vite build` writes (TanStack Start's client output). Deploy this folder. */
export const OUT_DIR = path.join(SITE_ROOT, 'dist', 'client')

/** "/blocks/" or "/", the same normalisation as vite.config.ts. */
export const BASE = `/${(process.env.BASE_PATH ?? '/').replace(/^\/+|\/+$/g, '')}/`.replace(/^\/\/$/, '/')

export function htmlFiles(dir = OUT_DIR): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) {
      if (name !== 'assets' && name !== 'pagefind') out.push(...htmlFiles(p))
    } else if (name.endsWith('.html')) out.push(p)
  }
  return out
}

/** dist/client/next/quickstart.html -> "/next/quickstart"; v7/index.html -> "/v7/"; index.html -> "/" (no base). */
export function routeOf(file: string): string {
  const rel = path.relative(OUT_DIR, file).split(path.sep).join('/')
  if (rel === 'index.html') return '/'
  if (rel.endsWith('/index.html')) return `/${rel.slice(0, -'index.html'.length)}`
  return `/${rel.slice(0, -'.html'.length)}`
}

const isFile = (rel: string) => {
  const p = path.join(OUT_DIR, rel)
  return p.startsWith(OUT_DIR) && existsSync(p) && statSync(p).isFile() ? p : undefined
}
const isDir = (rel: string) => {
  const p = path.join(OUT_DIR, rel)
  return p.startsWith(OUT_DIR) && existsSync(p) && statSync(p).isDirectory()
}
const cleanPath = (sitePath: string) => decodeURIComponent(sitePath.split(/[?#]/)[0]).replace(/^\/+/, '')

/**
 * A site path (without base) -> the file that serves it, the way GitHub Pages looks it up:
 * `/x/` -> x/index.html only; `/x` -> x, then x.html. Undefined if Pages would 404 (or redirect:
 * see `redirectFor`).
 */
export function fileFor(sitePath: string): string | undefined {
  const clean = cleanPath(sitePath)
  if (clean === '' || clean.endsWith('/')) return isFile(`${clean}index.html`)
  return isFile(clean) ?? isFile(`${clean}.html`)
}

/**
 * The trailing-slash redirect GitHub Pages does (301): `/x` with no x or x.html, but a directory x
 * holding index.html, -> "/x/" (without base). Undefined otherwise.
 */
export function redirectFor(sitePath: string): string | undefined {
  const clean = cleanPath(sitePath)
  if (clean === '' || clean.endsWith('/') || fileFor(sitePath)) return undefined
  return isDir(clean) && isFile(`${clean}/index.html`) ? `/${clean}/` : undefined
}
