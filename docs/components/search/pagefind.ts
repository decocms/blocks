/**
 * The Pagefind client, loaded on demand from the built site (dist/client/pagefind/, written by
 * scripts/postbuild.ts). It only exists after `bun run build`; in `bun run dev` loading fails and
 * the dialog says so.
 *
 * Only the parts of Pagefind's JS API the dialog uses are typed here (pagefind 1.5).
 */

export interface PagefindAnchor {
  element: string
  id: string
  text: string
  location: number
}

export interface PagefindSubResult {
  title: string
  /** Base path included, with `#id` for a heading. */
  url: string
  /** Plain text with <mark> around matches (HTML-escaped). */
  excerpt: string
  anchor?: PagefindAnchor
  locations?: number[]
  weighted_locations?: { weight: number; balanced_score: number; location: number }[]
}

export interface PagefindData {
  url: string
  excerpt: string
  meta: Record<string, string>
  filters?: Record<string, string[]>
  sub_results: PagefindSubResult[]
}

export interface PagefindResult {
  id: string
  score: number
  data: () => Promise<PagefindData>
}

export interface PagefindSearch {
  results: PagefindResult[]
}

export type PagefindFilters = Record<string, string | string[] | { any?: string[]; all?: string[]; none?: string[]; not?: string[] }>

export interface Pagefind {
  options: (opts: { excerptLength?: number; baseUrl?: string; highlightParam?: string }) => Promise<void>
  init: () => Promise<void>
  search: (term: string, opts?: { filters?: PagefindFilters }) => Promise<PagefindSearch>
  preload: (term: string, opts?: { filters?: PagefindFilters }) => Promise<void>
}

let loading: Promise<Pagefind | null> | undefined

/** Loads and initialises Pagefind once; resolves to null where there's no index (dev). */
export function loadPagefind(): Promise<Pagefind | null> {
  loading ??= (async () => {
    try {
      const pf = (await import(/* @vite-ignore */ `${import.meta.env.BASE_URL}pagefind/pagefind.js`)) as Pagefind
      await pf.options({ excerptLength: 24 })
      await pf.init()
      return pf
    } catch {
      return null
    }
  })()
  return loading
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

/** Decodes the few HTML entities Pagefind writes into excerpts and titles. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

/**
 * Splits a Pagefind excerpt into text and marked runs, without ever setting it as HTML:
 * "a <mark>b</mark> c" -> [{ text: 'a ' }, { text: 'b', mark: true }, { text: ' c' }].
 */
export function excerptParts(excerpt: string): { text: string; mark?: boolean }[] {
  const out: { text: string; mark?: boolean }[] = []
  const re = /<mark>([\s\S]*?)<\/mark>/g
  let at = 0
  let m: RegExpExecArray | null
  const plain = (s: string) => decodeEntities(s.replace(/<[^>]*>/g, ''))
  while ((m = re.exec(excerpt))) {
    if (m.index > at) out.push({ text: plain(excerpt.slice(at, m.index)) })
    out.push({ text: plain(m[1]), mark: true })
    at = m.index + m[0].length
  }
  if (at < excerpt.length) out.push({ text: plain(excerpt.slice(at)) })
  // Highlight the word only: punctuation Pagefind keeps on a matched word ("preview).") goes outside.
  const trimmed: { text: string; mark?: boolean }[] = []
  for (const p of out) {
    if (!p.mark) {
      trimmed.push(p)
      continue
    }
    const m = /^([^\p{L}\p{N}]*)([\s\S]*?)([^\p{L}\p{N}]*)$/u.exec(p.text)!
    if (!m[2]) {
      trimmed.push({ text: p.text })
      continue
    }
    trimmed.push({ text: m[1] }, { text: m[2], mark: true }, { text: m[3] })
  }
  return trimmed.filter((p) => p.text)
}

/**
 * Tidies a sub-result's excerpt the way the old search showed them: Pagefind's excerpt window
 * often starts inside the section's heading ("it works. Preview is…" under "How it works"), so the
 * heading's tail is dropped; an excerpt that starts mid-sentence gets a leading "…".
 */
export function tidyExcerpt(excerpt: string, heading?: string): string {
  let out = excerpt.trimStart()
  const plainStart = decodeEntities(out.replace(/<[^>]*>/g, ''))
  const h = heading ? decodeEntities(heading).trim() : ''
  if (h) {
    // The longest tail of the heading (whole words) the excerpt starts with, plus Pagefind's ". ".
    const words = h.split(/\s+/)
    for (let i = 0; i < words.length; i++) {
      const tail = words.slice(i).join(' ')
      const re = new RegExp(`^${tail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[.:]?\\s+`, 'i')
      if (re.test(plainStart)) {
        out = stripPlainPrefix(out, plainStart.match(re)![0].length)
        return out
      }
    }
  }
  const first = decodeEntities(out.replace(/<[^>]*>/g, '')).trimStart()[0] ?? ''
  return /[\p{Lu}\p{N}`"“(<]/u.test(first) ? out : `…${out}`
}

/** Drops the first `n` characters of an excerpt's text, keeping its <mark> tags balanced. */
function stripPlainPrefix(excerpt: string, n: number): string {
  let i = 0
  let left = n
  let open = false
  while (i < excerpt.length && left > 0) {
    if (excerpt[i] === '<') {
      const end = excerpt.indexOf('>', i)
      const tag = excerpt.slice(i, end + 1)
      open = tag === '<mark>' ? true : tag === '</mark>' ? false : open
      i = end + 1
      continue
    }
    if (excerpt[i] === '&') {
      const end = excerpt.indexOf(';', i)
      i = end > i && end - i < 10 ? end + 1 : i + 1
    } else i++
    left--
  }
  const rest = excerpt.slice(i)
  return open ? `<mark>${rest}` : rest
}
