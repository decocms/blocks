/**
 * The site's rehype plugin for MDX pages. Runs at build time (and in dev), so the prerendered HTML
 * already has everything the old site added in the browser:
 *
 *  1. Heading ids (h1–h3) with the old slug algorithm, de-duplicated per page; an explicit `id`
 *     (written as JSX, `<h2 id="x">`) is kept. h2/h3 also get `aria-label` = their text, so the
 *     injected permalink isn't read as part of the name.
 *  2. `export const headings = [{ id, depth, text, html }]` (h2 and h3) for the "On this page" rail.
 *  3. A `<TocInline />` element after the h1 and its lede paragraph (the collapsible outline shown
 *     below 1200px), rendered by components/mdx/TocInline.tsx.
 *  4. Code: every fenced block is highlighted with Shiki (CSS-variable theme), and the fence meta
 *     is parsed: ```ts title="cms.ts". The <pre> gets data-* props that components/mdx/CodeBlock
 *     turns into the panel chrome (file header, language badge, copy button).
 *  5. Inline code: `is-short` (≤ 24 chars, never wraps) and, inside tables, `can-wrap` when the
 *     code has spaces (signatures may wrap on phones), as the old app.js did.
 */
import type { Element, ElementContent, Root, RootContent, Text } from 'hast'
import { toString } from 'hast-util-to-string'
import { toHtml } from 'hast-util-to-html'
import { visit, SKIP } from 'unist-util-visit'
import { valueToEstree } from 'estree-util-value-to-estree'
import { createHighlighter, type Highlighter, type ShikiTransformer } from 'shiki'
import { createSlugger } from './slugify.ts'
import { decoTheme } from './shiki-theme.ts'

export const LANGS = ['typescript', 'tsx', 'javascript', 'jsx', 'json', 'jsonc', 'bash', 'shellscript', 'yaml', 'html', 'css', 'diff'] as const
const ALIASES: Record<string, string> = { ts: 'typescript', mts: 'typescript', js: 'javascript', sh: 'bash', shell: 'bash', zsh: 'bash', yml: 'yaml', plaintext: 'text', txt: 'text' }

/**
 * YAML: a key that is also a YAML 1.1 boolean (`on:` in a GitHub Actions workflow) is scoped as a
 * boolean by the grammar, which can't see the colon. Color it as the key it is.
 */
const yamlBooleanKeys: ShikiTransformer = {
  name: 'deco:yaml-boolean-keys',
  tokens(lines) {
    if (this.options.lang !== 'yaml') return
    for (const line of lines)
      line.forEach((tok, i) => {
        if (/^(?:on|off|yes|no|y|n|true|false)$/i.test(tok.content) && line[i + 1]?.content.startsWith(':')) tok.color = 'var(--syn-property)'
      })
  },
}

let highlighter: Promise<Highlighter> | undefined
const getHighlighter = () => (highlighter ??= createHighlighter({ themes: [decoTheme], langs: [...LANGS] }))

export interface DocHeading {
  id: string
  depth: 2 | 3
  /** Plain text. */
  text: string
  /** Inner HTML (keeps <code>), for the rail and the inline outline. */
  html: string
}

/** Parses `title="cms.ts" foo bar=baz` into { title: 'cms.ts', foo: true, bar: 'baz' }. */
export function parseMeta(meta: string | undefined): Record<string, string | true> {
  const out: Record<string, string | true> = {}
  if (!meta) return out
  const re = /([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|(\S+)))?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(meta))) out[m[1]] = m[2] ?? m[3] ?? m[4] ?? true
  return out
}

const isEl = (n: unknown, tag?: string): n is Element =>
  !!n && (n as Element).type === 'element' && (!tag || (n as Element).tagName === tag)

function classList(el: Element): string[] {
  const c = el.properties?.className as unknown
  return Array.isArray(c) ? c.map(String) : typeof c === 'string' ? c.split(/\s+/) : []
}

function jsxFlow(name: string): RootContent {
  return { type: 'mdxJsxFlowElement', name, attributes: [], children: [] } as unknown as RootContent
}

