import { Children, isValidElement, type ReactNode } from 'react'
import { cx } from '~/src/lib/ui'
import { CodeBlock } from './CodeBlock'
import { Table } from './Table'

/**
 * A boxed note.
 *
 *   <Callout>**Status.** The API on these pages is proposed…</Callout>          info icon
 *   <Callout type="warning">**Don't** …</Callout>                               amber, warning icon
 *   <Callout type="preview">…</Callout>                                         lime "intro note" with a dot
 *
 * Inline content (all on the tag's line) is wrapped in one paragraph; put blank-line separated
 * paragraphs on their own lines for several.
 */
export function Callout({ type = 'note', children }: { type?: CalloutType; children: ReactNode }) {
  return <div className={calloutClass(type)}>{hasBlock(children) ? children : <p>{children}</p>}</div>
}

export type CalloutType = 'note' | 'warning' | 'preview'

/**
 * The callout box's classes, for markup that can't use <Callout> (the icon is a masked ::before).
 * Its paragraphs are 15px with no gap between them, whatever the article's prose says.
 */
export function calloutClass(type: CalloutType = 'note') {
  return cx(
    'relative my-7 rounded-box border py-4 pr-5.5 pl-[50px] max-sm:py-3.5 max-sm:pr-4 max-sm:pl-11',
    '[&_p]:m-0 [&_p]:text-15 [&_p]:leading-[25px]',
    "before:absolute before:content-['']",
    type === 'preview'
      ? // a lime dot instead of an icon
        'border-preview-border bg-preview-bg [&_p]:text-fg before:top-[23px] before:left-[23px] before:size-2.5 before:rounded-full before:bg-preview-dot before:shadow-[0_0_0_4px_var(--preview-dot-ring)] max-sm:before:top-[21px] max-sm:before:left-[19px]'
      : cx(
          '[&_p]:text-fg-body before:top-5 before:left-5 before:size-4 max-sm:before:top-[18px] max-sm:before:left-4 print:break-inside-avoid-page print:shadow-none',
          type === 'warning'
            ? 'border-warn-border bg-warn-bg before:bg-warn-icon before:[mask:var(--ico-warn)_center/16px_no-repeat]'
            : 'border-border bg-note-bg before:bg-eyebrow before:[mask:var(--ico-info)_center/16px_no-repeat]',
        ),
  )
}

const BLOCK_TAGS = new Set(['p', 'ul', 'ol', 'div', 'table', 'pre', 'figure', 'dl', 'blockquote', 'h2', 'h3', 'h4'])
const BLOCK_COMPONENTS = new Set<unknown>([CodeBlock, Table])

function hasBlock(children: ReactNode): boolean {
  return Children.toArray(children).some(
    (c) => isValidElement(c) && (typeof c.type === 'string' ? BLOCK_TAGS.has(c.type) : BLOCK_COMPONENTS.has(c.type)),
  )
}
