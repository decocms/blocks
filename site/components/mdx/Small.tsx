import type { CSSProperties, ReactNode } from 'react'

/**
 * A small, muted line: diagram captions and labels above a <Flow> (the old `p.small.muted`).
 *
 *   <Small>Top: four route paths. Below: the trie built from them.</Small>
 *   <Small style={{ marginBottom: 6 }}>Request path · synchronous, never touches the network</Small>
 */
export function Small({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <p className="small muted" style={style}>
      {children}
    </p>
  )
}

/** The small uppercase label above a heading (the layout already renders one above each page's h1). */
export function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="eyebrow">{children}</p>
}