export default function rehypeDocs() {
  return async (tree: Root) => {
    const slug = createSlugger()
    const headings: DocHeading[] = []

    // 0. Headings written as JSX (`<h2 id="publishing">Publishing</h2>`, to pin an id) become plain
    //    elements, so they get the same treatment (and the h2/h3 component overrides) as `## …`.
    visit(tree, (node, index, parent) => {
      const jsx = node as unknown as { type: string; name?: string; attributes?: { type: string; name: string; value: unknown }[]; children: ElementContent[] }
      if (jsx.type !== 'mdxJsxFlowElement' || !jsx.name || !/^h[1-3]$/.test(jsx.name) || !parent || typeof index !== 'number') return
      const properties: Record<string, string> = {}
      for (const a of jsx.attributes ?? []) {
        if (a.type !== 'mdxJsxAttribute' || typeof a.value !== 'string') return // dynamic props: leave as JSX
        properties[a.name === 'class' ? 'className' : a.name] = a.value
      }
      // Flow JSX wraps its text in a paragraph; a heading holds phrasing content.
      const kids = jsx.children.length === 1 && isEl(jsx.children[0], 'p') ? (jsx.children[0] as Element).children : jsx.children
      ;(parent.children as RootContent[])[index] = { type: 'element', tagName: jsx.name, properties, children: kids } as Element
    })

    // 1–2. Headings (explicit ids first, so generated ones never take them).
    visit(tree, 'element', (el) => {
      if (/^h[1-3]$/.test(el.tagName) && typeof el.properties?.id === 'string') slug('', el.properties.id)
    })
    visit(tree, 'element', (el) => {
      if (!/^h[1-3]$/.test(el.tagName)) return
      const text = toString(el).replace(/\s+/g, ' ').trim()
      const explicit = typeof el.properties?.id === 'string' ? el.properties.id : undefined
      const id = explicit ?? slug(text)
      el.properties = { ...el.properties, id }
      if (el.tagName !== 'h1') {
        el.properties.ariaLabel = text
        headings.push({ id, depth: el.tagName === 'h2' ? 2 : 3, text, html: toHtml(el.children as ElementContent[]) })
      }
    })

    // 3. <TocInline /> after the h1 (and its lede paragraph, if one follows).
    const top = tree.children
    const h1 = top.findIndex((n) => isEl(n, 'h1'))
    if (h1 >= 0) {
      let at = h1 + 1
      while (at < top.length && top[at].type === 'text' && !(top[at] as Text).value.trim()) at++
      const insertAt = isEl(top[at], 'p') ? at + 1 : h1 + 1
      top.splice(insertAt, 0, jsxFlow('TocInline'))
    }

    // 4. Code blocks.
    const hl = await getHighlighter()
    const loaded = new Set(hl.getLoadedLanguages())
    visit(tree, 'element', (pre, index, parent) => {
      if (pre.tagName !== 'pre') return
      const code = pre.children.find((c): c is Element => isEl(c, 'code'))
      if (!code) return
      const raw = toString(code).replace(/\n$/, '')
      const fromClass = classList(code).find((c) => c.startsWith('language-'))?.slice('language-'.length)
      let lang = fromClass ? (ALIASES[fromClass] ?? fromClass) : 'text'
      const meta = parseMeta((code.data as { meta?: string } | undefined)?.meta)
      const title = typeof meta.title === 'string' ? meta.title : undefined
      // A TypeScript block that contains JSX is TSX (the old site's rule).
      if (lang === 'typescript' && /<\/[A-Za-z][\w.]*>|<[A-Z][\w.]*(\s[^<>]*)?\/>|<>|<\/>/.test(raw)) lang = 'tsx'
      let children: ElementContent[] = [{ type: 'text', value: raw }]
      if (lang !== 'text' && loaded.has(lang)) {
        const out = hl.codeToHast(raw, { lang, theme: decoTheme.name!, transformers: [yamlBooleanKeys] })
        const hPre = out.children.find((c): c is Element => isEl(c, 'pre'))
        const hCode = hPre?.children.find((c): c is Element => isEl(c, 'code'))
        if (hCode) children = hCode.children
      } else if (lang !== 'text') {
        throw new Error(`Code block language "${lang}" isn't loaded; add it to LANGS in build/rehype-docs.ts`)
      }
      const props: Record<string, string | boolean> = { dataLang: lang }
      if (title) props.dataTitle = title
      const oneline = !raw.includes('\n')
      if (!title && lang === 'bash' && oneline && /^(npm|npx|pnpm|yarn|bun|bunx)\b/.test(raw)) props.dataCmd = true
      if (!title && lang === 'bash' && /^https?:\/\//.test(raw)) props.dataUrl = true
      if (raw.includes('│')) props.dataDiagram = true
      const newPre: Element = {
        type: 'element',
        tagName: 'pre',
        properties: props,
        children: [{ type: 'element', tagName: 'code', properties: { className: [`language-${lang}`] }, children }],
      }
      if (parent && typeof index === 'number') parent.children[index] = newPre
      return SKIP
    })

    // 5. Inline code classes.
    visit(tree, 'element', (el, _i, parent) => {
      if (el.tagName === 'pre') return SKIP
      if (el.tagName !== 'code' || isEl(parent, 'pre')) return
      const text = toString(el).trim()
      const cls = classList(el)
      if (text.length <= 24) cls.push('is-short')
      el.properties = { ...el.properties, className: cls.length ? cls : undefined }
    })
    visit(tree, 'element', (cell) => {
      if (cell.tagName !== 'td' && cell.tagName !== 'th') return
      visit(cell, 'element', (c) => {
        if (c.tagName === 'code' && /\s/.test(toString(c).trim())) c.properties = { ...c.properties, className: [...classList(c), 'can-wrap'] }
      })
    })

    // export const headings = [...]
    tree.children.unshift({
      type: 'mdxjsEsm',
      value: '',
      data: {
        estree: {
          type: 'Program',
          sourceType: 'module',
          body: [
            {
              type: 'ExportNamedDeclaration',
              specifiers: [],
              declaration: {
                type: 'VariableDeclaration',
                kind: 'const',
                declarations: [{ type: 'VariableDeclarator', id: { type: 'Identifier', name: 'headings' }, init: valueToEstree(headings) }],
              },
            },
          ],
        },
      },
    } as unknown as RootContent)
  }
}
