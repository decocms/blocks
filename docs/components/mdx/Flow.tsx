import { Children, Fragment, isValidElement, type CSSProperties, type ReactNode } from 'react'

/**
 * A left-to-right diagram of numbered steps (stacks vertically on phones). Arrows are drawn
 * between nodes automatically.
 *
 *   <Flow label="Authoring flow">
 *     <FlowNode title="Your TypeScript">Functions with typed inputs: UI and data fetchers alike</FlowNode>
 *     <FlowNode title="CLI → JSON Schema">`deco schema` writes `.deco/schema.gen.json`</FlowNode>
 *     <FlowNode title="Studio">Forms and previews for editors, built from the schema</FlowNode>
 *   </Flow>
 *
 * `title` may be JSX (`title={<code>load()</code>}`). Keep a node's text on the same line as its
 * tags so MDX doesn't wrap it in a paragraph.
 */
export function Flow({ label, children }: { label?: string; children: ReactNode }) {
  const nodes = Children.toArray(children).filter(isValidElement)
  const cols = nodes.flatMap((_, i) => (i ? ['1px', 'minmax(0, 1fr)'] : ['minmax(0, 1fr)'])).join(' ')
  return (
    <div
      // Numbered by a CSS counter (no extra DOM); one column with ↓ arrows below 768px. Right after a
      // <Small> caption it keeps the caption's 32px.
      className="my-7 grid grid-cols-(--flow-cols) overflow-hidden rounded-2xl border border-border bg-surface [counter-reset:flow] max-md:grid-cols-1 [[data-small]+&]:mt-8"
      aria-label={label}
      style={{ '--flow-cols': cols } as CSSProperties}
    >
      {nodes.map((node, i) => (
        <Fragment key={i}>
          {i > 0 && (
            <div
              className="relative z-0 flex items-center justify-center bg-hairline text-[0px] text-eyebrow before:absolute before:top-1/2 before:left-1/2 before:-z-1 before:size-6.5 before:-translate-x-1/2 before:-translate-y-1/2 before:rounded-full before:border before:border-border before:bg-surface before:content-[''] after:font-sans after:text-13 after:leading-none after:content-['→'] max-md:h-px max-md:after:content-['↓']"
              aria-hidden="true"
            >
              →
            </div>
          )}
          {node}
        </Fragment>
      ))}
    </div>
  )
}

export function FlowNode({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 px-5.5 pt-5.5 pb-6 [counter-increment:flow] before:mb-3.5 before:text-13 before:leading-4 before:text-eyebrow before:tabular-nums before:content-[counter(flow,decimal-leading-zero)] max-md:px-5 max-md:py-4.5 max-md:before:mb-2">
      <strong className="text-16 leading-5.5 font-medium tracking-snug text-fg">{title}</strong>
      {children != null && <small className="text-14 leading-5 text-muted-fg [&_code]:text-12">{children}</small>}
    </div>
  )
}
