import type { ComponentProps } from 'react'
import { Icon } from '~/components/ui/Icon'

/**
 * The hover permalink at a heading's left edge. Shown while its heading is hovered or it has
 * focus; hidden below 900px and in print. Styled by `heading-anchor` (src/styles/components/docs.css),
 * also a hook: the Roadmap's link handler and the search index's exclude list look for it.
 * `not-prose`: no article link styling.
 */
export function HeadingAnchor({ id, label }: { id: string; label: string }) {
  return (
    <a
      className="heading-anchor not-prose"
      href={`#${id}`}
      aria-label={`Link to ${label}`}
    >
      <Icon name="link" className="size-3.5" />
    </a>
  )
}

/**
 * h2/h3 overrides: the heading keeps its text as its accessible name (aria-label, set at build
 * time) and gets a hover permalink. Ids come from build/rehype-docs.ts. Their type is the
 * article's (src/styles/prose.css), which the Roadmap's headings share.
 */
function anchor(id: string | undefined, label: string | undefined) {
  return id ? <HeadingAnchor id={id} label={label ?? id} /> : null
}

export function H2({ children, ...props }: ComponentProps<'h2'>) {
  return (
    <h2 {...props}>
      {children}
      {anchor(props.id, props['aria-label'])}
    </h2>
  )
}

export function H3({ children, ...props }: ComponentProps<'h3'>) {
  return (
    <h3 {...props}>
      {children}
      {anchor(props.id, props['aria-label'])}
    </h3>
  )
}

/** The page title. Focusable (tabIndex -1) so "Back to top" and route changes can move focus to it. */
export function H1(props: ComponentProps<'h1'>) {
  return <h1 tabIndex={-1} {...props} />
}
