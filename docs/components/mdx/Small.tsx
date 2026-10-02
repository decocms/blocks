import type { CSSProperties, ReactNode } from 'react'

/** The small muted line's classes (for markup that can't use <Small>). mt-8: it opens a new block. */
export const SMALL = 'mt-8 mb-4 text-14 leading-5.5 text-muted-fg'

/**
 * A small, muted line: diagram captions and labels above a <Flow> (the old `p.small.muted`).
 *
 *   <Small>Top: four route paths. Below: the trie built from them.</Small>
 *   <Small style={{ marginBottom: 6 }}>Request path · synchronous, never touches the network</Small>
 *
 * `data-small` lets a following <Flow> keep the caption's spacing.
 */
export function Small({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <p className={SMALL} style={style} data-small="">
      {children}
    </p>
  )
}

/** The eyebrow's classes: the small uppercase label above a heading. */
export const EYEBROW = 'm-0 mb-3.5 block font-sans leading-4.5 eyebrow-label'

/** The small uppercase label above a heading (the layout already renders one above each page's h1). */
export function Eyebrow({ children }: { children: ReactNode }) {
  return <p className={EYEBROW}>{children}</p>
}
