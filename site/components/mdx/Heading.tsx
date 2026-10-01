import type { ComponentProps } from 'react'
import { Icon } from '~/components/ui/Icon'

/**
 * h2/h3 overrides: the heading keeps its text as its accessible name (aria-label, set at build
 * time) and gets a hover permalink. Ids come from build/rehype-docs.ts.
 */
function anchor(id: string | undefined, label: string | undefined) {
  if (!id) return null
  return (
    <a className="heading-anchor" href={`#${id}`} aria-label={`Link to ${label ?? id}`}>
      <Icon name="link" />
    </a>
  )
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
