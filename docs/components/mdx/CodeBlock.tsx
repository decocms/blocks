import { useEffect, useRef, useState, type ComponentProps, type ReactNode, type RefObject } from 'react'
import { Icon } from '~/components/ui/Icon'
import { announce, copyText, cx, toast } from '~/src/lib/ui'

/**
 * A highlighted code block: the panel with its header (file name or language), language badge and
 * Copy button. You don't use it directly — every fenced block in MDX renders through it (it's the
 * `pre` override), with the props build/rehype-docs.ts puts on the <pre>:
 *
 *   ```ts title="cms.ts"           -> header "cms.ts" (mono, file icon) + "TypeScript" badge
 *   ```tsx title="blocks.tsx (Next.js)"   path in mono, the note after it in text
 *   ```json title="A plain request handler"  a description, not a path: plain text header
 *   ```bash                        -> header "SHELL" (language only), no badge
 *   ```bash   (one line: npm/npx/pnpm/yarn/bun …)  -> compact "$ command" pill
 *   ```text   (contains box-drawing │)            -> diagram line-height
 */
export const LANG_LABELS: Record<string, string> = {
  typescript: 'TypeScript',
  tsx: 'TSX',
  javascript: 'JavaScript',
  jsx: 'JSX',
  json: 'JSON',
  jsonc: 'JSON',
  bash: 'Shell',
  shellscript: 'Shell',
  yaml: 'YAML',
  html: 'HTML',
  css: 'CSS',
  diff: 'Diff',
  text: 'Text',
}

// "cms.ts" is a path; "A plain request handler" describes the block; "blocks.tsx (Next.js)" and
// ".deco/schema.gen.json, abridged" are a path with a note.
const PATH = /^([^\s,]*\/[^\s,]*|[^\s,]+\.[a-z]\w*)(?=$|[\s,])/i

type PreProps = ComponentProps<'pre'> & {
  'data-lang'?: string
  'data-title'?: string
  'data-cmd'?: boolean | string
  'data-url'?: boolean | string
  'data-diagram'?: boolean | string
}

export function CopyButton({ target, withLabel, className }: { target: RefObject<HTMLElement | null>; withLabel?: boolean; className?: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1800)
    return () => clearTimeout(t)
  }, [copied])
  return (
    <button
      type="button"
      // `copy-button`: styles in src/styles/components/docs.css (also a hook: the search index skips it).
      className={cx(
        className,
        'copy-button',
        withLabel ? 'pr-3 pl-2.5 max-xs:px-2' : 'px-2',
        copied ? 'border-transparent bg-tint text-tint-fg' : 'border-transparent bg-transparent text-muted-fg hover:border-code-border hover:bg-surface hover:text-fg',
      )}
      aria-label={copied ? 'Copied' : 'Copy code example'}
      onClick={async () => {
        const ok = await copyText((target.current?.textContent ?? '').replace(/\s+$/, ''))
        if (!ok) return toast('Select the code to copy it.')
        setCopied(true)
        announce('Copied to clipboard')
      }}
    >
      <Icon name="copy" className={cx('size-3.5', copied && 'hidden')} />
      <Icon name="check" className={cx('size-3.5', !copied && 'hidden')} />
      {withLabel && <span className="max-xs:hidden">{copied ? 'Copied' : 'Copy'}</span>}
    </button>
  )
}

/** Tab stop + named region only when the code scrolls; edge fades where it continues. */
function useScrollHints(ref: RefObject<HTMLPreElement | null>) {
  useEffect(() => {
    const pre = ref.current
    if (!pre) return
    const fade = () => {
      const x = pre.scrollLeft
      const maxX = pre.scrollWidth - pre.clientWidth
      const maxY = pre.scrollHeight - pre.clientHeight
      pre.classList.toggle('fade-l', x > 1)
      pre.classList.toggle('fade-r', maxX > 1 && x < maxX - 1)
      pre.classList.toggle('fade-b', maxY > 1 && pre.scrollTop < maxY - 1)
    }
    const fit = () => {
      if (!pre.offsetParent) return
      const scrolls = pre.scrollWidth > pre.clientWidth + 1 || pre.scrollHeight > pre.clientHeight + 1
      if (scrolls) {
        pre.tabIndex = 0
        pre.setAttribute('role', 'region')
        // Two scrolling blocks with the same file name (two "checkout.ts" panes) would be two
        // regions with one name: number them ("checkout.ts, 2 of 2").
        const base = pre.dataset.regionLabel ?? ''
        const same = [...document.querySelectorAll<HTMLPreElement>('pre[data-region-label]')].filter((p) => p.dataset.regionLabel === base)
        pre.setAttribute('aria-label', same.length > 1 ? `${base}, ${same.indexOf(pre) + 1} of ${same.length}` : base)
      } else {
        pre.removeAttribute('tabindex')
        pre.removeAttribute('role')
      }
      fade()
    }
    let raf = 0
    const onScroll = () => {
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0
          fade()
        })
    }
    fit()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fit) : null
    ro?.observe(pre)
    pre.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      ro?.disconnect()
      pre.removeEventListener('scroll', onScroll)
      cancelAnimationFrame(raf)
    }
  }, [ref])
}

