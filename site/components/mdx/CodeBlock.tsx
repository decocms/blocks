import { useEffect, useRef, useState, type ComponentProps, type ReactNode, type RefObject } from 'react'
import { Icon } from '~/components/ui/Icon'
import { announce, copyText, toast } from '~/src/lib/ui'

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
// ".deco/schema.json, abridged" are a path with a note.
const PATH = /^([^\s,]*\/[^\s,]*|[^\s,]+\.[a-z]\w*)(?=$|[\s,])/i

type PreProps = ComponentProps<'pre'> & {
  'data-lang'?: string
  'data-title'?: string
  'data-cmd'?: boolean | string
  'data-url'?: boolean | string
  'data-diagram'?: boolean | string
}

export function CopyButton({ target, withLabel }: { target: RefObject<HTMLElement | null>; withLabel?: boolean }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1800)
    return () => clearTimeout(t)
  }, [copied])
  return (
    <button
      type="button"
      className={`copy-button${withLabel ? ' has-label' : ''}${copied ? ' copied' : ''}`}
      aria-label={copied ? 'Copied' : 'Copy code example'}
      onClick={async () => {
        const ok = await copyText((target.current?.textContent ?? '').replace(/\s+$/, ''))
        if (!ok) return toast('Select the code to copy it.')
        setCopied(true)
        announce('Copied to clipboard')
      }}
    >
      <Icon name="copy" />
      <Icon name="check" />
      {withLabel && <span className="copy-label">{copied ? 'Copied' : 'Copy'}</span>}
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
    <pre {...rest} ref={ref} className={[className, title ? 'has-file' : ''].filter(Boolean).join(' ') || undefined} data-lang={label} data-label={title || label} aria-label={ariaLabel} data-region-label={ariaLabel}>
      {children}
    </pre>
  )
  const panelClass = `code-panel${diagram ? ' is-diagram' : ''}`
  if (cmd) {
    return (
      <div className={`${panelClass} is-oneline is-cmd`}>
        {pre}
        <span className="code-lang" aria-hidden="true">
          {label}
        </span>
        <CopyButton target={ref} />
      </div>
    )
  }
  const path = title ? PATH.exec(title) : null
  const kind = !title ? 'is-lang' : path ? '' : 'is-desc'
  let name: ReactNode = title || label
  if (title && path && path[0].length < title.length)
    name = (
      <>
        {path[0]}
        <span className="cf-note">{title.slice(path[0].length)}</span>
      </>
    )
  const panel = (
    <div className={panelClass}>
      <div className={`code-head${kind ? ` ${kind}` : ''}`}>
        <Icon name={kind ? (label === 'Shell' ? 'terminal' : 'code') : 'file'} />
        <span className="code-file" aria-hidden="true">
          {name}
        </span>
        {title && (
          <span className="code-lang" aria-hidden="true">
            {label}
          </span>
        )}
        <CopyButton target={ref} withLabel />
      </div>
      {pre}
    </div>
  )
  if (!title) return panel
  return (
    <figure className="code-example">
      <figcaption>{title}</figcaption>
      {panel}
    </figure>
  )
}
