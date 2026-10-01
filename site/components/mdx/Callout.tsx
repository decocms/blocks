import { Children, isValidElement, type ReactNode } from 'react'
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
export function Callout({ type = 'note', children }: { type?: 'note' | 'warning' | 'preview'; children: ReactNode }) {
  const cls = type === 'warning' ? 'callout warning' : type === 'preview' ? 'intro-note' : 'callout'
  return <div className={cls}>{hasBlock(children) ? children : <p>{children}</p>}</div>
}

const BLOCK_TAGS = new Set(['p', 'ul', 'ol', 'div', 'table', 'pre', 'figure', 'dl', 'blockquote', 'h2', 'h3', 'h4'])
const BLOCK_COMPONENTS = new Set<unknown>([CodeBlock, Table])

function hasBlock(children: ReactNode): boolean {
  return Children.toArray(children).some(
    (c) => isValidElement(c) && (typeof c.type === 'string' ? BLOCK_TAGS.has(c.type) : BLOCK_COMPONENTS.has(c.type)),
  )
}