/**
 * The panel: bordered box; inside a <figure> (titled blocks) the figure carries the margin. No
 * radius here: cx() only joins strings, so each use picks one (rounded-box or rounded-full) rather
 * than overriding a shared one.
 */
const PANEL = 'relative overflow-hidden border border-code-border bg-code-bg print:break-inside-avoid-page print:shadow-none'

/** The scrolling <pre>: `code-pre` (src/styles/components/docs.css) carries its scroll-fade masks. */
const PRE = 'code-pre'

/** The one-line "$ command" pill: the prompt is a ::before on the code, outside the selection. */
const PRE_CMD = "min-w-0 flex-1 px-5.5 py-[13px] [scrollbar-width:none] [&_code]:before:mr-3 [&_code]:before:font-medium [&_code]:before:text-eyebrow [&_code]:before:select-none [&_code]:before:content-['$']"

export function CodeBlock(props: PreProps) {
  const {
    'data-lang': lang = 'text',
    'data-title': title,
    'data-cmd': cmd,
    'data-url': isUrl,
    'data-diagram': diagram,
    children,
    className,
    ...rest
  } = props
  const ref = useRef<HTMLPreElement>(null)
  useScrollHints(ref)
  const label = isUrl ? 'URL' : (LANG_LABELS[lang] ?? lang)
  const ariaLabel = title || (label === 'URL' ? 'URL' : `${label} code`)
  const pre = (
    <pre
      {...rest}
      ref={ref}
      className={cx(
        className,
        PRE,
        cmd ? PRE_CMD : 'px-5.5 py-4.5 max-sm:px-4 max-sm:py-3.5',
        diagram ? 'leading-[1.3]' : 'max-sm:leading-[21px] print:leading-[1.5]',
      )}
      data-lang={label}
      data-label={title || label}
      aria-label={ariaLabel}
      data-region-label={ariaLabel}
    >
      {children}
    </pre>
  )
  // `code-lang` and `code-head`: styles in src/styles/components/docs.css (also hooks: the search index skips them).
  const badge = (
    <span className={cx('code-lang', cmd && 'mr-1')} aria-hidden="true">
      {label}
    </span>
  )
  if (cmd) {
    return (
      <div className={cx(PANEL, 'my-7 flex items-center rounded-full')}>
        {pre}
        {badge}
        <CopyButton target={ref} className="mr-[7px]" />
      </div>
    )
  }
  const path = title ? PATH.exec(title) : null
  const kind = !title ? 'lang' : path ? 'path' : 'desc'
  let name: ReactNode = title || label
  if (title && path && path[0].length < title.length)
    name = (
      <>
        {path[0]}
        <span className="font-sans text-13 tracking-ui text-muted-fg">{title.slice(path[0].length)}</span>
      </>
    )
  const panel = (
    <div className={cx(PANEL, 'rounded-box', title ? 'my-0' : 'my-7')}>
      <div className="code-head">
        <Icon name={kind !== 'path' ? (label === 'Shell' ? 'terminal' : 'code') : 'file'} className="size-3.5 text-eyebrow" />
        <span
          className={cx(
            'min-w-0 flex-1 truncate',
            kind === 'lang' ? 'font-sans eyebrow-label' : 'text-fg',
            kind === 'desc' && 'font-sans text-13.5 tracking-ui',
          )}
          aria-hidden="true"
        >
          {name}
        </span>
        {title && badge}
        <CopyButton target={ref} withLabel />
      </div>
      {pre}
    </div>
  )
  if (!title) return panel
  return (
    <figure className="my-7 min-w-0">
      <figcaption className="sr-only">{title}</figcaption>
      {panel}
    </figure>
  )
}
