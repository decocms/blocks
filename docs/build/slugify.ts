/**
 * Heading ids. Same algorithm as the old single-page site (its page script), so an old anchor such as
 * `#releases--publishing` maps to `/next/releases#publishing` by dropping the
 * `<section id>--` prefix.
 */
export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'section'
  )
}

/** Returns a slugger that de-duplicates within one page: `a`, `a-2`, `a-3`… */
export function createSlugger() {
  const seen = new Set<string>()
  return (text: string, explicit?: string) => {
    const base = explicit || slugify(text)
    let id = base
    let n = 2
    while (seen.has(id)) id = `${base}-${n++}`
    seen.add(id)
    return id
  }
}
